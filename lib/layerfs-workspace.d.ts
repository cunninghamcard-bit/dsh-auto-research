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
import type { LayerFSBinding, LayerFSClient, LayerFSSettings, Logger, ShellEnvService, Reconciliation, TrajectoryRow, WorkspaceBackend, WorkspaceBackendCreateOptions, WorkspaceBackendFactory, WorkspaceManagerLike, WorkspaceState } from './types.js';
/** Harness and provider state that never enters an inventory or a branch. */
export declare const OMIT: Set<string>;
/** @returns the lowercase hexadecimal SHA-256 of `data`. */
export declare function sha256(data: string | Uint8Array): string;
/** @returns the SHA-256 of one file, streamed in 1 MiB blocks. */
export declare function digestFile(path: string): Promise<string>;
/** Deterministic JSON (sorted object keys at every depth). */
export declare function canonicalJson(value: unknown): string;
/** @returns the SHA-256 of the canonical JSON encoding of `value`. */
export declare function jsonDigest(value: unknown): string;
/** Deep JSON equality through canonical encoding. */
export declare function jsonEqual(a: unknown, b: unknown): boolean;
/** Whether `target` is `root` or strictly inside it. */
export declare function isContained(root: string, target: string): boolean;
/** @returns the path relative to `root`, using POSIX separators. */
export declare function relativePosix(root: string, target: string): string;
/** Manifest value prefix for a symlink: `symlink:<link text>`. */
export declare const SYMLINK = "symlink:";
/** @returns whether a manifest value records a symlink rather than a content hash. */
export declare function isLinkEntry(value: string | undefined): boolean;
/**
 * Snapshot inventory: relative POSIX path -> SHA-256 for every regular,
 * non-omitted file, and `symlink:<link text>` for every symlink. Links are
 * recorded, never followed, so a snapshot never captures bytes outside the
 * workspace. Other non-regular entries are rejected.
 */
export declare function inventory(root: string): Promise<Record<string, string>>;
/** @returns total regular-file bytes represented by `files` under `root`. */
export declare function inventoryBytes(root: string, files: Record<string, string>): Promise<number>;
/** @returns the sorted paths whose manifest value differs between `before` and `after`. */
export declare function changedPaths(before: Record<string, string>, after: Record<string, string>): string[];
/** @returns the bytes of `count` full host copies of the tree at `path`. */
export declare function hostCopyBytes(path: string, count: number): Promise<number>;
/** @returns available bytes of the filesystem holding `path` (or its nearest parent). */
export declare function freeBytes(path: string): Promise<number>;
/**
 * Copy `source` into a new `destination`, verifying that no byte changed during
 * the copy. An existing destination is never overwritten.
 */
export declare function snapshot(source: string, destination: string): Promise<Record<string, string>>;
/** Merge `source` into an existing directory (LayerFS baseline / staging copy). */
export declare function mergeTree(source: string, destination: string): Promise<Record<string, string>>;
/** Write JSON through a unique temporary sibling and an atomic rename. */
export declare function writeJsonAtomic(path: string, value: unknown): Promise<void>;
/** Strip live handles from a row before it is serialized. */
export declare function publicRow(row: TrajectoryRow): TrajectoryRow;
/**
 * Store every distinct completed file once in `checkpoint-objects` and record a
 * checkpoint manifest for later restoration.
 *
 * @returns checkpoint path
 */
export declare function retainCompletedState(output: string, row: TrajectoryRow): Promise<string>;
/**
 * Restore an independently evaluated completed state into a separate retained
 * directory when its mutable successor is incomplete.
 *
 * @returns the restored row
 */
