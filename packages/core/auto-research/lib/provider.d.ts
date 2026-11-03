/**
 * The `auto-research` SubagentProvider: one activation runs one batch.
 *
 * Setup failures reject `start()`; after the run is returned, every outcome
 * settles through `result`, never a rejection.
 */
import type { Config } from './plan.js';
import type { ResearchExecutorRegistry, ResearchWorkspaceRegistry } from './registry.js';
import { ActiveWorkers } from './runner.js';
import type { ProviderContext, ResearchPlanInput, SubagentProvider, SubagentRun, SubagentStartRequest } from './types.js';
/** The plugin configuration. */
export interface ProviderConfig extends Config {
    /** Plan file, relative to the coordinator's cwd. */
    planPath?: string;
    /** An inline plan, for tests and scripted runs. */
    plan?: ResearchPlanInput;
}
export declare class AutoResearchProvider implements SubagentProvider {
    readonly ctx: ProviderContext;
    readonly config: ProviderConfig;
    readonly workspaces: ResearchWorkspaceRegistry;
    readonly executors: ResearchExecutorRegistry;
    readonly name: string;
    readonly capabilities: Readonly<{
        agentOptions: true;
        agentPreset: false;
        outputSchema: false;
        depthLimit: false;
    }>;
    readonly inheritsParentContext = false;
    readonly workers: ActiveWorkers;
    constructor(ctx: ProviderContext, config: ProviderConfig, workspaces: ResearchWorkspaceRegistry, executors: ResearchExecutorRegistry);
    /**
     * The worker provider: one whose children can be continued (an in-process
     * dsh agent), so the continue phase resumes the leader's own session.
     */
    workerProviderName(requested?: string): string;
    /** Resolve a worker model by id or display name against the live `ctx.llm` catalog. */
    private resolveModel;
    start(request: SubagentStartRequest): Promise<SubagentRun>;
}
//# sourceMappingURL=provider.d.ts.map