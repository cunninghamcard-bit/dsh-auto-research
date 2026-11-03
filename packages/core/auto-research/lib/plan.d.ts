/**
 * Plan reading and option resolution. Runs before any run directory or
 * branch exists, so a plan missing a required field leaves nothing behind.
 */
import type { ResearchOptions, ResearchPlan, ResearchPlanInput, WorkerAgentOptions } from './types.js';
/** Plugin configuration: the defaults a plan's `options` override. */
export interface Config extends Partial<ResearchOptions> {
    providerName?: string;
    /** The `toolName` of the `subagent_auto_research` row; workers' agents are created without it. */
    batchTool?: string;
    workerProvider?: string;
    workerLlmProvider?: string;
    workerModel?: string;
    workerReasoningEffort?: string;
    workerAgentOptions?: WorkerAgentOptions;
}
/** Defaults follow ara: three rounds, four branches, 5-minute explore, 15-minute continue. */
export declare function normalizeOptions(config?: Config, plan?: ResearchPlanInput): ResearchOptions;
/** Read the coordinator's plan: four required fields, defaults for the rest. */
export declare function validatePlan(input: ResearchPlanInput, _options: ResearchOptions): ResearchPlan;
/**
 * The worker LLM selection: the request's `agentOptions`, then `plan.options`,
 * then the plugin configuration. Within a layer `workerAgentOptions` wins over
 * the single `worker*` fields.
 */
export declare function resolveWorkerAgentOptions(config: Config, plan: ResearchPlanInput, override?: WorkerAgentOptions | null): WorkerAgentOptions | null;
//# sourceMappingURL=plan.d.ts.map