/**
 * Cordis entry `dsh-auto-research/layerfs`: registers LayerFS copy-on-write
 * branches on `ctx.researchWorkspace` (priority 100).
 */
import { LayerFSWorkspaceFactory } from './layerfs-workspace.js';
import type { PluginContext } from './types.js';
export declare const name = "dsh-auto-research-layerfs";
export declare const inject: string[];
export declare function apply(ctx: PluginContext): void;
export { LayerFSWorkspaceFactory };
//# sourceMappingURL=layerfs.d.ts.map