export declare function restoreCompletedState(output: string, checkpoint: string, failedRow: TrajectoryRow): Promise<TrajectoryRow>;
/** Full-copy branch backend used when no LayerFS project is bound. */
export declare class SnapshotBackend implements WorkspaceBackend {
    readonly name = "snapshot";
    readonly output: string;
    readonly runId: string;
    constructor({ output, runId }: {
        output: string;
        runId?: string;
    });
    baseline(source: string, id: string): Promise<WorkspaceState>;
    fork(parent: WorkspaceState, id: string): Promise<WorkspaceState>;
    commit(): Promise<void>;
    release(): Promise<void>;
    estimateForkBytes(parent: WorkspaceState, count: number): Promise<number>;
    retainCompletedState(row: TrajectoryRow): Promise<string>;
    restoreCompletedState(checkpoint: string, failedRow: TrajectoryRow): Promise<TrajectoryRow>;
}
/** Sanitize a value into a Docker/LayerFS-safe name fragment. */
export declare function branchSafe(value: unknown, max?: number): string;
/**
 * Whether `fs.read` refused a file because it is not UTF-8 text (`Binary`).
 *
 * A binary adopted file has no text representation to stage, but it is not a
 * lost file: `workspace.exec` can copy the exact bytes, or the file is reported
 * as skipped and never removed from the branch.
 */
export declare function isSkippableAdoptedFile(error: unknown): boolean;
/**
 * Whether a commit/unmount refusal of a staged mount only means its overlay
 * differs from the branch it was published to.
 *
 * `fs.apply` writes the branch directly, so the mount's own overlay then
 * disagrees with the moved head: `workspace.commit` refuses with `Conflict`
 * and `workspace.unmount` with `Dirty`. The bytes are already on the branch.
 */
export declare function isStaleMountRefusal(error: unknown): boolean;
/**
 * Whether a LayerFS call failed for a reason that a short retry can fix.
 *
 * Two families are transient:
 * - `Busy`: another writer holds the Store/branch.
 * - Sandbox daemon / Store container startup: on OrbStack the published port
 *   starts accepting connections about half a second after `docker start`, so
 *   the first mount or Store call can be refused while the daemon is still
 *   binding. There is no user-visible failure to act on, only a delay.
 */
export declare function isTransientLayerfsError(error: unknown): boolean;
/**
 * Retry a LayerFS call that refused for a transient reason, using exponential
 * backoff. An OrbStack Sandbox daemon publishes its port about half a second
 * after the container starts, so the default budget (6 retries, ~9.5 s of
 * backoff) covers a real cold start while still failing loud.
 */
export declare function withBusyRetry<T>(fn: () => Promise<T>, options?: {
    retries?: number;
    baseDelayMs?: number;
    delay?: (milliseconds: number) => Promise<void>;
}): Promise<T>;
/**
 * LayerFS copy-on-write branch backend (`@layerfs/agent` 1.1).
 *
 * Every Workspace mounts in a Sandbox this backend made with
 * `sandbox.create()`; a Sandbox that closed itself or holds 16 Workspaces is
 * replaced on the next mount. `ownsClient` is false whenever the client was
 * injected by the host (for example `config.layerfs.client`), so `close()`
 * never tears down a shared client.
 */
