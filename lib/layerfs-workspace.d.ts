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
import type { Config, LayerFSBinding, LayerFSClient, LayerFSSettings, Logger, PluginContext, TrajectoryRow, WorkspaceManagerLike, WorkspaceState } from './types.js';
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
/**
 * Snapshot inventory: relative POSIX path -> SHA-256 for every regular,
 * non-omitted file. Symlinks and non-regular entries are rejected instead of
 * being followed, so a snapshot never captures bytes outside the workspace.
 */
export declare function inventory(root: string): Promise<Record<string, string>>;
/** @returns total regular-file bytes represented by `files` under `root`. */
export declare function inventoryBytes(root: string, files: Record<string, string>): Promise<number>;
/** @returns available bytes of the filesystem holding `path` (or its nearest parent). */
export declare function freeBytes(path: string): Promise<number>;
/**
 * Copy `source` into a new `destination`, verifying that no byte changed during
 * the copy. An existing destination is never overwritten.
 */
export declare function snapshot(source: string, destination: string): Promise<Record<string, string>>;
/** Merge `source` into an existing directory (LayerFS baseline / staging copy). */
export declare function mergeTree(source: string, destination: string): Promise<Record<string, string>>;
/** Write JSON through a temporary sibling and an atomic rename. */
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
export declare class SnapshotBackend {
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
    retainCompletedState(row: TrajectoryRow): Promise<string>;
    restoreCompletedState(checkpoint: string, failedRow: TrajectoryRow): Promise<TrajectoryRow>;
}
/** Sanitize a value into a Docker/LayerFS-safe name fragment. */
export declare function branchSafe(value: unknown, max?: number): string;
/**
 * Retry a LayerFS call that refused with `Busy`, using exponential backoff.
 * All other refusals propagate unchanged.
 */
export declare function withBusyRetry<T>(fn: () => Promise<T>, options?: {
    retries?: number;
    baseDelayMs?: number;
    delay?: (milliseconds: number) => Promise<void>;
}): Promise<T>;
/**
 * LayerFS copy-on-write branch backend.
 *
 * `ownsClient` is false whenever the client was injected by the host (for
 * example `ctx.layerfs.client`), so `close()` never tears down a shared client.
 */
export declare class LayerFSBackend {
    readonly name = "layerfs";
    readonly client: LayerFSClient;
    readonly operator: unknown;
    readonly project: string;
    readonly output: string;
    readonly runId: string;
    readonly logger: Logger | null;
    readonly syncBaseline: boolean;
    readonly ownsClient: boolean;
    readonly retryBaseDelayMs: number;
    constructor(options: {
        client: LayerFSClient;
        operator?: unknown;
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
    private mountBranch;
    private syncStaging;
    private materializeBranch;
    baseline(source: string, id: string): Promise<WorkspaceState>;
    fork(parent: WorkspaceState, id: string): Promise<WorkspaceState>;
    adopt(branch: string, id: string): Promise<WorkspaceState>;
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
    readonly backend: {
        name: string;
        baseline: (source: string, id: string) => Promise<WorkspaceState>;
        fork: (parent: WorkspaceState, id: string) => Promise<WorkspaceState>;
        adopt?: (branch: string, id: string) => Promise<WorkspaceState>;
        commit: (state: WorkspaceState, options?: {
            message?: string;
        }) => Promise<void>;
        release: (state: WorkspaceState, options?: {
            discard?: boolean;
        }) => Promise<void>;
        retainCompletedState: (row: TrajectoryRow) => Promise<string>;
        restoreCompletedState: (checkpoint: string, failedRow: TrajectoryRow) => Promise<TrajectoryRow>;
        close?: () => Promise<void>;
    };
    readonly output: string | undefined;
    constructor(backend: WorkspaceManager['backend'], { output }?: {
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
    close(): Promise<void>;
}
/** Every `DSH_LAYERFS_*` name a `dsh` session may publish. */
export declare const LAYERFS_ENV_KEYS: readonly ['DSH_LAYERFS_PROJECT', 'DSH_LAYERFS_SDK', 'DSH_LAYERFS_OPERATOR', 'DSH_LAYERFS_CLI', 'DSH_LAYERFS_SKILL', 'DSH_LAYERFS_HOME', 'DSH_LAYERFS_STORE_PATH', 'DSH_LAYERFS_DOCKER', 'DSH_LAYERFS_IMAGE', 'DSH_LAYERFS_VOLUME', 'DSH_LAYERFS_DAEMON', 'DSH_LAYERFS_CONTAINER_PREFIX', 'DSH_LAYERFS_DAEMON_HOST', 'DSH_LAYERFS_TRACE', 'DSH_LAYERFS_TRACE_STEP'];
/**
 * Resolve LayerFS deployment settings from explicit config or the session's
 * `DSH_LAYERFS_*` environment (the same names `ctx.shellEnv` exposes).
 * Returns null when no project or SDK is configured.
 */
export declare function resolveLayerfsConfig(env?: NodeJS.ProcessEnv | Record<string, unknown>, explicit?: LayerFSBinding | false | undefined): LayerFSSettings | null;
/**
 * Build the non-secret `DSH_LAYERFS_*` environment handed to workers.
 * Values already present in the session environment win over normalized
 * defaults so a host integration keeps its exact binding.
 */
export declare function layerfsEnvironment(env?: NodeJS.ProcessEnv | Record<string, unknown>, settings?: LayerFSSettings | null): Record<string, string>;
/**
 * Resolve the environment contributed by `ctx.shellEnv` (the same service
 * `@dsh-layerfs/host` binds). Host versions expose contributors, `resolve`,
 * `snapshot` or a plain `env`; all shapes are handled and merged.
 */
export declare function resolveShellEnvironment(ctx: Pick<PluginContext, 'shellEnv' | 'get'>, agent?: unknown): Promise<Record<string, string>>;
/** Import the LayerFS SDK and construct its client and optional operator. */
export declare function loadLayerfs(settings: LayerFSSettings): Promise<{
    client: LayerFSClient;
    operator: unknown;
}>;
/**
 * Build the workspace manager, preferring LayerFS when bound.
 */
export declare function createWorkspaceManager({ output, runId, config, env, layerfs, }: {
    output: string;
    runId: string;
    config?: Config;
    env?: NodeJS.ProcessEnv | Record<string, unknown>;
    layerfs?: LayerFSBinding;
}): Promise<WorkspaceManager>;
/**
 * Resolve the optional compact research seed named by `plan.workspace`.
 * It must be a regular, symlink-free subdirectory inside `root`.
 */
export declare function selectPlanWorkspace(root: string, plan: {
    workspace?: unknown;
}): Promise<string>;
//# sourceMappingURL=layerfs-workspace.d.ts.map