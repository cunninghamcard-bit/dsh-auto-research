/**
 * Workspace ownership for auto-research branches.
 *
 * Two interchangeable backends implement the same small contract:
 *
 * - LayerFS: fork copy-on-write branches, mount each branch, commit verified
 *   states, and unmount with `discard` only for abandoned work.
 * - Snapshot: content-addressed, full-copy branches in the run directory when
 *   no LayerFS project is bound.
 *
 * When `workspace.mount` returns a Sandbox-internal path (for example
 * `/workspaces/1`) the LayerFS backend transparently bridges it through a
 * host-accessible staging directory and publishes changes with `fs.apply` +
 * `workspace.commit`, so evaluation and evidence checks always run on the host.
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
import type {
  CompletedState,
  Config,
  LayerFSBinding,
  LayerFSClient,
  LayerFSMount,
  LayerFSSettings,
  Logger,
  PluginContext,
  TrajectoryRow,
  WorkspaceManagerLike,
  WorkspaceState,
} from './types.js'

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
const BRANCH_PATTERN = /^ar-[a-z0-9-]+$/
const MAX_BRANCH_LENGTH = 63

/** @returns the lowercase hexadecimal SHA-256 of `data`. */
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** @returns the SHA-256 of one file, streamed in 1 MiB blocks. */
export async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', block => hash.update(block))
    stream.on('end', () => resolvePromise())
  })
  return hash.digest('hex')
}

/** Deterministic JSON (sorted object keys at every depth). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** @returns the SHA-256 of the canonical JSON encoding of `value`. */
export function jsonDigest(value: unknown): string {
  return sha256(canonicalJson(value))
}

/** Deep JSON equality through canonical encoding. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b)
}

/** Whether `target` is `root` or strictly inside it. */
export function isContained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** @returns the path relative to `root`, using POSIX separators. */
export function relativePosix(root: string, target: string): string {
  return relative(root, target).split(sep).join('/')
}

function omitDirectory(parentName: string | undefined, name: string): boolean {
  if (OMIT.has(name)) return true
  return parentName === SHARED_CONTEXT && name.startsWith('methods-')
}

function omitFile(name: string): boolean {
  return OMIT.has(name) || ENV_FILE.test(name)
}

/**
 * Snapshot inventory: relative POSIX path -> SHA-256 for every regular,
 * non-omitted file. Symlinks and non-regular entries are rejected instead of
 * being followed, so a snapshot never captures bytes outside the workspace.
 */
