/**
 * Workspace ownership for auto-research branches.
 *
 * Two interchangeable backends implement the same small contract:
 *
 * - LayerFS: fork copy-on-write branches, mount each branch, commit verified
 *   states, and unmount with `discard` when a branch is rejected.
 * - Snapshot: content-addressed, full-copy branches in the run directory when
 *   no LayerFS project is bound.
 *
 * The module also owns the workspace inventory (the exact bytes an evaluation
 * is allowed to inspect) and the retained / restored completed-state objects
 * used by cooperative cohorts.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Harness and provider state that never enters an inventory or a branch. */
export const OMIT = new Set([
  '.auto-research-methods',
  '.method-evaluation',
  '.codex',
  '.claude',
  '.aws',
  '.ssh',
  '.azure',
  '.config',
  '.env',
  '.netrc',
  '.npmrc',
  '.git-credentials',
])

const SHARED_CONTEXT = 'SHARED_CONTEXT'
const ENV_FILE = /^\.env\./

/** @returns the lowercase hexadecimal SHA-256 of `data`. */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/** @returns the SHA-256 of one file, streamed in 1 MiB blocks. */
export async function digestFile(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', block => hash.update(block))
    stream.on('end', resolvePromise)
  })
  return hash.digest('hex')
}

/** Deterministic JSON (sorted object keys at every depth). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** @returns the SHA-256 of the canonical JSON encoding of `value`. */
export function jsonDigest(value) {
  return sha256(canonicalJson(value))
}

/** Deep JSON equality through canonical encoding. */
export function jsonEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b)
}

/** Whether `target` is `root` or strictly inside it. */
export function isContained(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** @returns the path relative to `root`, using POSIX separators. */
export function relativePosix(root, target) {
  return relative(root, target).split(sep).join('/')
}

function omitDirectory(parentName, name) {
  if (OMIT.has(name)) return true
  return parentName === SHARED_CONTEXT && name.startsWith('methods-')
}

function omitFile(name) {
  return OMIT.has(name) || ENV_FILE.test(name)
}

/**
 * Snapshot inventory: relative POSIX path -> SHA-256 for every regular,
 * non-omitted file. Symlinks and non-regular entries are rejected instead of
 * being followed, so a snapshot never captures bytes outside the workspace.
 * @param {string} root
 * @returns {Promise<Record<string, string>>}
 */
export async function inventory(root) {
  const result = {}
  async function walk(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error('Snapshot requires materializing symlinks first: ' + full)
      }
      if (entry.isDirectory()) {
        if (omitDirectory(directory.split(sep).at(-1), entry.name)) continue
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        if (omitFile(entry.name)) continue
        result[relativePosix(root, full)] = await digestFile(full)
        continue
      }
      throw new Error('Non-regular workspace entry: ' + full)
    }
  }
  await walk(root)
  return result
}

/** @returns total regular-file bytes represented by `files` under `root`. */
export async function inventoryBytes(root, files) {
  let total = 0
  for (const name of Object.keys(files)) {
    const stat = await fsp.lstat(join(root, name))
    total += stat.size
  }
  return total
}

/** @returns available bytes of the filesystem holding `path` (or its nearest parent). */
export async function freeBytes(path) {
  let cursor = resolve(path)
  while (true) {
    try {
      const stat = await fsp.statfs(cursor)
      return Number(stat.bavail) * Number(stat.bsize)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      cursor = parent
    }
  }
}

function shouldCopy(sourceRoot, candidate) {
  const rel = relative(sourceRoot, candidate)
  if (rel === '') return true
  const parts = rel.split(sep)
  const name = parts.at(-1)
  const parent = parts.length > 1 ? parts.at(-2) : sourceRoot.split(sep).at(-1)
  if (OMIT.has(name)) return false
  if (ENV_FILE.test(name)) return false
  if (parent === SHARED_CONTEXT && name.startsWith('methods-')) return false
  return true
}

