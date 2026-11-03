/**
 * Cordis entry `dsh-auto-research/layerfs`: registers LayerFS copy-on-write
 * branches on `ctx.researchWorkspace` (priority 100).
 */
import { LayerFSWorkspaceFactory } from './layerfs-workspace.js';
export const name = 'dsh-auto-research-layerfs';
export const inject = ['researchWorkspace'];
export function apply(ctx) {
    ctx.effect(() => ctx.researchWorkspace.register(new LayerFSWorkspaceFactory()));
}
export { LayerFSWorkspaceFactory };
//# sourceMappingURL=layerfs.js.map