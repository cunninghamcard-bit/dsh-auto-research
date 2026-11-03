/**
 * Cordis entry `dsh-auto-research/snapshot`: registers full-copy snapshot
 * branches on `ctx.researchWorkspace` (priority 0, the fallback).
 */

import { SnapshotBackend } from './layerfs-workspace.js'
import type { PluginContext, WorkspaceBackendCreateOptions, WorkspaceBackendFactory } from './types.js'

export const name = 'dsh-auto-research-snapshot'
export const inject: string[] = ['researchWorkspace']

export class SnapshotWorkspaceFactory implements WorkspaceBackendFactory {
  readonly name = 'snapshot'
  readonly priority = 0

  async create({ output, runId }: WorkspaceBackendCreateOptions): Promise<SnapshotBackend> {
    return new SnapshotBackend({ output, runId })
  }
}

export function apply(ctx: PluginContext): void {
  ctx.effect(() => ctx.researchWorkspace!.register(new SnapshotWorkspaceFactory()))
}
