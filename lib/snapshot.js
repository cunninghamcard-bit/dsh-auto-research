/**
 * Cordis entry `dsh-auto-research/snapshot`: registers full-copy snapshot
 * branches on `ctx.researchWorkspace` (priority 0, the fallback).
 */
import { SnapshotBackend } from './layerfs-workspace.js';
export const name = 'dsh-auto-research-snapshot';
export const inject = ['researchWorkspace'];
export class SnapshotWorkspaceFactory {
    name = 'snapshot';
    priority = 0;
    async create({ output, runId }) {
        return new SnapshotBackend({ output, runId });
    }
}
export function apply(ctx) {
    ctx.effect(() => ctx.researchWorkspace.register(new SnapshotWorkspaceFactory()));
}
//# sourceMappingURL=snapshot.js.map