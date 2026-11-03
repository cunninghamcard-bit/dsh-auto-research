/**
 * `dsh-auto-research-api`: the contract between the auto-research core and its
 * workspace and executor plugins.
 *
 * Types only. Plugins depend on this package and register factories on the
 * two registries the core provides: `ctx.researchWorkspace` and
 * `ctx.researchExecutor`.
 */

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

/** Where branches live: one LayerFS project. */
export interface WorkspaceBackend {
  readonly name: string
  /** The project every branch of this backend belongs to. */
  readonly project: string
  /** Fork `name` from a ref: `main`, a branch name, a commit, or a {@link BranchRef}. */
  fork(from: BranchRef | string, name: string): Promise<BranchRef>
  /** The branch's newest commit. */
  head(branch: string): Promise<BranchRef>
  /** A text file at a commit, or null when it does not exist. */
  readText(ref: BranchRef, path: string): Promise<string | null>
  /** Run a command on a commit inside a Sandbox; nothing is committed. */
  run(ref: BranchRef, options: RunOptions): Promise<ExecutionResult>
  /** Write the commit's tree as a `.tar.gz` under `directory` and return its path. */
  exportTree(ref: BranchRef, directory: string): Promise<string>
  close(): Promise<void>
}

/** What a factory gets for one batch. */
export interface BackendCreateOptions {
  readonly runId: string
  /** The batch's run directory on the host. */
  readonly output: string
  /** The coordinator's `DSH_*` bash variables, from `ctx.shellEnv`: its `DSH_LAYERFS_*` binding. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly logger?: Logger
}

export interface WorkspaceBackendFactory {
  readonly name: string
  /** Higher priorities are tried first when the batch asks for `auto`. */
  readonly priority: number
  /** Null when this backend does not apply to the batch. */
  create(options: BackendCreateOptions): Promise<WorkspaceBackend | null>
}

/** One command on one commit, through an executor. */
export interface ExecutionRequest extends RunOptions {
  readonly ref: BranchRef
  /** The batch's workspace, for reading or running the commit. */
  readonly workspace: WorkspaceBackend
}

/**
 * Where commands run. An executor owns queueing (one request at a time per
 * environment that cannot run two), isolation (a fresh directory per request)
 * and timeouts (the process is stopped, not only abandoned).
 */
export interface ExecutorBackend {
  readonly name: string
  run(request: ExecutionRequest): Promise<ExecutionResult>
  close?(): Promise<void>
}

export interface ExecutorBackendFactory {
  readonly name: string
  readonly priority: number
  create(options: BackendCreateOptions): Promise<ExecutorBackend | null>
}

/** `ctx.researchWorkspace` and `ctx.researchExecutor`. */
export interface BackendRegistry<F> {
  register(factory: F): () => void
  list(): F[]
}

export interface Logger {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

/** `ctx.skills` registration surface. */
export interface SkillsService {
  registerProvider: (factory: (control: { invalidate: () => void; signal: AbortSignal }) => {
    name: string
    list: (options: { cwd?: string; signal?: AbortSignal }) => Promise<unknown>
    get: (candidate: never, options: { cwd?: string; signal?: AbortSignal }) => Promise<unknown>
  }) => unknown
}

/** The Cordis context subset plugin entries use. */
export interface PluginContext {
  provide: (name: string, value: unknown) => unknown
  effect: (callback: () => () => void) => unknown
  inject: (deps: string[], callback: (ctx: PluginContext) => void) => unknown
  researchWorkspace?: BackendRegistry<WorkspaceBackendFactory>
  researchExecutor?: BackendRegistry<ExecutorBackendFactory>
  skills?: SkillsService
  logger?: Logger
  [service: string]: unknown
}
