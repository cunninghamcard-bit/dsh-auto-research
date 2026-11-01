/**
 * Shared types for `dsh-auto-research`.
 *
 * The plugin is intentionally dependency-free: instead of importing the
 * (private) `dsh` type packages it declares the small structural subset of the
 * Cordis host surface it uses. That keeps the published bundle installable in
 * any harness version that implements the same seams.
 */
/** Numeric optimization direction declared by the model-written plan. */
export type Direction = 'maximize' | 'minimize';
/** Which half of a batch a branch belongs to. */
export type Phase = 'explore' | 'continue';
/** One fixed metric definition from `plan.metrics`. */
export interface MetricDefinition {
    name: string;
    definition?: string;
    optional?: boolean;
    [key: string]: unknown;
}
/** A metric used only for ranking evaluated candidates. */
export interface SelectionMetric {
    name: string;
    direction: Direction;
}
/** One diagnostic summary rendered in the dashboard and RSI-top views. */
export interface MetricDiagnostic {
    name: string;
    observations: number;
    missing_observations: number;
    distinct_values: number;
    constant_in_observed_checkpoints: boolean;
}
/** One randomized RSI-top metric projection handed to a worker. */
export interface MetricView {
    definitions: MetricDefinition[];
    diagnostics: MetricDiagnostic[];
    rows: Array<{
        id: string;
        parent: string | null;
        workspace: string;
        metrics: Record<string, unknown>;
    }>;
}
/** Batch budgets. Plan-level `options` may override plugin configuration. */
export interface ResearchOptions {
    rounds: number;
    branches: number;
    explorationMinutes: number;
    exploitationMinutes: number;
    rsiTop: boolean;
    forkAndFlush: boolean;
    shareContext: boolean;
    sharingIntervalMinutes: number;
}
/** Subset of {@link ResearchOptions} a plan may override. */
export type PlanOptions = Partial<ResearchOptions>;
/** Raw plan object as written by the coordinator (before validation). */
export interface ResearchPlanInput {
    objective?: unknown;
    worker_prompt?: unknown;
    evaluator?: unknown;
    evaluation_seconds?: unknown;
    direction?: unknown;
    metrics?: unknown;
    selection_metrics?: unknown;
    stall_seconds?: unknown;
    metric_subset?: unknown;
    portfolio_size?: unknown;
    meaningful_gain?: unknown;
    workspace?: unknown;
    evaluator_interpreter?: unknown;
    options?: unknown;
    [key: string]: unknown;
}
/** Validated, normalized plan used by the runner. */
export interface ResearchPlan {
    objective: string;
    worker_prompt: string;
    evaluator: string;
    evaluation_seconds: number;
    direction: Direction;
    metrics: MetricDefinition[];
    selection_metrics: SelectionMetric[];
    stall_seconds: number | null;
    metric_subset: number;
    portfolio_size: number;
    meaningful_gain: number;
    workspace?: string;
    evaluator_interpreter?: string | string[];
    options?: PlanOptions;
    [key: string]: unknown;
}
/** Numeric observation returned by the frozen evaluator. */
export interface EvaluationResult {
    valid: boolean;
    reason?: string;
    score?: number | string;
    metrics?: Record<string, number | string>;
    evidence?: Record<string, string>;
    workspace_manifest_sha256?: string;
    exit_code?: number | null;
}
/** Transport-level outcome of the underlying worker CLI. */
export interface ProviderOutcome {
    completed: boolean;
    provider_session: string | null;
    terminal: string | null;
    diagnostic_count: number;
}
/** Evidence captured by `SHARED_CHECKPOINT.json` plus discovered files. */
export interface SharedCheckpoint {
    summary: string;
    files: Record<string, SharedEvidenceFile>;
}
/** One verbatim evidence file published to peers. */
export interface SharedEvidenceFile {
    sha256: string;
    text: string;
}
/** Live workspace handle owned by a backend. */
export interface WorkspaceState {
    id: string;
    backend: string;
    path: string;
    branch: string | null;
    handle?: LayerFSMount | null;
    /** Sandbox-internal path when the mount is not host-accessible. */
    sandboxPath?: string | null;
    /** Host staging directory used to bridge a Sandbox mount. */
    staging?: boolean;
    /** Inventory captured when the staging directory was created. */
    stagingInventory?: Record<string, string>;
    [key: string]: unknown;
}
/** One branch or baseline in the trajectory. */
export interface TrajectoryRow {
    id: string;
    parent: string | null;
    phase?: Phase;
    collaborator?: number;
    workspace: string;
    provider_session?: string | null;
    exit_code?: number | null;
    timed_out?: boolean;
    completed?: boolean;
    provider_outcome?: ProviderOutcome;
    time?: number;
    evaluation: EvaluationResult;
    diagnostic?: string;
    portfolio_sha256?: string;
    peer_review_sha256?: string;
    peer_manifest_sha256?: string;
    shared_checkpoint?: SharedCheckpoint;
    collaboration_failed?: boolean;
    retained_completed_id?: string;
    incomplete_successor?: string;
    pending_workspace?: string;
    completed_state_sha256?: string;
    last_output?: string | null;
    handoff_path?: string;
    /** Internal live handles; never serialized by `publicRow`. */
    _state?: WorkspaceState | null;
    _ownsState?: boolean;
    _released?: boolean;
}
/** One completed-state checkpoint on disk. */
export interface CompletedState {
    row: TrajectoryRow;
    files: Record<string, string>;
    modes: Record<string, number>;
}
/** Result of one complete batch. */
export interface BatchResult {
    status: 'COMPLETED';
    leader: TrajectoryRow;
    workspace_modified: boolean;
    stop_reason: string;
    pending_workspaces: Array<Record<string, unknown>>;
    result_file: string;
    scope: string;
    evaluator_sha256: string | null;
    trajectories: number;
}
/** Prompt content block accepted by the subagent seam. */
export interface ContentBlock {
    type: string;
    text?: string;
    [key: string]: unknown;
}
export type Prompt = string | readonly ContentBlock[];
/** Worker result returned by `activation.result`. */
export interface SubagentResult {
    output?: readonly ContentBlock[] | string | null;
    stopReason?: string;
    diagnostic?: string;
    [key: string]: unknown;
}
/** Live worker activation handle. */
export interface SubagentRun {
    id?: string;
    childId?: string | null;
    result: Promise<SubagentResult>;
    dispose: () => Promise<void>;
}
/** Request passed to the worker provider (contains the branch checkout). */
export interface ResolvedSubagentStartRequest {
    cwd: string;
    prompt: ContentBlock[];
    parent: unknown;
    [key: string]: unknown;
}
/** Specification accepted by `ctx.subagents.startActivation`. */
export interface SubagentActivationSpec {
    provider: string;
    label: string;
    request: ResolvedSubagentStartRequest;
    signal?: AbortSignal;
    delivery: 'caller';
}
/** Structural provider contract used by this bundle. */
export interface SubagentProvider {
    name: string;
    capabilities: Record<string, unknown>;
    inheritsParentContext: boolean;
    start: (request: SubagentStartRequest) => Promise<SubagentRun>;
}
/** Request received by `AutoResearchProvider.start`. */
export interface SubagentStartRequest {
    cwd?: string;
    prompt?: Prompt;
    parent?: unknown;
    signal?: AbortSignal;
    [key: string]: unknown;
}
/** `ctx.subagents` service surface. */
export interface SubagentsService {
    list?: () => string[];
    registerProvider?: (provider: SubagentProvider) => void;
    startActivation: (spec: SubagentActivationSpec) => Promise<SubagentRun>;
    get?: (name: string) => SubagentProvider | null | undefined;
    getProvider?: (name: string) => SubagentProvider | null | undefined;
    providers?: Map<string, SubagentProvider> | Record<string, SubagentProvider>;
    describe?: (name: string) => {
        name?: string;
        inheritsParentContext?: boolean;
    } | null | undefined;
    [key: string]: unknown;
}
/** `ctx.shellEnv` contributors differ across host versions; stay structural. */
export interface ShellEnvService {
    resolve?: (options: {
        agent?: unknown;
    }) => Promise<Record<string, unknown>> | Record<string, unknown>;
    snapshot?: (options?: {
        agent?: unknown;
    }) => Promise<Record<string, unknown>> | Record<string, unknown>;
    /** `dsh` `ShellEnvRegistry.collect(execution)` (the real contributor API). */
    collect?: (execution: {
        agent?: unknown;
        [key: string]: unknown;
    }) => Record<string, unknown>;
    get?: (key: string) => unknown;
    env?: Record<string, unknown>;
    contributors?: unknown;
    sources?: unknown;
    [key: string]: unknown;
}
/** Cordis context subset consumed by the plugin. */
export interface PluginContext {
    subagents: SubagentsService;
    systemPrompt?: {
        getSectionOrder?: (name: string) => number | null | undefined;
        section: (section: {
            name: string;
            order: number;
            interpolate: boolean;
            text: string;
        }) => unknown;
    };
    shellEnv?: ShellEnvService;
    subprocess?: unknown;
    logger?: Logger;
    get?: (name: string) => unknown;
    [key: string]: unknown;
}
/** Minimal logger used by the runner and provider. */
export interface Logger {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
}
/**
 * Explicit LayerFS binding (host-injected client or settings).
 *
 * Every deployment field the SDK reads from `DSH_LAYERFS_*` is accepted here,
 * and an explicitly configured field always wins over an ambient environment
 * value. `null` means "explicitly unset".
 */