export declare class LayerFSBackend implements WorkspaceBackend {
    readonly name = "layerfs";
    readonly client: LayerFSClient;
    readonly project: string;
    readonly output: string;
    readonly runId: string;
    readonly logger: Logger | null;
    readonly syncBaseline: boolean;
    readonly ownsClient: boolean;
    readonly retryBaseDelayMs: number;
    /** The Sandbox new Workspaces mount in, shared by concurrent mounts. */
    private sandbox;
    constructor(options: {
        client: LayerFSClient;
        project?: string;
        output: string;
        runId?: string;
        logger?: Logger | null;
        syncBaseline?: boolean;
        ownsClient?: boolean;
        retryBaseDelayMs?: number;
    });
    /** @returns a branch name that always fits Docker's 63-character limit. */
    branchName(id: string): string;
    retry<T>(fn: () => Promise<T>): Promise<T>;
    /**
     * Mount `branch` in this backend's Sandbox. A Sandbox closes itself two
     * minutes after its last Workspace, and holds at most 16: either refusal
     * makes one new Sandbox and one more mount.
     */
    private mount;
    /**
     * Unmount a workspace whose preparation failed and remove any host staging
     * copy. Cleanup failures are logged, never allowed to mask the original
     * error.
     */
    private discardMount;
    /**
     * Remount a staged branch after its HEAD moved (baseline publish / Sandbox
     * commit), so the Sandbox view and the host staging copy describe the same
     * branch state.
     */
    private remountStaging;
    private mountBranch;
    private syncStaging;
    private materializeBranch;
    /**
     * Read one branch file completely.
     *
     * `fs.read` returns at most 2000 lines / 48 KiB per call and reports the next
     * `nextLine` cursor; a single call would truncate a large adopted file.
     */
    private readBranchFile;
    /** Create the baseline branch from the project's `main`. */
    private forkBaseline;
    baseline(source: string, id: string, { sync }?: {
        sync?: boolean;
    }): Promise<WorkspaceState>;
    fork(parent: WorkspaceState, id: string): Promise<WorkspaceState>;
    adopt(branch: string, id: string): Promise<WorkspaceState>;
    /**
     * Settle a staged branch's two writable views before evaluation.
     *
     * The host staging copy is the authoritative writer; the Sandbox mount at
     * `/workspaces/<n>` is for execution. A worker that edits the Sandbox anyway
     * leaves changes in its Workspace. This commits them into the branch
     * history first, whatever the host did, so they are never dropped, then
     * compares both sides with the inventory the staging copy started from:
     *
     * - neither changed: `unchanged`
     * - Sandbox only: fold the branch into the host copy, `folded`
     * - host only: `host`; `commit()` publishes it
     * - both: `conflict`; the host diff is still published by `commit()`, so
     *   both sides stay in the branch history, and the row is invalid because
     *   the evaluated host copy is not the branch state.
     */
    reconcile(state: WorkspaceState): Promise<Reconciliation>;
    /**
     * Commit a changed Sandbox Workspace and report what the branch now holds
     * that the staging copy did not start from.
     *
     * @returns null when the Sandbox's daemon reports the Workspace unchanged and
     *   its branch head unmoved; otherwise the changed paths and a materialized
     *   copy of the branch (the caller removes `directory`).
     */
    private sandboxChanges;
    /**
     * A host-accessible LayerFS mount is copy-on-write and adds nothing up
     * front; a staged mount (or a non-LayerFS parent) is copied to the host.
     */
    estimateForkBytes(parent: WorkspaceState, count: number): Promise<number>;
    commit(state: WorkspaceState, { message }?: {
        message?: string;
    }): Promise<void>;
    release(state: WorkspaceState, { discard }?: {
        discard?: boolean;
    }): Promise<void>;
    close(): Promise<void>;
    retainCompletedState(row: TrajectoryRow): Promise<string>;
    restoreCompletedState(checkpoint: string, failedRow: TrajectoryRow): Promise<TrajectoryRow>;
}
/** Common facade used by the runner. */
export declare class WorkspaceManager implements WorkspaceManagerLike {
    readonly backend: WorkspaceBackend;
    readonly output: string | undefined;
    constructor(backend: WorkspaceBackend, { output }?: {
        output?: string;
    });
    get kind(): string;
    baseline(source: string, id: string): Promise<WorkspaceState>;
    fork(parent: WorkspaceState, id: string): Promise<WorkspaceState>;
    adopt(branch: string, id: string): Promise<WorkspaceState>;
    commit(state: WorkspaceState, options?: {
        message?: string;
    }): Promise<void>;
    release(state: WorkspaceState, options?: {
        discard?: boolean;
    }): Promise<void>;
    retainCompletedState(row: TrajectoryRow): Promise<string>;
    restoreCompletedState(checkpoint: string, failedRow: TrajectoryRow): Promise<TrajectoryRow>;
    reconcile(state: WorkspaceState): Promise<Reconciliation>;
    estimateForkBytes(parent: WorkspaceState, count: number): Promise<number>;
    close(): Promise<void>;
}
/** Every `DSH_LAYERFS_*` name `@dsh-layerfs/host` publishes for a session. */
export declare const LAYERFS_ENV_KEYS: readonly ['DSH_LAYERFS_PROJECT', 'DSH_LAYERFS_SDK', 'DSH_LAYERFS_BACKEND', 'DSH_LAYERFS_CLI', 'DSH_LAYERFS_SKILL', 'DSH_LAYERFS_HOME', 'DSH_LAYERFS_STORE_PATH', 'DSH_LAYERFS_DOCKER', 'DSH_LAYERFS_IMAGE', 'DSH_LAYERFS_VOLUME', 'DSH_LAYERFS_DAEMON', 'DSH_LAYERFS_CONTAINER_PREFIX', 'DSH_LAYERFS_DAEMON_HOST', 'DSH_LAYERFS_WORKER_ENDPOINT', 'DSH_LAYERFS_TRACE', 'DSH_LAYERFS_TRACE_STEP', 'DSH_LAYERFS_TRACE_START'];
/**
 * Resolve LayerFS deployment settings from explicit config or the session's
 * `DSH_LAYERFS_*` environment (the same names `ctx.shellEnv` exposes).
 *
 * An explicitly configured field always wins, including an explicit `null`;
 * the session environment only fills the fields the config leaves undefined.
 * Returns null when no project or SDK is configured.
 */
