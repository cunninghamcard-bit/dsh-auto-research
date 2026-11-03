/**
 * Cordis entry of the `dsh-auto-research` bundle.
 *
 * Provides the `ctx.researchExecutor` registry and registers the
 * `auto-research` SubagentProvider and the workers' `research_run` tool. The
 * workspace (`ctx.researchWorkspace`), the executors and the prompts are other
 * packages of the bundle; the `subagent_auto_research` tool comes from
 * `@deepseek-ai/dsh-tool-subagent`. All are rows of `cordis.patch.yml`.
 */
import type { PluginContext } from 'dsh-auto-research-api';
import { AutoResearchProvider } from './provider.js';
import type { ProviderConfig } from './provider.js';
import { ResearchExecutorRegistry } from './registry.js';
export declare const name = "dsh-auto-research";
export declare const inject: string[];
/** Standard-schema config: an object, validated per batch with the plan. */
export declare const Config: Readonly<{
    name: "auto-research";
    '~standard': {
        version: number;
        vendor: string;
        validate(value: unknown): {
            value: ProviderConfig;
        } | {
            issues: Array<{
                message: string;
                path: never[];
            }>;
        };
    };
}>;
export declare function apply(ctx: PluginContext, config?: ProviderConfig): void;
export { AutoResearchProvider, ResearchExecutorRegistry };
export { Runner, ResearchStoppedError } from './runner.js';
export { normalizeOptions, validatePlan } from './plan.js';
//# sourceMappingURL=index.d.ts.map