export interface LayerFSBinding {
    client?: LayerFSClient;
    operator?: unknown;
    project?: string | null;
    sdk?: string | null;
    operatorPath?: string;
    cli?: string | null;
    skill?: string | null;
    storePath?: string | null;
    home?: string | null;
    trace?: string | null;
    traceStep?: string | null;
    traceStart?: string | null;
    docker?: string | null;
    image?: string | null;
    volume?: string | null;
    daemon?: string | null;
    containerPrefix?: string | null;
    daemonHost?: string | null;
    storeContainer?: string | null;
    bundle?: string | null;
    wslEndpoint?: string | null;
    syncBaseline?: boolean;
    [key: string]: unknown;
}
/** Plugin configuration after defaults are applied. */
export interface Config {
    providerName?: string;
    workerProvider?: string;
    planPath?: string;
    rounds?: number;
    branches?: number;
    explorationMinutes?: number;
    exploitationMinutes?: number;
    rsiTop?: boolean;
    forkAndFlush?: boolean;
    shareContext?: boolean;
    sharingIntervalMinutes?: number;
    /** Explicit workspace backend choice; `auto` is the default resolution. */
    workspaceBackend?: 'auto' | 'layerfs' | 'snapshot';
    layerfs?: LayerFSBinding | false | null;
    workerEnv?: Record<string, unknown>;
    plan?: ResearchPlanInput;
    [key: string]: unknown;
}
/** Plugin configuration with defaults resolved. */
export interface ResolvedConfig {
    providerName: string;
    workerProvider?: string;
    planPath: string;
    rounds: number;
    branches: number;
    explorationMinutes: number;
    exploitationMinutes: number;
    rsiTop: boolean;
    forkAndFlush: boolean;
    shareContext: boolean;
    sharingIntervalMinutes: number;
    workspaceBackend?: 'auto' | 'layerfs' | 'snapshot';
    layerfs?: LayerFSBinding | false | null;
    workerEnv: Record<string, unknown>;
    plan?: ResearchPlanInput;
    [key: string]: unknown;
}
/** A LayerFS Workspace as returned by `workspace.mount`. */
export interface LayerFSMount {
    sandbox: string;
    path: string;
    image?: string;
    workspace?: {
        path?: string;
    };
    [key: string]: unknown;
}
/** Structural LayerFS SDK client (the real `@layerfs/sdk` satisfies this). */
export interface LayerFSClient {
    project?: {
        init?: (sourcePath: string) => Promise<unknown>;
        [key: string]: unknown;
    };
    branch?: {
        fork?: (name: string, from?: string) => Promise<unknown>;
        [key: string]: unknown;
    };
    workspace?: {
        mount?: (branch: string) => Promise<LayerFSMount>;
        commit?: (workspace: LayerFSMount, message?: string, force?: boolean) => Promise<unknown>;
        unmount?: (workspace: LayerFSMount, discard?: boolean) => Promise<unknown>;
        exec?: (...args: unknown[]) => Promise<unknown>;
        [key: string]: unknown;
    };
    fs?: {
        apply?: (branch: string, changes: unknown[], message?: string) => Promise<unknown>;
        write?: (branch: string, path: string, content: string | Uint8Array, message?: string) => Promise<unknown>;
        rm?: (branch: string, path: string, message?: string) => Promise<unknown>;
        list?: (branch: string, path?: string, pageSize?: number, pagePos?: number) => Promise<unknown>;
        read?: (branch: string, path: string, startLine?: number, endLine?: number) => Promise<unknown>;
        [key: string]: unknown;
    };
    close?: () => Promise<unknown>;
    [key: string]: unknown;
}
/** Resolved `DSH_LAYERFS_*` deployment settings. */
export interface LayerFSSettings {
    project: string;
    sdk: string;
    operator: string | null;
    cli: string | null;
    skill: string | null;
    storePath: string | null;
    home: string | null;
    trace: string | null;
    traceStep: string | null;
    syncBaseline: boolean;
    docker: string | null;
    image: string | null;
    volume: string | null;
    daemon: string | null;
    containerPrefix: string | null;
    /** macOS/Live: the Linux Store container every ported SDK call runs in. */
    storeContainer: string | null;
    /** macOS/Live: the sealed Linux LayerFS build whose SDK `sdk` loads. */
    bundle: string | null;
    /** Windows: private endpoint file of the WSL LayerFS worker. */
    wslEndpoint: string | null;
    /** `1` when the SDK also writes a trace line as each call starts. */
    traceStart: string | null;
    daemonHost: string | null;
}
/** Clock seam used by tests and deterministic runs. */
export interface Clock {
    now: () => number;
    sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}
