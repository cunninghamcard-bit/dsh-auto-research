/**
 * Types of the auto-research core: the plan, trajectory rows, and the
 * structural subset of the dsh host surface the core uses.
 */
import type { BranchRef, Logger, SkillsService } from 'dsh-auto-research-api';
export type Direction = 'maximize' | 'minimize';
/** Which half of a round a branch belongs to. */
export type Phase = 'explore' | 'continue';
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
export interface MetricDiagnostic {
    name: string;
    observations: number;
    missing_observations: number;
    distinct_values: number;
    constant_in_observed_checkpoints: boolean;
}
/** One randomized RSI-top metric projection handed to an explore worker. */
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
/** Batch budgets. `plan.options` overrides the plugin configuration. */
export interface ResearchOptions {
    rounds: number;
    branches: number;
    explorationMinutes: number;
    exploitationMinutes: number;
    rsiTop: boolean;
    forkAndFlush: boolean;
    /** Registered workspace backend name, or `auto`. */
    workspaceBackend: string;
    /** Registered executor name, or `auto`. */
    executor: string;
}
/** Worker LLM selection passed to `ctx.subagents.startActivation`. */
export interface WorkerAgentOptions {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    maxTokens?: number;
    [key: string]: unknown;
}
export type PlanOptions = Partial<ResearchOptions> & {
    workerProvider?: string;
    workerLlmProvider?: string;
    workerModel?: string;
    workerReasoningEffort?: string;
    workerAgentOptions?: WorkerAgentOptions;
};
/** The plan as the coordinator wrote it. */
export interface ResearchPlanInput {
    objective?: unknown;
    worker_prompt?: unknown;
    evaluator?: unknown;
    evaluator_interpreter?: unknown;
    evaluation_seconds?: unknown;
    direction?: unknown;
    metrics?: unknown;
    selection_metrics?: unknown;
    stall_seconds?: unknown;
    metric_subset?: unknown;
    portfolio_size?: unknown;
    meaningful_gain?: unknown;
    /** LayerFS ref the first batch starts from: `main`, a branch or a commit. */
    base?: unknown;
    options?: PlanOptions;
    [key: string]: unknown;
}
/** The validated plan. */
export interface ResearchPlan {
    objective: string;
    worker_prompt: string;
    /** Absolute host path of the evaluator script. */
    evaluator: string;
    evaluator_interpreter: string[];
    evaluation_seconds: number;
    direction: Direction;
    metrics: MetricDefinition[];
    selection_metrics: SelectionMetric[];
    stall_seconds: number | null;
    metric_subset: number;
    portfolio_size: number;
    meaningful_gain: number;
    base: string;
    options: PlanOptions;
}
/** One evaluator result. */
export interface EvaluationResult {
    valid: boolean;
    reason?: string;
    score?: number;
    metrics?: Record<string, number | string>;
    /** Where it ran, from the executor. */
    environment?: string;
    exit_code?: number | null;
}
/** One branch state: the baseline, an explore branch, or a continue turn. */
export interface TrajectoryRow {
    id: string;
    parent: string | null;
    phase?: Phase;
    ref: BranchRef;
    /** The worker session that produced this state; continue turns resume it. */
    session: string | null;
    /** That worker's host folder for notes and scratch files (its cwd). */
    scratch: string | null;
    completed: boolean;
    timed_out?: boolean;
    stop_reason?: string;
    diagnostic?: string;
    evaluation: EvaluationResult;
    portfolio?: unknown;
    time: number;
    last_output?: string;
}
/** What a batch returns to the coordinator. */
export interface BatchResult {
    status: 'COMPLETED';
    stop_reason: string;
    leader: TrajectoryRow;
    result_file: string;
    evaluator_sha256: string;
    trajectories: number;
}
/** Stall state carried across batches in `LATEST.json`. */
export interface Frontier {
    evaluator_sha256: string;
    executor: string;
    anchor_score: number | null;
    stalled_work_seconds: number;
}
/** `LATEST.json`: where the next batch starts. */
export interface Latest {
    leader: TrajectoryRow;
    frontier: Frontier;
    run: string;
    updated_at: string;
}
export interface ContentBlock {
    type: string;
    text?: string;
    [key: string]: unknown;
}
export interface SubagentResult {
    output?: readonly ContentBlock[] | string | null;
    stopReason?: string;
    diagnostic?: string;
    [key: string]: unknown;
}
/** One activation from `startActivation` or `continueActivation`. */
export interface SubagentActivation {
    childId: string;
    result: Promise<SubagentResult>;
    dispose: () => Promise<void>;
}
/** A started external run, as a provider's `start` returns it. */
export interface SubagentRun {
    id?: string;
    result: Promise<SubagentResult>;
    dispose: () => Promise<void>;
}
export interface SubagentProvider {
    name: string;
    capabilities: Record<string, unknown>;
    inheritsParentContext: boolean;
    start: (request: SubagentStartRequest) => Promise<SubagentRun>;
    prepareContinuable?: (request: unknown) => Promise<unknown>;
}
/** Request received by `AutoResearchProvider.start`. */
export interface SubagentStartRequest {
    cwd?: string;
    parent?: unknown;
    signal?: AbortSignal;
    agentOptions?: WorkerAgentOptions;
    [key: string]: unknown;
}
/** `ctx.subagents` surface the core uses. */
export interface SubagentsService {
    list: () => string[];
    getProvider: (name: string) => SubagentProvider | undefined;
    registerProvider: (provider: SubagentProvider) => () => void;
    startActivation: (spec: {
        provider: string;
        label: string;
        request: {
            cwd: string;
            prompt: ContentBlock[];
            parent: unknown;
            agentOptions?: WorkerAgentOptions;
        };
        signal: AbortSignal;
        delivery: 'caller';
    }) => Promise<SubagentActivation>;
    continueActivation: (spec: {
        parent: unknown;
        childId: string;
        content: ContentBlock[];
        signal: AbortSignal;
        delivery: 'caller';
    }) => Promise<SubagentActivation>;
    interrupt: (childId: string, authority: {
        kind: 'ancestor';
        agent: unknown;
    }) => void;
}
/** `ctx.shellEnv` surface: the coordinator's `DSH_*` environment. */
export interface ShellEnvService {
    collect: (execution: {
        agent?: unknown;
        callId: string;
        rootCallId?: string;
    }) => Readonly<Record<string, string>>;
}
export interface LlmCatalog {
    listProviders: () => Array<{
        id: string;
        name?: string;
    }>;
    listModels: (providerId: string) => Promise<Array<{
        id: string;
        name?: string;
    }>>;
}
/** Host services the provider reads; optional ones exist while their plugin does. */
export interface ProviderContext {
    subagents: SubagentsService;
    skills?: SkillsService;
    shellEnv?: ShellEnvService;
    llm?: LlmCatalog;
    logger?: Logger;
}
//# sourceMappingURL=types.d.ts.map