/**
 * Cordis entry of the `dsh-auto-research` bundle.
 *
 * Provides the `ctx.researchWorkspace` and `ctx.researchExecutor` registries,
 * registers the `auto-research` SubagentProvider and the packaged skills. The
 * `subagent_auto_research` tool comes from `@deepseek-ai/dsh-tool-subagent`
 * through `cordis.patch.yml`.
 */
import type { PluginContext } from 'dsh-auto-research-api';
import { AutoResearchProvider } from './provider.js';
import type { ProviderConfig } from './provider.js';
import { ResearchExecutorRegistry, ResearchWorkspaceRegistry } from './registry.js';
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
export { AutoResearchProvider, ResearchExecutorRegistry, ResearchWorkspaceRegistry };
export { Runner, ResearchStoppedError } from './runner.js';
export { normalizeOptions, validatePlan } from './plan.js';
//# sourceMappingURL=index.d.ts.map