/** Frozen-evaluator surface used by the runner. */
export interface EvaluatorLike {
    readonly hash: string | null;
    freeze: () => Promise<string>;
    evaluate: (workspace: string, folder: string, options?: {
        deadline?: number;
        signal?: AbortSignal;
        now?: () => number;
    }) => Promise<EvaluationResult>;
}
/** A live branch-worker environment registration. */
export interface WorkerEnvRegistrationLike {
    readonly id: string;
    readonly checkout: string;
    setChildSession: (sessionId: string | null) => void;
    dispose: () => void;
}
/**
 * The provider's registry of live branch-worker environments. The runner
 * registers each branch here so a `dsh` `shellEnv` contributor can resolve the
 * worker's `DSH_AUTO_RESEARCH_*` variables during its own `bash` calls.
 */
export interface WorkerEnvRegistryLike {
    readonly size: number;
    register: (input: {
        id: string;
        checkout: string;
        parentSessionId?: string | null;
        childSessionId?: string | null;
        env?: Record<string, string>;
    }) => WorkerEnvRegistrationLike;
    resolve: (execution: unknown) => Record<string, string>;
    ownsCheckout: (path: string) => boolean;
}
/** Dependency bag for {@link Runner}. */
export interface RunnerDeps {
    subagents: SubagentsService;
    workspaceManager: WorkspaceManagerLike;
    evaluator?: EvaluatorLike;
    initialState?: WorkspaceState;
    parent?: unknown;
    /** Runtime session id of the coordinator, used to match worker shell calls. */
    parentSessionId?: string;
    signal?: AbortSignal;
    workerProvider: string;
    workerEnv?: Record<string, unknown>;
    layerfsEnv?: Record<string, unknown>;
    workerEnvRegistry?: WorkerEnvRegistryLike;
    clock?: Clock;
    rng?: () => number;
    logger?: Logger | null;
    runId?: string;
    [key: string]: unknown;
}
/** Workspace manager facade surface used by the runner. */
export interface WorkspaceManagerLike {
    kind: string;
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
}
//# sourceMappingURL=types.d.ts.map