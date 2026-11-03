/**
 * Cordis entry `dsh-auto-research/layerfs`: registers LayerFS copy-on-write
 * branches on `ctx.researchWorkspace` (priority 100).
 */

import { LayerFSWorkspaceFactory } from './layerfs-workspace.js'
import type { PluginContext } from './types.js'

export const name = 'dsh-auto-research-layerfs'
export const inject: string[] = ['researchWorkspace']

export function apply(ctx: PluginContext): void {
  ctx.effect(() => ctx.researchWorkspace!.register(new LayerFSWorkspaceFactory()))
}

export { LayerFSWorkspaceFactory }