export declare function resolveLayerfsConfig(env?: NodeJS.ProcessEnv | Record<string, unknown>, explicit?: LayerFSBinding | false | null | undefined): LayerFSSettings | null;
/**
 * Build the non-secret `DSH_LAYERFS_*` environment handed to workers.
 *
 * Ambient session values seed the result, then resolved settings overwrite
 * every non-empty field so an explicit `config.layerfs` binding wins. The
 * optional `explicit` binding is applied last, which also lets an explicit
 * `null` suppress an ambient value.
 */
export declare function layerfsEnvironment(env?: NodeJS.ProcessEnv | Record<string, unknown>, settings?: LayerFSSettings | null, explicit?: LayerFSBinding | false | null | undefined): Record<string, string>;
/** `DSH_LAYERFS_*` trace keys that describe one call, never a worker. */
export declare const LAYERFS_TRACE_KEYS: readonly ['DSH_LAYERFS_TRACE', 'DSH_LAYERFS_TRACE_STEP', 'DSH_LAYERFS_TRACE_START'];
/**
 * Drop the transient SDK trace keys from a copied environment.
 *
 * The coordinator's `shellEnv` carries `DSH_LAYERFS_TRACE` and a
 * `DSH_LAYERFS_TRACE_STEP` naming *its* call. A worker that inherited those
 * would append its SDK calls to the coordinator's trace file under a stale step
 * id, corrupting both records; the worker's own `ctx.shellEnv` execution sets
 * them correctly instead.
 */
export declare function withoutLayerfsTrace(environment: Record<string, string>): Record<string, string>;
/**
 * The environment `ctx.shellEnv` (`ShellEnvRegistry.collect`) gives a shell
 * call of `agent`. `@dsh-layerfs/host` contributes the session's
 * `DSH_LAYERFS_*` binding here. Contributors read
 * `execution.rootCallId ?? execution.callId`, so both are set.
 */
export declare function resolveShellEnvironment(shellEnv: ShellEnvService | undefined, agent?: unknown): Record<string, string>;
/** The synthetic tool-call id used for a session-wide environment snapshot. */
export declare const SHELL_ENV_CALL_ID = "auto-research-env";
/**
 * Open the session's LayerFS project with the SDK it names.
 *
 * `LayerFS.open` takes no options: it reads its deployment from `LAYERFS_*`
 * once, while the client is made. A `dsh` session publishes the binding as
 * `DSH_LAYERFS_*` through `ctx.shellEnv`, so the names are set on
 * `process.env` around the open and restored right after it.
 */
export declare function loadLayerfs(settings: LayerFSSettings): Promise<LayerFSClient>;
/**
 * Concrete `WorkspaceBackendFactory` for LayerFS copy-on-write branches.
 *
 * Returns `null` when LayerFS is opted out (`config.layerfs: false`) or no
 * LayerFS project/SDK is bound.
 */
export declare class LayerFSWorkspaceFactory implements WorkspaceBackendFactory {
    readonly name = "layerfs";
    readonly priority = 100;
    create({ output, runId, config, env, layerfs, }: WorkspaceBackendCreateOptions): Promise<LayerFSBackend | null>;
}
/**
 * Resolve the optional compact research seed named by `plan.workspace`.
 * It must resolve to a directory strictly inside `root`.
 */
export declare function selectPlanWorkspace(root: string, plan: {
    workspace?: unknown;
}): Promise<string>;
//# sourceMappingURL=layerfs-workspace.d.ts.map