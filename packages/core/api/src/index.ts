/**
 * `dsh-auto-research-api`: the contract between the auto-research core and
 * its plugins, plus the skill registration every prompt package shares.
 *
 * - `ctx.researchWorkspace` ({@link WorkspaceService}): where branches live.
 *   `dsh-auto-research-workspace-layerfs` provides it.
 * - `ctx.researchExecutor` ({@link BackendRegistry} of executor factories):
 *   where commands run. The core provides the registry; the LayerFS Sandbox
 *   and Colab plugins register on it.
 * - `ctx.researchWorkers` ({@link WorkersService}): which sessions are running
 *   branch workers. The core provides it; the worker prompt package reads it.
 */

export { registerSkillDirectory } from './skills.js'

/** `promise`, or a rejection with the abort reason once `signal` aborts; the work itself goes on. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolveWait, reject) => {
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolveWait, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
export type { SkillsService } from './skills.js'

/** One branch at one commit. The runner holds this value, never a host path. */
export interface BranchRef {
  readonly branch: string
  /** Newest commit, or null for a branch forked from `main` with no commit yet. */
  readonly commit: string | null
  /** The `main` layer the branch is based on. */
  readonly base: string
}

/** A file placed next to the branch tree for one run; it is never committed. */
export interface RunFile {
  /** Relative path inside the run directory. */
  readonly name: string
  readonly text: string
}

/** One command against one commit. */
export interface RunOptions {
  /** Extra files for this run only, such as the evaluator script. */
  readonly files?: readonly RunFile[]
  /** Command run in the branch root. */
  readonly argv: readonly string[]
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

/** What one command returned. */
export interface ExecutionResult {
  readonly code: number | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
  /** Where it ran, such as `layerfs` or `colab:H100`; recorded with every score. */
  readonly environment: string
}

/** The branches of one batch: one LayerFS project. */
export interface Workspace {
  /** The project every branch belongs to. */
  readonly project: string
  /** Fork `name` from a ref: `main`, a branch name, a commit, or a {@link BranchRef}. */
  fork(from: BranchRef | string, name: string): Promise<BranchRef>
  /** The branch's newest commit. */
  head(branch: string): Promise<BranchRef>
  /** How a worker reaches and changes `ref`'s branch; part of the worker's first prompt. */
  describe(ref: BranchRef): string
  /** Write the commit's tree as a `.tar.gz` under `directory` and return its path. */
  exportTree(ref: BranchRef, directory: string): Promise<string>
  close(): Promise<void>
}

/** `ctx.researchWorkspace`. */
export interface WorkspaceService {
  /** The workspace of the coordinator agent `parent`: the LayerFS project its session is bound to. */
  open(parent: unknown, options: { logger?: Logger }): Promise<Workspace>
}

/** One command on one commit, through an executor. */
export interface ExecutionRequest extends RunOptions {
  readonly ref: BranchRef
  /** The batch's workspace, for running or exporting the commit. */
  readonly workspace: Workspace
}

/**
 * Where commands run. An executor owns queueing (one request at a time per
 * environment), isolation (a fresh copy of the commit per request) and
 * timeouts (the process is stopped, not only abandoned). A caller that aborts
 * stops waiting at once; the next request starts only after the command has
 * ended, so it never shares the environment with a leftover run.
 */
export interface ExecutorBackend {
  readonly name: string
  run(request: ExecutionRequest): Promise<ExecutionResult>
  close?(): Promise<void>
}

export interface ExecutorBackendFactory {
  readonly name: string
  /** Higher priorities are tried first when the batch asks for `auto`. */
  readonly priority: number
  /** Null when this executor does not apply to the batch. */
  create(options: { logger?: Logger }): Promise<ExecutorBackend | null>
}

/** `ctx.researchWorkers`. */
export interface WorkersService {
  /** Whether `session` is a branch worker of a running batch. */
  has(session: string): boolean
}

/** `ctx.researchExecutor`. */
export interface BackendRegistry<F> {
  register(factory: F): () => void
  list(): F[]
}

export interface Logger {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

/** The Cordis context subset plugin entries use. */
export interface PluginContext {
  provide: (name: string, value: unknown) => unknown
  effect: (callback: () => () => void) => unknown
  inject: (deps: string[], callback: (ctx: PluginContext) => void) => unknown
  researchWorkspace?: WorkspaceService
  researchExecutor?: BackendRegistry<ExecutorBackendFactory>
  researchWorkers?: WorkersService
  logger?: Logger
  [service: string]: unknown
}
