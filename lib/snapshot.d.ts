/**
 * Cordis entry `dsh-auto-research/snapshot`: registers full-copy snapshot
 * branches on `ctx.researchWorkspace` (priority 0, the fallback).
 */
import { SnapshotBackend } from './layerfs-workspace.js';
import type { PluginContext, WorkspaceBackendCreateOptions, WorkspaceBackendFactory } from './types.js';
export declare const name = "dsh-auto-research-snapshot";
export declare const inject: string[];
export declare class SnapshotWorkspaceFactory implements WorkspaceBackendFactory {
    readonly name = "snapshot";
    readonly priority = 0;
    create({ output, runId }: WorkspaceBackendCreateOptions): Promise<SnapshotBackend>;
}
export declare function apply(ctx: PluginContext): void;
//# sourceMappingURL=snapshot.d.ts.map