/**
 * Cordis entry point for the `dsh-auto-research` bundle.
 *
 * The plugin registers the `auto-research` SubagentProvider and a stable
 * coordinator prompt section. Model-facing tools are installed by
 * `cordis.patch.yml` through `@deepseek-ai/dsh-tool-subagent`.
 */
import { AutoResearchProvider, AutoResearchServiceImpl, resolveConfig } from './provider.js';
import { LayerFSWorkspaceFactory, SnapshotWorkspaceFactory, layerfsWorkspacePlugin, snapshotWorkspacePlugin } from './layerfs-workspace.js';
import { coordinatorPolicy } from './policies.js';
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
 * Register the `autoResearch` service, concrete workspace backend plugins, the
 * `auto-research` SubagentProvider, and coordinator guidance.
 */
export declare function apply(ctx: PluginContext, config?: PluginConfig): void;
export { AutoResearchProvider, AutoResearchServiceImpl, LayerFSWorkspaceFactory, SnapshotWorkspaceFactory, layerfsWorkspacePlugin, snapshotWorkspacePlugin, resolveConfig, coordinatorPolicy, };
export type { AutoResearchService, SubprocessServiceLike, WorkspaceBackend, WorkspaceBackendCreateOptions, WorkspaceBackendFactory, } from './types.js';
export { RESEARCH_POLICY, RESEARCH_METHODS_POLICY, CONTINUE_POLICY, SHARED_CONTEXT_POLICY, DSH_COORDINATOR_ADDENDUM, buildWorkerPrompt, workerPolicy, } from './policies.js';
//# sourceMappingURL=index.d.ts.map