/**
 * Plan validation and option resolution. Runs before any lock, run directory
 * or branch exists, so an invalid plan leaves nothing behind.
 */
import type { ResearchOptions, ResearchPlan, ResearchPlanInput, WorkerAgentOptions } from './types.js';
/** Plugin configuration: the defaults a plan's `options` override. */
export interface Config extends Partial<ResearchOptions> {
    providerName?: string;
    workerProvider?: string;
    workerLlmProvider?: string;
    workerModel?: string;
    workerReasoningEffort?: string;
    workerAgentOptions?: WorkerAgentOptions;
}
/** A finite number, or a decimal string of one; nothing that only coerces to one. */
export declare function scoreValue(value: unknown, label?: string): number;
/** Defaults follow ara: three rounds, four branches, 5-minute explore, 15-minute continue. */
export declare function normalizeOptions(config?: Config, plan?: ResearchPlanInput): ResearchOptions;
/** Validate the coordinator's plan and fill its defaults. */
export declare function validatePlan(input: ResearchPlanInput, options: ResearchOptions): ResearchPlan;
/**
 * The worker LLM selection: the request's `agentOptions`, then `plan.options`,
 * then the plugin configuration. Within a layer `workerAgentOptions` wins over
 * the single `worker*` fields.
 */
export declare function resolveWorkerAgentOptions(config: Config, plan: ResearchPlanInput, override?: WorkerAgentOptions | null): WorkerAgentOptions | null;
//# sourceMappingURL=plan.d.ts.map