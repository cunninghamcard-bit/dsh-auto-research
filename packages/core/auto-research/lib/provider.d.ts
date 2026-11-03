/**
 * The `auto-research` SubagentProvider: one activation runs one batch.
 *
 * Setup failures reject `start()`; after the run is returned, every outcome
 * settles through `result`.
 */
import type { Config } from './plan.js';
import type { ResearchExecutorRegistry, ResearchWorkspaceRegistry } from './registry.js';
import { WorkerRuns } from './research-run.js';
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
    readonly runs: WorkerRuns;
    constructor(ctx: ProviderContext, config: ProviderConfig, workspaces: ResearchWorkspaceRegistry, executors: ResearchExecutorRegistry);
    start(request: SubagentStartRequest): Promise<SubagentRun>;
}
//# sourceMappingURL=provider.d.ts.map