export async function inventory(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function walk(directory: string): Promise<void> {
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
export async function inventoryBytes(root: string, files: Record<string, string>): Promise<number> {
  let total = 0
  for (const name of Object.keys(files)) {
    const stat = await fsp.lstat(join(root, name))
    total += stat.size
  }
  return total
}

/** @returns available bytes of the filesystem holding `path` (or its nearest parent). */
export async function freeBytes(path: string): Promise<number> {
  let cursor = resolve(path)
  while (true) {
    try {
      const stat = await fsp.statfs(cursor)
      return Number(stat.bavail) * Number(stat.bsize)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      cursor = parent
    }
  }
}

function shouldCopy(sourceRoot: string, candidate: string): boolean {
  const rel = relative(sourceRoot, candidate)
  if (rel === '') return true
  const parts = rel.split(sep)
  const name = parts.at(-1) ?? ''
  const parent = parts.length > 1 ? parts.at(-2) : sourceRoot.split(sep).at(-1)
  if (OMIT.has(name)) return false
  if (ENV_FILE.test(name)) return false
  if (parent === SHARED_CONTEXT && name.startsWith('methods-')) return false
  return true
}

async function copyTree(sourceRoot: string, destinationRoot: string): Promise<void> {
  async function walk(source: string, destination: string): Promise<void> {
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
 */
export async function snapshot(source: string, destination: string): Promise<Record<string, string>> {
  try {
    await fsp.lstat(destination)
    throw new Error('Existing branch is preserved: ' + destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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

/** Merge `source` into an existing directory (LayerFS baseline / staging copy). */
export async function mergeTree(source: string, destination: string): Promise<Record<string, string>> {
  const before = await inventory(source)
  await copyTree(source, destination)
  return before
}

/** Write JSON through a temporary sibling and an atomic rename. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true })
  const temporary = path + '.new'
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
  await fsp.rename(temporary, path)
}

/** Strip live handles from a row before it is serialized. */
export function publicRow(row: TrajectoryRow): TrajectoryRow {
  const copy: TrajectoryRow = { ...row }
  delete copy._state
  delete copy._ownsState
  delete copy._released
  return copy
}

async function ensureNoSymlink(root: string, parts: string[]): Promise<void> {
  let cursor = root
  for (const part of parts) {
    cursor = join(cursor, part)
    let stat
    try {
      stat = await fsp.lstat(cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error('Completed checkpoint path may not traverse symlinks')
  }
}

/**
 * Store every distinct completed file once in `checkpoint-objects` and record a
 * checkpoint manifest for later restoration.
 *
 * @returns checkpoint path
 */
export async function retainCompletedState(output: string, row: TrajectoryRow): Promise<string> {
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
  const modes: Record<string, number> = {}
  for (const name of Object.keys(files).sort()) {
    const expected = files[name]
    if (expected === undefined) continue
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
  const saved: CompletedState = { row: publicRow(row), files, modes }
  await writeJsonAtomic(checkpoint, saved)
  return checkpoint
}

/**
 * Restore an independently evaluated completed state into a separate retained
 * directory when its mutable successor is incomplete.
 *
 * @returns the restored row
 */
export async function restoreCompletedState(
  output: string,
  checkpoint: string,
  failedRow: TrajectoryRow,
): Promise<TrajectoryRow> {
  const saved = JSON.parse(await fsp.readFile(checkpoint, 'utf8')) as CompletedState
  const row: TrajectoryRow = { ...saved.row }
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
  row.id = folder.split(sep).at(-1) ?? row.id
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
  readonly name = 'snapshot'
  readonly output: string
  readonly runId: string

  constructor({ output, runId = 'run' }: { output: string; runId?: string }) {
    this.output = output
    this.runId = runId
  }

  async baseline(source: string, id: string): Promise<WorkspaceState> {
    const path = join(this.output, id, 'workspace')
    await snapshot(source, path)
    return { id, backend: this.name, path, branch: null }
  }

  async fork(parent: WorkspaceState, id: string): Promise<WorkspaceState> {
    if (!parent) throw new Error('Snapshot branch requires a parent workspace')
    const path = join(this.output, id, 'workspace')
    await snapshot(parent.path, path)
    return { id, backend: this.name, path, branch: null }
  }

  async commit(): Promise<void> {}

  async release(): Promise<void> {}

  async retainCompletedState(row: TrajectoryRow): Promise<string> {
    return retainCompletedState(this.output, row)
  }

  async restoreCompletedState(checkpoint: string, failedRow: TrajectoryRow): Promise<TrajectoryRow> {
    return restoreCompletedState(this.output, checkpoint, failedRow)
  }
}

/** Sanitize a value into a Docker/LayerFS-safe name fragment. */
export function branchSafe(value: unknown, max = 40): string {
  const safe = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return safe.slice(0, max) || 'branch'
}

function isBusyError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; message?: unknown }
  return candidate.code === 'Busy' || /busy/i.test(String(candidate.message ?? ''))
}

/**
 * Retry a LayerFS call that refused with `Busy`, using exponential backoff.
 * All other refusals propagate unchanged.
 */
export async function withBusyRetry<T>(
  fn: () => Promise<T>,
  options: {
    retries?: number
    baseDelayMs?: number
    delay?: (milliseconds: number) => Promise<void>
  } = {},
): Promise<T> {
  const retries = options.retries ?? 4
  const baseDelayMs = options.baseDelayMs ?? 150
  const delay = options.delay ?? ((milliseconds: number) => new Promise<void>(resolvePromise => {
    const timer = setTimeout(resolvePromise, milliseconds)
    timer.unref?.()
  }))
  let attempt = 0
  while (true) {
    try {
      return await fn()
    } catch (error) {
      if (attempt >= retries || !isBusyError(error)) throw error
      await delay(baseDelayMs * 2 ** attempt)
      attempt += 1
    }
  }
}

/** One host-accessible view of a mounted LayerFS branch. */
interface MountedWorkspace {
  branch: string
  mount: LayerFSMount
  /** Host path used by the runner, evaluator and worker. */
  path: string
  /** Sandbox-internal mount path when the host path is a staging copy. */
  sandboxPath: string | null
  staging: boolean
}

/**
 * LayerFS copy-on-write branch backend.
 *
 * `ownsClient` is false whenever the client was injected by the host (for
 * example `ctx.layerfs.client`), so `close()` never tears down a shared client.
 */
export class LayerFSBackend {
  readonly name = 'layerfs'
  readonly client: LayerFSClient
  readonly operator: unknown
  readonly project: string
  readonly output: string
  readonly runId: string
  readonly logger: Logger | null
  readonly syncBaseline: boolean
  readonly ownsClient: boolean
  readonly retryBaseDelayMs: number

  constructor(options: {
    client: LayerFSClient
    operator?: unknown
    project?: string
    output: string
    runId?: string
    logger?: Logger | null
    syncBaseline?: boolean
    ownsClient?: boolean
    retryBaseDelayMs?: number
  }) {
    const { client } = options
    if (typeof client?.branch?.fork !== 'function' || typeof client?.workspace?.mount !== 'function') {
      throw new Error('LayerFS backend requires branch.fork and workspace.mount')
    }
    this.client = client
    this.operator = options.operator ?? null
    this.project = options.project ?? 'auto-research'
    this.output = options.output
    this.runId = options.runId ?? 'run'
    this.logger = options.logger ?? null
    this.syncBaseline = options.syncBaseline ?? true
    this.ownsClient = options.ownsClient ?? false
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 150
  }

  /** @returns a branch name that always fits Docker's 63-character limit. */
  branchName(id: string): string {
    return `ar-${branchSafe(this.runId, 12)}-${branchSafe(id, 44)}`
  }

  retry<T>(fn: () => Promise<T>): Promise<T> {
    return withBusyRetry(fn, { retries: 4, baseDelayMs: this.retryBaseDelayMs })
  }

  private async mountBranch(branch: string, id: string, sourcePath: string | null): Promise<MountedWorkspace> {
    const mount = await this.retry(() => {
      const method = this.client.workspace?.mount
      if (typeof method !== 'function') throw new Error('LayerFS client has no workspace.mount')
      return method.call(this.client.workspace, branch)
    })
    const raw = mount?.path ?? mount?.workspace?.path
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error('LayerFS workspace.mount returned no path')
    }
    const host = await hostDirectory(raw)
    if (host) {
      return {
        branch,
        mount,
        path: host,
        sandboxPath: typeof mount.sandbox === 'string' ? raw : null,
        staging: false,
      }
    }
    // A Sandbox-internal mount (/workspaces/N) is not visible on the host.
    // Stage a host copy so evaluation, evidence checks and one-shot CLI
    // workers all operate on real files, then publish changes back.
    const staging = join(this.output, id, 'workspace')
    await fsp.mkdir(staging, { recursive: true })
    if (sourcePath) await mergeTree(sourcePath, staging)
    return {
      branch,
      mount,
      path: staging,
      sandboxPath: raw,
      staging: true,
    }
  }

  private async syncStaging(state: WorkspaceState, message: string): Promise<void> {
    const handle = state.handle
    const branch = state.branch
    if (!handle || !branch) return
    const after = await inventory(state.path)
    const before = state.stagingInventory ?? {}
    const writes: unknown[] = []
    for (const name of Object.keys(after).sort()) {
      if (after[name] === before[name]) continue
      const content = await fsp.readFile(join(state.path, name))
      writes.push({ op: 'write', path: '/' + name, content })
    }
    for (const name of Object.keys(before).sort()) {
      if (name in after) continue
      writes.push({ op: 'rm', path: '/' + name })
    }
    const fs = this.client.fs
    if (writes.length > 0) {
      if (typeof fs?.apply === 'function') {
        await this.retry(() => fs.apply!(branch, writes, message))
      } else if (typeof fs?.write === 'function' || typeof fs?.rm === 'function') {
        for (const change of writes as Array<{ op: string; path: string; content?: Uint8Array }>) {
          if (change.op === 'write' && typeof fs.write === 'function') {
            await this.retry(() => fs.write!(branch, change.path, change.content ?? new Uint8Array()))
          } else if (change.op === 'rm' && typeof fs.rm === 'function') {
            await this.retry(() => fs.rm!(branch, change.path))
          }
        }
      } else {
        this.logger?.warn?.(
          '[auto-research] LayerFS mount is Sandbox-internal and the client exposes no fs.apply/fs.write; changes stay staged on the host',
        )
      }
    }
    if (typeof this.client.workspace?.commit === 'function') {
      await this.retry(() => this.client.workspace!.commit!(handle, message))
    }
    state.stagingInventory = after
  }

  private async materializeBranch(branch: string, destination: string): Promise<void> {
    const fs = this.client.fs
    if (typeof fs?.list !== 'function' || typeof fs?.read !== 'function') {
      this.logger?.warn?.('[auto-research] cannot materialize a Sandbox-internal adopted branch: client.fs is unavailable')
      return
    }
    const files = await listBranchFiles(fs, branch)
    for (const name of files) {
      try {
        const value = await fs.read(branch, name)
        const text = typeof value === 'string'
          ? value
          : (value as { content?: unknown })?.content
        if (typeof text !== 'string') continue
        const target = join(destination, name.replace(/^\/+/, ''))
        await fsp.mkdir(dirname(target), { recursive: true })
        await fsp.writeFile(target, text)
      } catch (error) {
        this.logger?.warn?.(`[auto-research] skipped non-text adopted file ${name}: ${(error as Error).message}`)
      }
    }
  }

  async baseline(source: string, id: string): Promise<WorkspaceState> {
    const branch = this.branchName(id)
    await this.retry(() => this.client.branch!.fork!(branch, 'main'))
    const mounted = await this.mountBranch(branch, id, source)
    if (!mounted.staging && this.syncBaseline) {
      await mergeTree(source, mounted.path)
    }
    const state: WorkspaceState = {
      id,
      backend: this.name,
      path: mounted.path,
      branch,
      handle: mounted.mount,
      sandboxPath: mounted.sandboxPath,
      staging: mounted.staging,
    }
    if (mounted.staging) {
      // A fresh LayerFS branch starts empty, so every source file is a write.
      state.stagingInventory = {}
      await this.syncStaging(state, `auto-research: baseline ${id}`)
    } else if (this.syncBaseline) {
      await this.retry(() => this.client.workspace!.commit!(mounted.mount, `auto-research: baseline ${id}`))
    }
    return state
  }

  async fork(parent: WorkspaceState, id: string): Promise<WorkspaceState> {
    if (!parent?.branch) throw new Error('LayerFS branch requires a parent branch')
    const branch = this.branchName(id)
    await this.retry(() => this.client.branch!.fork!(branch, parent.branch!))
    const mounted = await this.mountBranch(branch, id, parent.path)
    return {
      id,
      backend: this.name,
      path: mounted.path,
      branch,
      handle: mounted.mount,
      sandboxPath: mounted.sandboxPath,
      staging: mounted.staging,
      stagingInventory: await inventory(mounted.path),
    }
  }

  async adopt(branch: string, id: string): Promise<WorkspaceState> {
    if (typeof branch !== 'string' || branch.length === 0) {
      throw new Error('LayerFS adopt requires a saved branch name')
    }
    if (branch.length > MAX_BRANCH_LENGTH || !BRANCH_PATTERN.test(branch)) {
      throw new Error(
        `Previous leader branch is not a safe auto-research branch name (expected ${BRANCH_PATTERN.source}, <= ${MAX_BRANCH_LENGTH} chars): ${branch}`,
      )
    }
    const mounted = await this.mountBranch(branch, id, null).catch(error => {
      throw new Error(`Previous leader branch is missing or inaccessible (${branch}): ${(error as Error).message}`)
    })
    if (mounted.staging) await this.materializeBranch(branch, mounted.path)
    return {
      id,
      backend: this.name,
      path: mounted.path,
      branch,
      handle: mounted.mount,
      sandboxPath: mounted.sandboxPath,
      staging: mounted.staging,
      stagingInventory: await inventory(mounted.path),
    }
  }

  async commit(state: WorkspaceState, { message = 'auto-research: verified state' }: { message?: string } = {}): Promise<void> {
    if (!state?.handle) return
    if (state.staging) {
      await this.syncStaging(state, message)
      return
    }
    await this.retry(() => {
      const method = this.client.workspace?.commit
      if (typeof method !== 'function') return Promise.resolve()
      return method.call(this.client.workspace, state.handle as LayerFSMount, message)
    })
  }

  async release(state: WorkspaceState, { discard = false }: { discard?: boolean } = {}): Promise<void> {
    if (!state?.handle) return
    await this.retry(() => {
      const method = this.client.workspace?.unmount
      if (typeof method !== 'function') return Promise.resolve()
      return method.call(this.client.workspace, state.handle as LayerFSMount, discard)
    })
  }

  async close(): Promise<void> {
    if (!this.ownsClient) return
    await this.client.close?.()
  }

  async retainCompletedState(row: TrajectoryRow): Promise<string> {
    return retainCompletedState(this.output, row)
  }

  async restoreCompletedState(checkpoint: string, failedRow: TrajectoryRow): Promise<TrajectoryRow> {
    return restoreCompletedState(this.output, checkpoint, failedRow)
  }
}

/** Whether a mount path exists directly on the host filesystem. */
async function hostDirectory(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null
  try {
    const stat = await fsp.stat(path)
    return stat.isDirectory() ? path : null
  } catch {
    return null
  }
}

/** List every file path (absolute, `/`-rooted) in a LayerFS branch. */
async function listBranchFiles(
  fs: NonNullable<LayerFSClient['fs']>,
  branch: string,
): Promise<string[]> {
  const files: string[] = []
  const list = fs.list
  if (typeof list !== 'function') return files
  const walk = async (path: string): Promise<void> => {
    let pagePos = 0
    while (true) {
      const page = await list(branch, path, 1000, pagePos)
      const items = Array.isArray(page)
        ? page
        : (page as { items?: unknown })?.items
      if (!Array.isArray(items) || items.length === 0) return
      for (const raw of items as Array<Record<string, unknown>>) {
        const name = typeof raw.name === 'string' ? raw.name : typeof raw.path === 'string' ? raw.path : null
        if (!name) continue
        const full = path === '/' ? `/${name.replace(/^\/+/, '')}` : `${path}/${name.replace(/^\/+/, '')}`
        const type = String(raw.type ?? raw.kind ?? '')
        const directory = raw.isDirectory === true || type === 'directory' || type === 'dir'
        if (directory) await walk(full)
        else files.push(full)
      }
      if (!(page as { hasMore?: unknown })?.hasMore) return
      pagePos += items.length
    }
  }
  await walk('/')
  return files
}

/** Common facade used by the runner. */
export class WorkspaceManager implements WorkspaceManagerLike {
  readonly backend: {
    name: string
    baseline: (source: string, id: string) => Promise<WorkspaceState>
    fork: (parent: WorkspaceState, id: string) => Promise<WorkspaceState>
    adopt?: (branch: string, id: string) => Promise<WorkspaceState>
    commit: (state: WorkspaceState, options?: { message?: string }) => Promise<void>
    release: (state: WorkspaceState, options?: { discard?: boolean }) => Promise<void>
    retainCompletedState: (row: TrajectoryRow) => Promise<string>
    restoreCompletedState: (checkpoint: string, failedRow: TrajectoryRow) => Promise<TrajectoryRow>
    close?: () => Promise<void>
  }
  readonly output: string | undefined

  constructor(
    backend: WorkspaceManager['backend'],
    { output }: { output?: string } = {},
  ) {
    this.backend = backend
    this.output = output
  }

  get kind(): string {
    return this.backend.name
  }

  async baseline(source: string, id: string): Promise<WorkspaceState> {
    return this.backend.baseline(source, id)
  }

  async fork(parent: WorkspaceState, id: string): Promise<WorkspaceState> {
    return this.backend.fork(parent, id)
  }

  async adopt(branch: string, id: string): Promise<WorkspaceState> {
    if (typeof this.backend.adopt !== 'function') {
      throw new Error('This workspace backend cannot adopt an existing branch')
    }
    return this.backend.adopt(branch, id)
  }

  async commit(state: WorkspaceState, options?: { message?: string }): Promise<void> {
    return this.backend.commit(state, options)
  }

  async release(state: WorkspaceState, options?: { discard?: boolean }): Promise<void> {
    return this.backend.release(state, options)
  }

  async retainCompletedState(row: TrajectoryRow): Promise<string> {
    return this.backend.retainCompletedState(row)
  }

  async restoreCompletedState(checkpoint: string, failedRow: TrajectoryRow): Promise<TrajectoryRow> {
    return this.backend.restoreCompletedState(checkpoint, failedRow)
  }

  async close(): Promise<void> {
    await this.backend.close?.()
  }
}

/** Every `DSH_LAYERFS_*` name a `dsh` session may publish. */
export const LAYERFS_ENV_KEYS = [
  'DSH_LAYERFS_PROJECT',
  'DSH_LAYERFS_SDK',
  'DSH_LAYERFS_OPERATOR',
  'DSH_LAYERFS_CLI',
  'DSH_LAYERFS_SKILL',
  'DSH_LAYERFS_HOME',
  'DSH_LAYERFS_STORE_PATH',
  'DSH_LAYERFS_DOCKER',
  'DSH_LAYERFS_IMAGE',
  'DSH_LAYERFS_VOLUME',
  'DSH_LAYERFS_DAEMON',
  'DSH_LAYERFS_CONTAINER_PREFIX',
  'DSH_LAYERFS_DAEMON_HOST',
  'DSH_LAYERFS_TRACE',
  'DSH_LAYERFS_TRACE_STEP',
] as const

/**
 * Resolve LayerFS deployment settings from explicit config or the session's
 * `DSH_LAYERFS_*` environment (the same names `ctx.shellEnv` exposes).
 * Returns null when no project or SDK is configured.
 */
export function resolveLayerfsConfig(
  env: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
  explicit: LayerFSBinding | false | undefined = undefined,
): LayerFSSettings | null {
  if (explicit === false) return null
  const extra: LayerFSBinding = explicit && typeof explicit === 'object' ? explicit : {}
  const read = (key: string): string | undefined => {
    const value = env[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const project = extra.project ?? read('DSH_LAYERFS_PROJECT')
  const sdk = extra.sdk ?? read('DSH_LAYERFS_SDK')
  if (!project || !sdk) return null
  return {
    project,
    sdk,
    operator: extra.operator !== undefined
      ? (extra.operator as string | null)
      : read('DSH_LAYERFS_OPERATOR') ?? null,
    cli: read('DSH_LAYERFS_CLI') ?? null,
    skill: read('DSH_LAYERFS_SKILL') ?? null,
    storePath: extra.storePath !== undefined
      ? (extra.storePath as string | null)
      : read('DSH_LAYERFS_STORE_PATH') ?? null,
    home: extra.home !== undefined
      ? (extra.home as string | null)
      : read('DSH_LAYERFS_HOME') ?? null,
    trace: extra.trace !== undefined
      ? (extra.trace as string | null)
      : read('DSH_LAYERFS_TRACE') ?? null,
    traceStep: extra.traceStep !== undefined
      ? (extra.traceStep as string | null)
      : read('DSH_LAYERFS_TRACE_STEP') ?? null,
    docker: read('DSH_LAYERFS_DOCKER') ?? null,
    image: read('DSH_LAYERFS_IMAGE') ?? null,
    volume: read('DSH_LAYERFS_VOLUME') ?? null,
    daemon: read('DSH_LAYERFS_DAEMON') ?? null,
    containerPrefix: read('DSH_LAYERFS_CONTAINER_PREFIX') ?? null,
    daemonHost: read('DSH_LAYERFS_DAEMON_HOST') ?? null,
    syncBaseline: extra.syncBaseline ?? true,
  }
}

/**
 * Build the non-secret `DSH_LAYERFS_*` environment handed to workers.
 * Values already present in the session environment win over normalized
 * defaults so a host integration keeps its exact binding.
 */
export function layerfsEnvironment(
  env: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
  settings: LayerFSSettings | null = null,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of LAYERFS_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) result[key] = value
  }
  if (settings) {
    const defaults: Record<string, string | null | undefined> = {
      DSH_LAYERFS_PROJECT: settings.project,
      DSH_LAYERFS_SDK: settings.sdk,
      DSH_LAYERFS_OPERATOR: settings.operator,
      DSH_LAYERFS_CLI: settings.cli,
      DSH_LAYERFS_SKILL: settings.skill,
      DSH_LAYERFS_HOME: settings.home,
      DSH_LAYERFS_STORE_PATH: settings.storePath,
      DSH_LAYERFS_DOCKER: settings.docker,
      DSH_LAYERFS_IMAGE: settings.image,
      DSH_LAYERFS_VOLUME: settings.volume,
      DSH_LAYERFS_DAEMON: settings.daemon,
      DSH_LAYERFS_CONTAINER_PREFIX: settings.containerPrefix,
      DSH_LAYERFS_DAEMON_HOST: settings.daemonHost,
      DSH_LAYERFS_TRACE: settings.trace,
      DSH_LAYERFS_TRACE_STEP: settings.traceStep,
    }
    for (const [key, value] of Object.entries(defaults)) {
      if (result[key] === undefined && typeof value === 'string' && value.length > 0) result[key] = value
    }
  }
  return result
}

/**
 * Resolve the environment contributed by `ctx.shellEnv` (the same service
 * `@dsh-layerfs/host` binds). Host versions expose contributors, `resolve`,
 * `snapshot` or a plain `env`; all shapes are handled and merged.
 */
export async function resolveShellEnvironment(
  ctx: Pick<PluginContext, 'shellEnv' | 'get'>,
  agent?: unknown,
): Promise<Record<string, string>> {
  const service = ctx.shellEnv ?? (typeof ctx.get === 'function' ? ctx.get('shellEnv') as PluginContext['shellEnv'] : undefined)
  if (!service || typeof service !== 'object') return {}
  const merged: Record<string, unknown> = {}
  const absorb = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'string') merged[key] = entry
      else if (entry === null || entry === undefined) delete merged[key]
    }
  }
  if (service.env && typeof service.env === 'object') absorb(service.env)
  for (const method of ['resolve', 'snapshot', 'collect'] as const) {
    const fn = service[method]
    if (typeof fn === 'function') {
      try {
        absorb(await fn.call(service, { agent }))
      } catch {
        // A host without this contributor style simply contributes nothing.
      }
    }
  }
  const contributors = service.contributors ?? service.sources
  if (Array.isArray(contributors)) {
    for (const contributor of contributors) {
      if (typeof contributor === 'function') {
        try {
          absorb(await contributor({ agent }))
        } catch {
          // Ignore a contributor that cannot resolve for this agent.
        }
        continue
      }
      if (!contributor || typeof contributor !== 'object') continue
      absorb(contributor)
      for (const method of ['contribute', 'resolve', 'snapshot', 'env'] as const) {
        const fn = (contributor as Record<string, unknown>)[method]
        if (typeof fn === 'function') {
          try {
            absorb(await fn.call(contributor, { agent }))
          } catch {
            // Ignore a contributor that cannot resolve for this agent.
          }
        } else if (method === 'env' && fn && typeof fn === 'object') {
          absorb(fn)
        }
      }
    }
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === 'string') result[key] = value
  }
  return result
}

function moduleUrl(specifier: string): string {
  if (specifier.startsWith('file:') || specifier.startsWith('node:')) return specifier
  if (isAbsolute(specifier) || specifier.startsWith('.')) return pathToFileURL(resolve(specifier)).href
  return specifier
}

/** Import the LayerFS SDK and construct its client and optional operator. */
export async function loadLayerfs(settings: LayerFSSettings): Promise<{ client: LayerFSClient; operator: unknown }> {
  const sdk = await import(moduleUrl(settings.sdk)) as Record<string, unknown> & {
    default?: Record<string, unknown>
  }
  const LayerFS = (sdk.LayerFS ?? sdk.default?.LayerFS) as
    | (new (project: string, options?: Record<string, unknown>) => LayerFSClient)
    | undefined
  if (typeof LayerFS !== 'function') {
    throw new Error('LayerFS SDK does not export LayerFS: ' + settings.sdk)
  }
  const options: Record<string, unknown> = {}
  if (settings.storePath) options.storePath = settings.storePath
  if (settings.home) options.home = settings.home
  if (settings.trace) options.trace = settings.trace
  if (settings.traceStep) options.traceStep = settings.traceStep
  const client = new LayerFS(settings.project, options)
  // The SDK reads deployment settings from the process environment, but a
  // session bound through `@dsh-layerfs/host` publishes them via `ctx.shellEnv`.
  // Mirror the resolved settings onto the client so its own deployment lookup
  // sees exactly the same binding without mutating `process.env`.
  const clientOptions = (client as { options?: Record<string, unknown> }).options
  if (clientOptions) {
    const deploy = { ...((clientOptions.deploy as Record<string, unknown> | undefined) ?? {}) }
    const deployment: Record<string, string | null> = {
      docker: settings.docker,
      image: settings.image,
      volume: settings.volume,
      daemon: settings.daemon,
      containerPrefix: settings.containerPrefix,
      daemonHost: settings.daemonHost,
    }
    for (const [key, value] of Object.entries(deployment)) {
      if (typeof value === 'string' && value.length > 0) deploy[key] = value
    }
    clientOptions.deploy = deploy
  }
  let operator: unknown = null
  if (settings.operator) {
    const module = await import(moduleUrl(settings.operator)) as Record<string, unknown> & {
      default?: Record<string, unknown>
    }
    const LayerFSOperator = (module.LayerFSOperator ?? module.default?.LayerFSOperator) as
      | (new (client: LayerFSClient) => unknown)
      | undefined
    if (typeof LayerFSOperator === 'function') operator = new LayerFSOperator(client)
  }
  return { client, operator }
}

/**
 * Build the workspace manager, preferring LayerFS when bound.
 */
export async function createWorkspaceManager({
  output,
  runId,
  config = {},
  env = process.env,
  layerfs = undefined,
}: {
  output: string
  runId: string
  config?: Config
  env?: NodeJS.ProcessEnv | Record<string, unknown>
  layerfs?: LayerFSBinding
}): Promise<WorkspaceManager> {
  const configured = config.layerfs && typeof config.layerfs === 'object' ? config.layerfs : null
  if (layerfs?.client) {
    const backend = new LayerFSBackend({
      client: layerfs.client,
      ...(layerfs.operator !== undefined ? { operator: layerfs.operator } : {}),
      project: layerfs.project ?? configured?.project ?? 'auto-research',
      output,
      runId,
      syncBaseline: configured?.syncBaseline ?? true,
      ownsClient: false,
    })
    return new WorkspaceManager(backend, { output })
  }
  const settings = resolveLayerfsConfig(env, configured ?? undefined)
  if (settings) {
    const loaded = await loadLayerfs(settings)
    const backend = new LayerFSBackend({
      client: loaded.client,
      operator: loaded.operator,
      project: settings.project,
      output,
      runId,
      syncBaseline: settings.syncBaseline,
      ownsClient: true,
    })
    return new WorkspaceManager(backend, { output })
  }
  return new WorkspaceManager(new SnapshotBackend({ output, runId }), { output })
}

/**
 * Resolve the optional compact research seed named by `plan.workspace`.
 * It must be a regular, symlink-free subdirectory inside `root`.
 */
export async function selectPlanWorkspace(root: string, plan: { workspace?: unknown }): Promise<string> {
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
