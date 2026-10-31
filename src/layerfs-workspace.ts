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

/** The refusal's code, or `''` for a plain error. */
function refusalCode(error: unknown): string {
  if (error === null || typeof error !== 'object') return ''
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

/**
 * Whether a refusal means the LayerFS project does not exist yet or its `main`
 * branch carries no usable state, so `project.init(source)` can recover.
 *
 * The live and simulated bindings use the same codes (`NoSuchProject`,
 * `NoSuchBranch`, `NoSuchCommit`); message hints cover SDK versions that wrap
 * the refusal. Codes that mean "the project is there but unusable" are never
 * treated as missing.
 */
export function isMissingProjectOrMain(error: unknown): boolean {
  const code = refusalCode(error)
  if (['NoSuchProject', 'NoSuchBranch', 'NoSuchCommit', 'NoSuchLayer'].includes(code)) return true
  if (['Exists', 'ReadOnly', 'Conflict', 'Busy', 'InvalidInput', 'NoSuchPath', 'Unsupported'].includes(code)) return false
  const message = error === null || typeof error !== 'object'
    ? ''
    : String((error as { message?: unknown }).message ?? '')
  return /project .{0,200}does not exist|\bno (simulated )?(layerfs )?project\b|main (branch )?(does not exist|has no|is empty)|NoSuchProject|NoSuchBranch/i.test(message)
}

/** Whether `project.init` refused because the project already exists. */
function isExistingProject(error: unknown): boolean {
  const code = refusalCode(error)
  if (code === 'Exists') return true
  const message = error === null || typeof error !== 'object'
    ? ''
    : String((error as { message?: unknown }).message ?? '')
  return /\bexists\b|already initialized/i.test(message)
}

/**
 * Whether a failed `branch.fork(_, 'main')` may mean the project is not
 * initialized yet.
 *
 * The ported macOS SDK reports a missing Store file as a plain `Failed` OS
 * error instead of `NoSuchProject`, so this is deliberately permissive: only
 * refusals that describe a different problem are excluded, and the caller
 * retries `project.init` + fork for everything else.
 */
export function mayNeedProjectInit(error: unknown): boolean {
  if (isMissingProjectOrMain(error)) return true
  const code = refusalCode(error)
  if (['Busy', 'InvalidInput', 'Unsupported', 'ReadOnly'].includes(code)) return false
  const message = error === null || typeof error !== 'object'
    ? ''
    : String((error as { message?: unknown }).message ?? '')
  if (/invalid.*branch name|not a valid name/i.test(message)) return false
  return true
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
  /** Close of the client `loadLayerfs` built, which also restores the environment. */
  readonly releaseEnvironment: (() => Promise<void> | void) | null

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
    releaseEnvironment?: (() => Promise<void> | void) | null
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
    this.releaseEnvironment = options.releaseEnvironment ?? null
  }

  /** @returns a branch name that always fits Docker's 63-character limit. */
  branchName(id: string): string {
    return `ar-${branchSafe(this.runId, 12)}-${branchSafe(id, 44)}`
  }

  retry<T>(fn: () => Promise<T>): Promise<T> {
    return withBusyRetry(fn, { retries: 4, baseDelayMs: this.retryBaseDelayMs })
  }

  /**
   * Unmount a workspace whose preparation failed and remove any host staging
   * copy. Cleanup failures are logged, never allowed to mask the original
   * error.
   */
  private async discardMount(mount: LayerFSMount | null | undefined, stagingPath: string | null): Promise<void> {
    try {
      const unmount = this.client.workspace?.unmount
      if (mount && typeof unmount === 'function') {
        await this.retry(() => unmount.call(this.client.workspace, mount, true))
      }
    } catch (error) {
      this.logger?.warn?.(`[auto-research] failed to unmount a partially prepared workspace: ${(error as Error).message}`)
    }
    if (!stagingPath) return
    try {
      await fsp.rm(stagingPath, { recursive: true, force: true })
    } catch (error) {
      this.logger?.warn?.(`[auto-research] failed to remove staging ${stagingPath}: ${(error as Error).message}`)
    }
  }

  private async mountBranch(branch: string, id: string, sourcePath: string | null): Promise<MountedWorkspace> {
    const mount = await this.retry(() => {
      const method = this.client.workspace?.mount
      if (typeof method !== 'function') throw new Error('LayerFS client has no workspace.mount')
      return method.call(this.client.workspace, branch)
    })
    const raw = mount?.path ?? mount?.workspace?.path
    if (typeof raw !== 'string' || raw.length === 0) {
      await this.discardMount(mount, null)
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
    try {
      await fsp.mkdir(staging, { recursive: true })
      if (sourcePath) await mergeTree(sourcePath, staging)
    } catch (error) {
      await this.discardMount(mount, staging)
      throw error
    }
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
    // A fresh LayerFS branch holds no directories, and a write refuses when its
    // parent is missing, so create every parent of a new file first.
    const directories = new Set<string>()
    for (const name of Object.keys(after).sort()) {
      if (after[name] === before[name]) continue
      const parts = name.split('/')
      for (let depth = 1; depth < parts.length; depth += 1) {
        directories.add(parts.slice(0, depth).join('/'))
      }
      const bytes = await fsp.readFile(join(state.path, name))
      // Text travels as text: the simulator's model stores strings, while the
      // live binding accepts both text and bytes.
      const text = bytes.toString('utf8')
      const content = Buffer.from(text, 'utf8').equals(bytes) ? text : bytes
      writes.push({ op: 'write', path: '/' + name, content })
    }
    const mkdirs = [...directories]
      .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0))
      .map(name => ({ op: 'mkdir', path: '/' + name }))
    writes.unshift(...mkdirs)
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
        // The SDK returns `{ text }`; older structural clients returned the
        // text itself or `{ content }`.
        const text = typeof value === 'string'
          ? value
          : (value as { text?: unknown; content?: unknown })?.text ?? (value as { content?: unknown })?.content
        if (typeof text !== 'string') continue
        const target = join(destination, name.replace(/^\/+/, ''))
        await fsp.mkdir(dirname(target), { recursive: true })
        await fsp.writeFile(target, text)
      } catch (error) {
        this.logger?.warn?.(`[auto-research] skipped non-text adopted file ${name}: ${(error as Error).message}`)
      }
    }
  }

  /**
   * The LayerFS home a client was built for, when the SDK exposes it.
   *
   * `project.init` records the project as a directory directly under the home,
   * and it refuses a name that is already there, so this is the one
   * non-mutating existence probe available before any Store call.
   */
  private homeDirectory(): string | null {
    const options = (this.client as { options?: { home?: unknown } }).options
    const home = options?.home
    return typeof home === 'string' && home.length > 0 ? home : null
  }

  /** Whether the project entry exists: true/false, or null when it cannot be told. */
  private async projectInitialized(): Promise<boolean | null> {
    const home = this.homeDirectory()
    if (!home) return null
    try {
      const stat = await fsp.stat(join(home, this.project))
      return stat.isDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      return null
    }
  }

  private async initializeProject(source: string): Promise<void> {
    const project = this.client.project
    if (typeof project?.init !== 'function') {
      throw new Error(
        `LayerFS project ${this.project} is not initialized and the SDK exposes no project.init; initialize it from ${source} first`,
      )
    }
    await this.retry(() => project.init!(source))
    this.logger?.info?.(`[auto-research] initialized LayerFS project ${this.project} from ${source}`)
  }

  /**
   * Create the baseline branch from the project's `main`.
   *
   * A LayerFS home may hold no project yet (a new dsh session, or the first
   * auto-research batch in a checkout). Initializing must come *before* any
   * Store call: on macOS `@dsh-layerfs/host`'s ported binding treats the
   * client's Store as already open once any Store call ran, and Init then
   * tries to open the not-yet-installed Store and refuses `NotFound`. So the
   * project entry is probed on the home directory first, and `project.init`
   * runs only when it is absent.
   *
   * Without a home to probe the fork itself is the probe; a refusal that may
   * mean "not initialized" then gets one `project.init` + fork retry. A
   * project that exists but whose `main` is unusable is reported clearly.
   */
  private async forkBaseline(branch: string, source: string): Promise<void> {
    const fork = (): Promise<unknown> => {
      const method = this.client.branch?.fork
      if (typeof method !== 'function') throw new Error('LayerFS client has no branch.fork')
      return this.retry(() => method.call(this.client.branch, branch, 'main'))
    }
    const initialized = await this.projectInitialized()
    if (initialized === false) await this.initializeProject(source)
    try {
      await fork()
      return
    } catch (error) {
      if (initialized !== null) {
        throw new Error(
          `LayerFS project ${this.project} has no usable main branch: ${(error as Error).message}`,
        )
      }
      if (!mayNeedProjectInit(error)) throw error
      try {
        await this.initializeProject(source)
      } catch (initError) {
        // Another process may have initialized it between the probe and init;
        // anything else leaves `main` unusable, so report both failures.
        if (!isExistingProject(initError)) {
          throw new Error(
            `LayerFS project ${this.project} has no usable main branch: ${(error as Error).message}; project.init(${source}) failed: ${(initError as Error).message}`,
          )
        }
      }
      try {
        await fork()
      } catch (retryError) {
        throw new Error(
          `LayerFS project ${this.project} still has no usable main branch after project.init(${source}): ${(retryError as Error).message}`,
        )
      }
    }
  }

  async baseline(source: string, id: string): Promise<WorkspaceState> {
    const branch = this.branchName(id)
    await this.forkBaseline(branch, source)
    const mounted = await this.mountBranch(branch, id, source)
    const state: WorkspaceState = {
      id,
      backend: this.name,
      path: mounted.path,
      branch,
      handle: mounted.mount,
      sandboxPath: mounted.sandboxPath,
      staging: mounted.staging,
    }
    try {
      if (!mounted.staging && this.syncBaseline) {
        await mergeTree(source, mounted.path)
      }
      if (mounted.staging) {
        // A fresh LayerFS branch starts empty, so every source file is a write.
        state.stagingInventory = {}
        await this.syncStaging(state, `auto-research: baseline ${id}`)
      } else if (this.syncBaseline) {
        await this.retry(() => this.client.workspace!.commit!(mounted.mount, `auto-research: baseline ${id}`))
      }
      return state
    } catch (error) {
      await this.discardMount(mounted.mount, mounted.staging ? mounted.path : null)
      throw error
    }
  }

  async fork(parent: WorkspaceState, id: string): Promise<WorkspaceState> {
    if (!parent?.path) throw new Error('LayerFS branch requires a parent workspace')
    // A restored completed state (or any retained snapshot) is a plain folder
    // with no mounted branch. Forking it means the same thing as a baseline:
    // a fresh branch off `main` carrying that folder's files.
    if (!parent.branch) return this.baseline(parent.path, id)
    const branch = this.branchName(id)
    // A staged parent is a host copy; a cooperative epoch may have skipped
    // recycling it (`_ownsState === false`), so publish its files to the
    // parent branch before the child branch is created. Without this the child
    // would miss every uncommitted file of the epoch.
    if (parent.staging) {
      await this.commit(parent, { message: `auto-research: publish staged parent before fork ${id}` })
    }
    await this.retry(() => this.client.branch!.fork!(branch, parent.branch!))
    const mounted = await this.mountBranch(branch, id, parent.path)
    try {
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
    } catch (error) {
      await this.discardMount(mounted.mount, mounted.staging ? mounted.path : null)
      throw error
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
    try {
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
    } catch (error) {
      await this.discardMount(mounted.mount, mounted.staging ? mounted.path : null)
      throw error
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
    const unmount = (drop: boolean): Promise<unknown> => this.retry(() => {
      const method = this.client.workspace?.unmount
      if (typeof method !== 'function') return Promise.resolve()
      return method.call(this.client.workspace, state.handle as LayerFSMount, drop)
    })
    try {
      await unmount(discard)
    } catch (error) {
      // A staged (Sandbox-internal) workspace gets its files through
      // `fs.apply`, so its own overlay always differs from its mount base even
      // after the branch holds exactly those bytes. The branch is the record;
      // the sandbox overlay is dropped rather than refusing to unmount.
      if (discard || !state.staging || refusalCode(error) !== 'Dirty') throw error
      this.logger?.warn?.('[auto-research] staged workspace overlay differs from its published branch; unmounting with discard')
      await unmount(true)
    }
  }

  async close(): Promise<void> {
    if (!this.ownsClient) return
    // `loadLayerfs` returns a close that releases the SDK client and the
    // environment patch it published, in one place.
    if (this.releaseEnvironment) {
      await this.releaseEnvironment()
      return
    }
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
  'DSH_LAYERFS_STORE_CONTAINER',
  'DSH_LAYERFS_BUNDLE',
  'DSH_LAYERFS_WSL_ENDPOINT',
  'DSH_LAYERFS_TRACE',
  'DSH_LAYERFS_TRACE_STEP',
  'DSH_LAYERFS_TRACE_START',
] as const

/**
 * Names the SDK reads either bare (`LAYERFS_<NAME>`, preferred) or with the
 * `DSH_` prefix. A session publication must win over a stale bare value, so
 * `loadLayerfs` mirrors both names while a client is alive.
 */
const SDK_DEPLOYMENT_NAMES = [
  'HOME',
  'STORE_PATH',
  'DOCKER',
  'IMAGE',
  'VOLUME',
  'DAEMON',
  'CONTAINER_PREFIX',
  'DAEMON_HOST',
  'STORE_CONTAINER',
  'BUNDLE',
  'WSL_ENDPOINT',
  'TRACE',
  'TRACE_STEP',
  'TRACE_START',
] as const

/** Setting field -> `DSH_LAYERFS_*` name, shared by resolution and publication. */
const LAYERFS_SETTING_KEYS = [
  ['project', 'DSH_LAYERFS_PROJECT'],
  ['sdk', 'DSH_LAYERFS_SDK'],
  ['operator', 'DSH_LAYERFS_OPERATOR'],
  ['cli', 'DSH_LAYERFS_CLI'],
  ['skill', 'DSH_LAYERFS_SKILL'],
  ['home', 'DSH_LAYERFS_HOME'],
  ['storePath', 'DSH_LAYERFS_STORE_PATH'],
  ['docker', 'DSH_LAYERFS_DOCKER'],
  ['image', 'DSH_LAYERFS_IMAGE'],
  ['volume', 'DSH_LAYERFS_VOLUME'],
  ['daemon', 'DSH_LAYERFS_DAEMON'],
  ['containerPrefix', 'DSH_LAYERFS_CONTAINER_PREFIX'],
  ['daemonHost', 'DSH_LAYERFS_DAEMON_HOST'],
  ['storeContainer', 'DSH_LAYERFS_STORE_CONTAINER'],
  ['bundle', 'DSH_LAYERFS_BUNDLE'],
  ['wslEndpoint', 'DSH_LAYERFS_WSL_ENDPOINT'],
  ['trace', 'DSH_LAYERFS_TRACE'],
  ['traceStep', 'DSH_LAYERFS_TRACE_STEP'],
  ['traceStart', 'DSH_LAYERFS_TRACE_START'],
] as const satisfies ReadonlyArray<readonly [keyof LayerFSSettings, string]>

/**
 * Resolve LayerFS deployment settings from explicit config or the session's
 * `DSH_LAYERFS_*` environment (the same names `ctx.shellEnv` exposes).
 *
 * An explicitly configured field always wins, including an explicit `null`;
 * the session environment only fills the fields the config leaves undefined.
 * Returns null when no project or SDK is configured.
 */
export function resolveLayerfsConfig(
  env: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
  explicit: LayerFSBinding | false | null | undefined = undefined,
): LayerFSSettings | null {
  if (explicit === false) return null
  const extra: LayerFSBinding = explicit && typeof explicit === 'object' ? explicit : {}
  const read = (key: string): string | undefined => {
    const value = env[key]
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const pick = (field: keyof LayerFSBinding, envKey: string): string | null => {
    const value = extra[field]
    if (value !== undefined) return typeof value === 'string' && value.length > 0 ? value : null
    return read(envKey) ?? null
  }
  const project = pick('project', 'DSH_LAYERFS_PROJECT')
  const sdk = pick('sdk', 'DSH_LAYERFS_SDK')
  if (!project || !sdk) return null
  const settings: LayerFSSettings = {
    project,
    sdk,
    operator: pick('operator', 'DSH_LAYERFS_OPERATOR'),
    cli: pick('cli', 'DSH_LAYERFS_CLI'),
    skill: pick('skill', 'DSH_LAYERFS_SKILL'),
    storePath: pick('storePath', 'DSH_LAYERFS_STORE_PATH'),
    home: pick('home', 'DSH_LAYERFS_HOME'),
    trace: pick('trace', 'DSH_LAYERFS_TRACE'),
    traceStep: pick('traceStep', 'DSH_LAYERFS_TRACE_STEP'),
    docker: pick('docker', 'DSH_LAYERFS_DOCKER'),
    image: pick('image', 'DSH_LAYERFS_IMAGE'),
    volume: pick('volume', 'DSH_LAYERFS_VOLUME'),
    daemon: pick('daemon', 'DSH_LAYERFS_DAEMON'),
    containerPrefix: pick('containerPrefix', 'DSH_LAYERFS_CONTAINER_PREFIX'),
    daemonHost: pick('daemonHost', 'DSH_LAYERFS_DAEMON_HOST'),
    storeContainer: pick('storeContainer', 'DSH_LAYERFS_STORE_CONTAINER'),
    bundle: pick('bundle', 'DSH_LAYERFS_BUNDLE'),
    wslEndpoint: pick('wslEndpoint', 'DSH_LAYERFS_WSL_ENDPOINT'),
    traceStart: pick('traceStart', 'DSH_LAYERFS_TRACE_START'),
    syncBaseline: extra.syncBaseline ?? true,
  }
  return settings
}

/**
 * Build the non-secret `DSH_LAYERFS_*` environment handed to workers.
 *
 * Ambient session values seed the result, then resolved settings overwrite
 * every non-empty field so an explicit `config.layerfs` binding wins. The
 * optional `explicit` binding is applied last, which also lets an explicit
 * `null` suppress an ambient value.
 */
export function layerfsEnvironment(
  env: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
  settings: LayerFSSettings | null = null,
  explicit: LayerFSBinding | false | null | undefined = undefined,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of LAYERFS_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) result[key] = value
  }
  if (settings) {
    for (const [field, key] of LAYERFS_SETTING_KEYS) {
      const value = settings[field]
      if (typeof value === 'string' && value.length > 0) result[key] = value
    }
  }
  if (explicit && typeof explicit === 'object') {
    for (const [field, key] of LAYERFS_SETTING_KEYS) {
      const value = explicit[field]
      if (value === undefined) continue
      if (typeof value === 'string' && value.length > 0) result[key] = value
      else delete result[key]
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
  // A Cordis context throws when an un-injected service is read as a
  // property, so `get(name)` is the only safe lookup; the property form is a
  // fallback for host snapshots that ignore `inject`.
  let service: PluginContext['shellEnv']
  if (typeof ctx.get === 'function') {
    try {
      service = ctx.get('shellEnv') as PluginContext['shellEnv']
    } catch {
      service = undefined
    }
  }
  if (!service) {
    try {
      service = ctx.shellEnv
    } catch {
      service = undefined
    }
  }
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

/**
 * Deployment values as the `DSH_LAYERFS_*` environment `@dsh-layerfs/host`
 * publishes for a session, keyed without the prefix.
 */
export function layerfsDeployment(settings: LayerFSSettings): Record<string, string> {
  const values: Record<string, string | null | undefined> = {
    PROJECT: settings.project,
    SDK: settings.sdk,
    OPERATOR: settings.operator,
    CLI: settings.cli,
    SKILL: settings.skill,
    HOME: settings.home,
    STORE_PATH: settings.storePath,
    DOCKER: settings.docker,
    IMAGE: settings.image,
    VOLUME: settings.volume,
    DAEMON: settings.daemon,
    CONTAINER_PREFIX: settings.containerPrefix,
    DAEMON_HOST: settings.daemonHost,
    STORE_CONTAINER: settings.storeContainer,
    BUNDLE: settings.bundle,
    WSL_ENDPOINT: settings.wslEndpoint,
    TRACE: settings.trace,
    TRACE_STEP: settings.traceStep,
    TRACE_START: settings.traceStart,
  }
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string' && value.length > 0) result[name] = value
  }
  return result
}

/** Set `patch` on `target`, returning a function that restores exactly what was there. */
function applyEnvironmentPatch(
  patch: Array<[string, string]>,
  target: NodeJS.ProcessEnv | Record<string, unknown>,
): () => void {
  const saved = new Map<string, string | undefined>()
  for (const [key, value] of patch) {
    if (!saved.has(key)) saved.set(key, typeof target[key] === 'string' ? target[key] as string : undefined)
    target[key] = value
  }
  let restored = false
  return () => {
    if (restored) return
    restored = true
    for (const [key, previous] of saved) {
      if (previous === undefined) delete target[key]
      else target[key] = previous
    }
  }
}

/**
 * Publish one session's LayerFS binding on `process.env` until the returned
 * function runs.
 *
 * The SDK constructor, its ported entry (`@dsh-layerfs/host/src/port/sdk.js`,
 * which reads `DSH_LAYERFS_BUNDLE` at import time) and its ported native
 * binding (`.../port/binding.js`, which reads `DSH_LAYERFS_STORE_CONTAINER`
 * and `DSH_LAYERFS_BUNDLE` on every call) all take deployment settings from
 * the process environment. A `dsh` session publishes them through
 * `ctx.shellEnv` instead, so they have to be mirrored here — and kept until
 * the client closes, never only around construction. Both the `DSH_LAYERFS_`
 * and the bare `LAYERFS_` spelling are set, because the SDK prefers the bare
 * one and a stale bare value would otherwise silently win.
 */
export function applyLayerfsEnvironment(
  settings: LayerFSSettings,
  target: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
): () => void {
  const deployment = layerfsDeployment(settings)
  const patch: Array<[string, string]> = []
  for (const [name, value] of Object.entries(deployment)) {
    patch.push([`DSH_LAYERFS_${name}`, value])
    if ((SDK_DEPLOYMENT_NAMES as readonly string[]).includes(name)) patch.push([`LAYERFS_${name}`, value])
  }
  return applyEnvironmentPatch(patch, target)
}

/**
 * Import the LayerFS SDK and construct its client and optional operator.
 *
 * The resolved binding is published on `process.env` for the whole lifetime
 * of the returned client (release it with `close`), because the ported macOS
 * SDK reads its Store container and bundle from the environment at import
 * time and on every call.
 */
export async function loadLayerfs(
  settings: LayerFSSettings,
): Promise<{ client: LayerFSClient; operator: unknown; close: () => Promise<void> }> {
  const nativeBefore = process.env.LAYERFS_NATIVE
  const releaseSettings = applyLayerfsEnvironment(settings)
  const release = (): void => {
    releaseSettings()
    // The SDK entry chose its own native binding at import time; put the
    // process back exactly as it was before this client.
    if (nativeBefore === undefined) delete process.env.LAYERFS_NATIVE
    else process.env.LAYERFS_NATIVE = nativeBefore
  }
  try {
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
    // The SDK snapshots deployment from the environment when constructed; the
    // client's own options stay authoritative for later calls, so normalise
    // them as well (a host-injected client has none).
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
        storeContainer: settings.storeContainer,
        bundle: settings.bundle,
        wslEndpoint: settings.wslEndpoint,
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
    const close = async (): Promise<void> => {
      try {
        await client.close?.()
      } finally {
        release()
      }
    }
    return { client, operator, close }
  } catch (error) {
    release()
    throw error
  }
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
  // `config.layerfs: false` is an explicit opt-out: it must win over a
  // host-injected binding and over ambient DSH_LAYERFS_* variables.
  if (config.layerfs === false) {
    return new WorkspaceManager(new SnapshotBackend({ output, runId }), { output })
  }
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
      releaseEnvironment: loaded.close,
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