async function copyTree(sourceRoot, destinationRoot) {
  async function walk(source, destination) {
    await fsp.mkdir(destination, { recursive: true })
    const entries = await fsp.readdir(source, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const from = join(source, entry.name)
      if (!shouldCopy(sourceRoot, from)) continue
      const to = join(destination, entry.name)
      if (entry.isSymbolicLink()) {
        throw new Error('Snapshot requires materializing symlinks first: ' + from)
      }
      if (entry.isDirectory()) {
        await walk(from, to)
        continue
      }
      if (!entry.isFile()) throw new Error('Non-regular workspace entry: ' + from)
      await fsp.copyFile(from, to)
      const stat = await fsp.lstat(from)
      await fsp.chmod(to, stat.mode & 0o777)
    }
  }
  await walk(resolve(sourceRoot), resolve(destinationRoot))
}

/**
 * Copy `source` into a new `destination`, verifying that no byte changed during
 * the copy. An existing destination is never overwritten.
 * @param {string} source
 * @param {string} destination
 * @returns {Promise<Record<string, string>>} the verified inventory
 */
export async function snapshot(source, destination) {
  try {
    await fsp.lstat(destination)
    throw new Error('Existing branch is preserved: ' + destination)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const before = await inventory(source)
  const required = await inventoryBytes(source, before)
  const free = await freeBytes(dirname(destination))
  if (required >= free) {
    throw new Error('Insufficient space for an independent branch; existing research preserved')
  }
  await fsp.mkdir(dirname(destination), { recursive: true })
  await copyTree(source, destination)
  const after = await inventory(destination)
  const sourceAfter = await inventory(source)
  if (!jsonEqual(before, after) || !jsonEqual(before, sourceAfter)) {
    throw new Error('Workspace changed during snapshot; branch preserved, not launched')
  }
  return before
}

/** Merge `source` into an existing directory (used for a LayerFS baseline). */
export async function mergeTree(source, destination) {
  const before = await inventory(source)
  await copyTree(source, destination)
  return before
}

/** Write JSON through a temporary sibling and an atomic rename. */
export async function writeJsonAtomic(path, value) {
  await fsp.mkdir(dirname(path), { recursive: true })
  const temporary = path + '.new'
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
  await fsp.rename(temporary, path)
}

/** Exclude live handles from a row before it is serialized. */
export function publicRow(row) {
  const { _state, _ownsState, ...rest } = row
  return rest
}

async function ensureNoSymlink(root, parts) {
  let cursor = root
  for (const part of parts) {
    cursor = join(cursor, part)
    let stat
    try {
      stat = await fsp.lstat(cursor)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('Completed checkpoint path may not traverse symlinks')
  }
}

/**
 * Store every distinct completed file once in `checkpoint-objects` and record a
 * checkpoint manifest for later restoration.
 * @param {string} output
 * @param {object} row
 * @returns {Promise<string>} checkpoint path
 */
export async function retainCompletedState(output, row) {
  const workspace = row.workspace
  const files = await inventory(workspace)
  for (const [name, expected] of Object.entries(row.evaluation?.evidence ?? {})) {
    if (!isContained(workspace, join(workspace, name))) {
      throw new Error('Completed checkpoint evidence outside the workspace')
    }
    const actual = await digestFile(join(workspace, name))
    if (actual !== expected) throw new Error('Completed checkpoint evidence drift')
    files[name] = expected
  }
  const objects = join(output, 'checkpoint-objects')
  await fsp.mkdir(objects, { recursive: true })
  const modes = {}
  for (const name of Object.keys(files).sort()) {
    const expected = files[name]
    const parts = name.split('/')
    if (isAbsolute(name) || parts.includes('..') || parts.length === 0) {
      throw new Error('Invalid retained checkpoint path')
    }
    await ensureNoSymlink(workspace, parts)
    const path = join(workspace, name)
    if (!isContained(workspace, path)) throw new Error('Retained checkpoint escapes the workspace')
    const stat = await fsp.lstat(path)
    if (!stat.isFile()) throw new Error('Completed checkpoint evidence is not a regular file')
    if (await digestFile(path) !== expected) throw new Error('Completed checkpoint evidence drift')
    modes[name] = stat.mode & 0o777
    const object = join(objects, expected)
    let exists = true
    try {
      await fsp.access(object)
    } catch {
      exists = false
    }
    if (!exists) {
      await fsp.copyFile(path, object)
      await fsp.chmod(object, 0o444)
    }
    if (await digestFile(object) !== expected) throw new Error('Checkpoint object changed')
  }
  const checkpoint = join(output, `${row.id}-completed-state.json`)
  await writeJsonAtomic(checkpoint, { row: publicRow(row), files, modes })
  return checkpoint
}

/**
 * Restore an independently evaluated completed state into a separate retained
 * directory when its mutable successor is incomplete.
 * @param {string} output
 * @param {string} checkpoint
 * @param {object} failedRow
 * @returns {Promise<object>} the restored row
 */
export async function restoreCompletedState(output, checkpoint, failedRow) {
  const saved = JSON.parse(await fsp.readFile(checkpoint, 'utf8'))
  const row = { ...saved.row }
  const folder = join(output, `${failedRow.id}-last-completed`)
  await fsp.mkdir(folder, { recursive: true })
  const workspace = join(folder, 'workspace')
  await fsp.mkdir(workspace, { recursive: true })
  for (const [name, expected] of Object.entries(saved.files)) {
    const parts = name.split('/')
    if (isAbsolute(name) || parts.includes('..') || parts.length === 0) {
      throw new Error('Invalid retained checkpoint path')
    }
    const object = join(output, 'checkpoint-objects', expected)
    if (await digestFile(object) !== expected) {
      throw new Error('Completed checkpoint object drift')
    }
    const target = join(workspace, name)
    await fsp.mkdir(dirname(target), { recursive: true })
    await fsp.copyFile(object, target)
    await fsp.chmod(target, saved.modes[name] ?? 0o644)
  }
  const actual = await inventory(workspace)
  if (jsonDigest(actual) !== row.evaluation?.workspace_manifest_sha256) {
    throw new Error('Restored completed state differs from evaluated state')
  }
  row.id = folder.split(sep).at(-1)
  row.workspace = workspace
  row.retained_completed_id = saved.row.id
  row.incomplete_successor = failedRow.id
  row.pending_workspace = failedRow.workspace
  row.completed_state_sha256 = await digestFile(checkpoint)
  await writeJsonAtomic(join(folder, 'RESULT.json'), row)
  return {
    ...row,
    _state: { id: row.id, backend: 'snapshot', path: workspace, branch: null },
    _ownsState: true,
  }
}

/** Full-copy branch backend used when no LayerFS project is bound. */
export class SnapshotBackend {
  constructor({ output, runId = 'run' }) {
    this.name = 'snapshot'
    this.output = output
    this.runId = runId
  }

  async baseline(source, id) {
    const path = join(this.output, id, 'workspace')
    await snapshot(source, path)
    return { id, backend: this.name, path, branch: null }
  }

  async fork(parent, id) {
    if (!parent) throw new Error('Snapshot branch requires a parent workspace')
    const path = join(this.output, id, 'workspace')
    await snapshot(parent.path, path)
    return { id, backend: this.name, path, branch: null }
  }

  async commit() {}

  async release() {}

  async retainCompletedState(row) {
    return retainCompletedState(this.output, row)
  }

  async restoreCompletedState(checkpoint, failedRow) {
    return restoreCompletedState(this.output, checkpoint, failedRow)
  }
}

function branchSafe(value) {
  const safe = String(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe.slice(0, 40) || 'branch'
}

/** LayerFS copy-on-write branch backend. */
export class LayerFSBackend {
  constructor({ client, operator = null, project, output, runId = 'run', logger = null, syncBaseline = true }) {
    if (!client?.branch?.fork || !client?.workspace?.mount) {
      throw new Error('LayerFS backend requires branch.fork and workspace.mount')
    }
    this.name = 'layerfs'
    this.client = client
    this.operator = operator
    this.project = project
    this.output = output
    this.runId = runId
    this.logger = logger
    this.syncBaseline = syncBaseline
  }

  branchName(id) {
    return `ar-${branchSafe(this.runId)}-${branchSafe(id)}`
  }

  async mountFresh(parentRef, id) {
    const branch = this.branchName(id)
    await this.client.branch.fork(branch, parentRef)
    const mount = await this.client.workspace.mount(branch)
    const path = mount?.path ?? mount?.workspace?.path
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('LayerFS workspace.mount returned no path')
    }
    return { branch, mount, path }
  }

  async baseline(source, id) {
    const { branch, mount, path } = await this.mountFresh('main', id)
    if (this.syncBaseline) {
      await mergeTree(source, path)
      await this.client.workspace.commit(mount, `auto-research: baseline ${id}`)
    }
    return { id, backend: this.name, path, branch, handle: mount }
  }

  async fork(parent, id) {
    if (!parent?.branch) throw new Error('LayerFS branch requires a parent branch')
    const { branch, mount, path } = await this.mountFresh(parent.branch, id)
    return { id, backend: this.name, path, branch, handle: mount }
  }

  async adopt(branch, id) {
    if (typeof branch !== 'string' || branch.length === 0) {
      throw new Error('LayerFS adopt requires a saved branch name')
    }
    const mount = await this.client.workspace.mount(branch)
    const path = mount?.path ?? mount?.workspace?.path
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('LayerFS workspace.mount returned no path')
    }
    return { id, backend: this.name, path, branch, handle: mount }
  }

  async commit(state, { message = 'auto-research: verified state' } = {}) {
    if (!state?.handle) return
    await this.client.workspace.commit(state.handle, message)
  }

  async release(state, { discard = false } = {}) {
    if (!state?.handle) return
    await this.client.workspace.unmount(state.handle, discard)
  }

  async close() {
    await this.client.close?.()
  }

  async retainCompletedState(row) {
    return retainCompletedState(this.output, row)
  }

  async restoreCompletedState(checkpoint, failedRow) {
    return restoreCompletedState(this.output, checkpoint, failedRow)
  }
}

/** Common facade used by the runner. */
export class WorkspaceManager {
  constructor(backend, { output } = {}) {
    this.backend = backend
    this.output = output
  }

  get kind() {
    return this.backend.name
  }

  async baseline(source, id) {
    return this.backend.baseline(source, id)
  }

  async fork(parent, id) {
    return this.backend.fork(parent, id)
  }

  async adopt(branch, id) {
    if (typeof this.backend.adopt !== 'function') {
      throw new Error('This workspace backend cannot adopt an existing branch')
    }
    return this.backend.adopt(branch, id)
  }

  async commit(state, options) {
    return this.backend.commit(state, options)
  }

  async release(state, options) {
    return this.backend.release(state, options)
  }

  async retainCompletedState(row) {
    return this.backend.retainCompletedState(row)
  }

  async restoreCompletedState(checkpoint, failedRow) {
    return this.backend.restoreCompletedState(checkpoint, failedRow)
  }

  async close() {
    await this.backend.close?.()
  }
}

/**
 * Resolve LayerFS deployment settings from explicit config or the session's
 * `DSH_LAYERFS_*` environment (the same names `ctx.shellEnv` exposes).
 * Returns null when no project or SDK is configured.
 */
export function resolveLayerfsConfig(env = process.env, explicit = undefined) {
  if (explicit === false) return null
  const extra = explicit && typeof explicit === 'object' ? explicit : {}
  const project = extra.project ?? env.DSH_LAYERFS_PROJECT
  const sdk = extra.sdk ?? env.DSH_LAYERFS_SDK
  if (!project || !sdk) return null
  return {
    project,
    sdk,
    operator: extra.operator ?? env.DSH_LAYERFS_OPERATOR ?? null,
    storePath: extra.storePath ?? env.DSH_LAYERFS_STORE_PATH ?? null,
    home: extra.home ?? env.DSH_LAYERFS_HOME ?? null,
    trace: extra.trace ?? env.DSH_LAYERFS_TRACE ?? null,
    traceStep: extra.traceStep ?? env.DSH_LAYERFS_TRACE_STEP ?? null,
    syncBaseline: extra.syncBaseline ?? true,
  }
}

function moduleUrl(specifier) {
  if (specifier.startsWith('file:') || specifier.startsWith('node:')) return specifier
  if (isAbsolute(specifier) || specifier.startsWith('.')) return pathToFileURL(resolve(specifier)).href
  return specifier
}

/** Import the LayerFS SDK and construct its client and operator. */
export async function loadLayerfs(settings) {
  const sdk = await import(moduleUrl(settings.sdk))
  const LayerFS = sdk.LayerFS ?? sdk.default?.LayerFS
  if (typeof LayerFS !== 'function') {
    throw new Error('LayerFS SDK does not export LayerFS: ' + settings.sdk)
  }
  const client = new LayerFS(settings.project, {
    ...(settings.storePath ? { storePath: settings.storePath } : {}),
    ...(settings.home ? { home: settings.home } : {}),
    ...(settings.trace ? { trace: settings.trace } : {}),
  })
  let operator = null
  if (settings.operator) {
    const module = await import(moduleUrl(settings.operator))
    const LayerFSOperator = module.LayerFSOperator ?? module.default?.LayerFSOperator
    if (typeof LayerFSOperator === 'function') operator = new LayerFSOperator(client)
  }
  return { client, operator }
}

/**
 * Build the workspace manager, preferring LayerFS when bound.
 * @param {object} options
 * @param {string} options.output run directory
 * @param {string} options.runId
 * @param {object} [options.config] plugin config (reads `config.layerfs`)
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {object} [options.layerfs] explicit `{ client, operator, project }`
 */
export async function createWorkspaceManager({ output, runId, config = {}, env = process.env, layerfs = undefined }) {
  if (layerfs?.client) {
    const backend = new LayerFSBackend({
      client: layerfs.client,
      operator: layerfs.operator ?? null,
      project: layerfs.project ?? config.layerfs?.project ?? 'auto-research',
      output,
      runId,
      syncBaseline: config.layerfs?.syncBaseline ?? true,
    })
    return new WorkspaceManager(backend, { output })
  }
  const settings = resolveLayerfsConfig(env, config.layerfs)
  if (settings) {
    const loaded = await loadLayerfs(settings)
    const backend = new LayerFSBackend({
      ...loaded,
      project: settings.project,
      output,
      runId,
      syncBaseline: settings.syncBaseline,
    })
    return new WorkspaceManager(backend, { output })
  }
  return new WorkspaceManager(new SnapshotBackend({ output, runId }), { output })
}

/**
 * Resolve the optional compact research seed named by `plan.workspace`.
 * It must be a regular, symlink-free subdirectory inside `root`.
 * @param {string} root
 * @param {object} plan
 * @returns {Promise<string>}
 */
export async function selectPlanWorkspace(root, plan) {
  const requested = plan?.workspace
  if (requested === undefined || requested === null) return root
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new Error('Plan workspace must be a nonempty relative directory')
  }
  if (isAbsolute(requested)) {
    throw new Error('Plan workspace must be strictly contained in the assigned checkout')
  }
  const parts = requested.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0 || parts.includes('..') || parts.includes('.auto-research-methods')) {
    throw new Error('Plan workspace must be a regular compact subdirectory, not prior runtime')
  }
  await ensureNoSymlink(root, parts)
  const chosen = await fsp.realpath(join(root, ...parts))
  const realRoot = await fsp.realpath(root)
  if (chosen === realRoot || !isContained(realRoot, chosen)) {
    throw new Error('Plan workspace must be a regular compact subdirectory, not prior runtime')
  }
  const stat = await fsp.stat(chosen)
  if (!stat.isDirectory()) throw new Error('Plan workspace must be a directory')
  return chosen
}
