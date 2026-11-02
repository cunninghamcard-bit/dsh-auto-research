/**
 * Cordis entry point for the `dsh-auto-research` bundle.
 *
 * The plugin registers the `auto-research` SubagentProvider and the packaged
 * skills on `ctx.skills`. Model-facing tools are installed by
 * `cordis.patch.yml` through `@deepseek-ai/dsh-tool-subagent`.
 */
import { AutoResearchProvider, resolveConfig } from './provider.js';
import { ResearchExecutorRegistry, ResearchWorkspaceRegistry } from './registry.js';
import type { Config as PluginConfig, PluginContext, ResolvedConfig } from './types.js';
export declare const name = "dsh-auto-research";
export declare const inject: string[];
/**
 * Standard-schema compatible config. Using the plain standard interface keeps
 * this bundle dependency-free while still letting Cordis validate and apply
 * defaults.
 */
export declare const Config: Readonly<{
    name: "auto-research";
    '~standard': {
        version: number;
        vendor: string;
        validate(value: unknown): {
            value: ResolvedConfig;
        } | {
            issues: Array<{
                message: string;
                path: never[];
            }>;
        };
    };
}>;
/**
 * Provide `ctx.researchWorkspace`, then register the `auto-research`
 * SubagentProvider and the packaged skills. Workspace backends arrive as
 * separate plugins (`dsh-auto-research/layerfs`, `dsh-auto-research/snapshot`).
 */
export declare function apply(ctx: PluginContext, config?: PluginConfig): void;
export { AutoResearchProvider, ResearchExecutorRegistry, ResearchWorkspaceRegistry, resolveConfig };
export type { ExecutorBackend, ExecutorBackendCreateOptions, ExecutorBackendFactory, FrozenEvaluationRequest, ResearchExecutorService, ResearchWorkspaceService, WorkspaceBackend, WorkspaceBackendCreateOptions, WorkspaceBackendFactory, } from './types.js';
export { COORDINATOR_SKILL, SKILLS_ROOT, WORKER_SKILL, buildWorkerPrompt, skillFile, } from './skills.js';
//# sourceMappingURL=index.d.ts.map