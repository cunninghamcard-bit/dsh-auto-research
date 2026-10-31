/**
 * One complete research Batch.
 *
 * This is the async Node.js port of `ara`'s `Runner`: a frozen evaluator, an
 * initial baseline that must pass before any worker starts, fork-and-flush /
 * RSI-top phase selection, isolated branches, cooperative evidence sharing, and
 * evidence-scored leader selection. Execution is delegated to whatever
 * `ctx.subagents` provider the deployment configures; this module owns
 * accounting and receipts, not scientific judgment.
 */
import { jsonDigest, publicRow } from './layerfs-workspace.js';
import { buildZeroSynthesisContext } from './protocols.js';
import type { BatchResult, Clock, Config, EvaluationResult, MetricDiagnostic, MetricView, Phase, ProviderOutcome, ResearchOptions, ResearchPlan, ResearchPlanInput, RunnerDeps, SharedCheckpoint, SubagentResult, TrajectoryRow, WorkspaceState } from './types.js';
/** Raised when a batch is stopped by the caller; artifacts are retained. */
export declare class ResearchStoppedError extends Error {
    constructor(message?: string);
}
/** Merge plan-level option overrides over plugin configuration. */
export declare function normalizeOptions(config?: Config, plan?: ResearchPlanInput): ResearchOptions;
/**
 * Validate the model-written plan against the execution contract and return
 * normalized defaults. Values are never replaced with repository heuristics.
 */
export declare function validatePlan(plan: unknown, options: ResearchOptions): ResearchPlan;
/** Port of `provider_outcome`: transport diagnostics are not turn failures. */
export declare function providerOutcome(events: unknown[] | undefined, rc: number | null, timedOut: boolean): ProviderOutcome;
/** Extract assistant text from a provider `output` value. */
export declare function outputText(output: SubagentResult['output']): string;
interface PeerSlot {
    id: string;
    parent: string | null;
    phase: Phase | undefined;
    collaborator: number | undefined;
    evaluation: EvaluationResult;
    checkpoint: SharedCheckpoint;
    workspace: string;
    transcript: string;
    notes: string;
}
/** One batch runner. */
export declare class Runner {
    readonly config: Config;
    readonly options: ResearchOptions;
    readonly plan: ResearchPlan;
    readonly workspace: string;
    readonly output: string;
    readonly deps: RunnerDeps;
    readonly manager: RunnerDeps['workspaceManager'];
    readonly subagents: RunnerDeps['subagents'];
    readonly clock: Clock;
    readonly rng: () => number;
    readonly logger: RunnerDeps['logger'];
    readonly workerProvider: string;
    readonly parent: unknown;
    readonly signal: AbortSignal | undefined;
    readonly workerEnv: Record<string, string>;
    readonly evaluator: RunnerDeps['evaluator'] & {
        hash: string | null;
    };
    readonly originalManifest: Record<string, string> | null;
    readonly selectionFile: string | null;
    readonly runId: string;
    readonly rows: TrajectoryRow[];
    readonly selections: Array<Record<string, unknown>>;
    peerBundle: string | null;
    readonly peerSlots: Record<string, PeerSlot>;
    bestTime: number;
    anchor: number | null;
    cancelled: boolean;
    readonly abort: AbortController;
    timedOutRows: TrajectoryRow[];
    readonly abandoned: TrajectoryRow[];
    readonly activeStates: Map<WorkspaceState, {
        id: string;
        parent: string | null;
        workspace: string;
    }>;
    /** Every state a backend created, from the moment it was returned. */
    readonly trackedStates: Map<WorkspaceState, {
        id: string;
        parent: string | null;
        workspace: string;
    }>;
    readonly releasedStates: Set<WorkspaceState>;
    readonly workerGraceMs: number;
    private managerClosed;
    constructor({ config, plan, workspace, output, originalManifest, selectionFile, deps, }: {
        config?: Config;
        plan: unknown;
        workspace: string;
        output: string;
        originalManifest?: Record<string, string> | null;
        selectionFile?: string | null;
        deps: RunnerDeps;
    });
    now(): number;
    sleep(milliseconds: number): Promise<void>;
    stopped(): boolean;
    /** Whether the caller (not a sibling failure) stopped this batch. */
    intentionalStop(): boolean;
    checkCancelled(): void;
    /** Stop scheduling and abort in-flight workers/evaluations. */
    stop(): void;
    signalForWork(): AbortSignal;
    /** Remember a created state so a failed sibling or cohort cannot leak it. */
    private trackState;
    /** Clear the row handles that point at a state whose release succeeded. */
    private markReleased;
    /**
     * Release one state. The handle is retained when the backend refuses, so a
     * later `releaseAll()` can retry and `pendingWorkspaces()` still reports it.
     */
    private releaseTracked;
    /**
     * Await a worker activation, but never past a short grace after its signal
     * aborts. A provider that ignores abort gets disposed and the batch moves on.
     */
    private awaitActivationResult;
    /** Wait for a disposal, but do not let a stuck provider hold the batch. */
    private disposeWithin;
    metricDiagnostics(): MetricDiagnostic[];
    dashboard(): Record<string, unknown>;
    checkDisk(workspace: string, count: number): Promise<void>;
    views(count: number): MetricView[];
    /** Run all branches; one unexpected rejection aborts its siblings. */
    private runBranches;
    run(): Promise<BatchResult>;
    /** Persist the honest cancellation artifact (idempotent). */
    writeStoppedResult(): Promise<Record<string, unknown>>;
    /** Live branches that have not been committed/unmounted yet. */
    pendingWorkspaces(): Array<Record<string, unknown>>;
    private runBatch;
    writeSelection(leader: TrajectoryRow): Promise<void>;
    private peerSlotsOf;
    publishPeers(rows: TrajectoryRow[], folder: string): Promise<string | null>;
    cooperativeCohort(leader: TrajectoryRow, count: number, phase: Phase, roundNumber: number, views: MetricView[]): Promise<TrajectoryRow[]>;
    branch(parent: TrajectoryRow, index: number, phase: Phase, folder: string, view?: MetricView, cooperation?: {
        resume: boolean;
        bundle: string | null;
        deadline: number;
        shareAt: number;
        count: number;
        seconds: number;
        index: number;
        sharedContext: string | null;
    } | null): Promise<TrajectoryRow>;
    choose(incumbent: TrajectoryRow, candidates: TrajectoryRow[]): TrajectoryRow;
    /**
     * Commit and unmount this phase's branches. A completed branch that failed
     * science is preserved as `rejected`, never discarded; only a branch that
     * never completed is treated as unverified. No state is released twice.
     */
    recycle(candidates: TrajectoryRow[], leader: TrajectoryRow): Promise<void>;
    finish(leader: TrajectoryRow, reason?: string, pending?: TrajectoryRow[] | null): Promise<BatchResult>;
    /** Release every mounted workspace at the end of a batch. */
    releaseAll(): Promise<void>;
    /** Keep an unverified workspace available for independent review. */
    preserveUnverified(row: TrajectoryRow): Promise<void>;
}
export { jsonDigest, buildZeroSynthesisContext, publicRow };
//# sourceMappingURL=runner.d.ts.map