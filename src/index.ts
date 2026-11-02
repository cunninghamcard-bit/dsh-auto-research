/**
 * Cordis entry point for the `dsh-auto-research` bundle.
 *
 * The plugin registers the `auto-research` SubagentProvider and the packaged
 * skills on `ctx.skills`. Model-facing tools are installed by
 * `cordis.patch.yml` through `@deepseek-ai/dsh-tool-subagent`.
 */

import { AutoResearchProvider, AutoResearchServiceImpl, resolveConfig } from './provider.js'
import {
  LayerFSWorkspaceFactory,
  SnapshotWorkspaceFactory,
  layerfsWorkspacePlugin,
  snapshotWorkspacePlugin,
} from './layerfs-workspace.js'
import { registerSkills } from './skills.js'
import type { Config as PluginConfig, PluginContext, ResolvedConfig } from './types.js'

export const name = 'dsh-auto-research'
export const inject: string[] = ['subagents', 'skills']

/**
 * Standard-schema compatible config. Using the plain standard interface keeps
 * this bundle dependency-free while still letting Cordis validate and apply
 * defaults.
 */
export const Config = Object.freeze({
  name: 'auto-research',
  '~standard': {
    version: 1,
    vendor: 'dsh-auto-research',
    validate(value: unknown): { value: ResolvedConfig } | { issues: Array<{ message: string; path: never[] }> } {
      try {
        return { value: resolveConfig(value ?? {}) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error), path: [] }] }
      }
    },
  },
})

/**
 * Register the `autoResearch` service, concrete workspace backend plugins, the
 * `auto-research` SubagentProvider, and the packaged skills.
 */
export function apply(ctx: PluginContext, config?: PluginConfig): void {
  const resolved = resolveConfig(config)
  const provider = new AutoResearchProvider({ ctx, config: resolved })
  try {
    ctx.provide?.('autoResearch')
    ctx.autoResearch = provider.service
  } catch {
    // Host context may have read-only properties in minimal unit tests.
  }
  layerfsWorkspacePlugin.apply(ctx)
  snapshotWorkspacePlugin.apply(ctx)

  const disposeProvider = ctx.subagents.registerProvider?.(provider)
  const skills = registerSkills(ctx.skills!, cwd => provider.workerEnvs.ownsCheckout(cwd))
  provider.workerEnvs.onChange = skills.invalidate
  const effectFn = (ctx as { effect?: (cb: () => () => void) => void }).effect
  if (typeof effectFn === 'function') {
    try {
      effectFn(() => () => {
        if (typeof disposeProvider === 'function') (disposeProvider as () => void)()
        provider.dispose()
      })
    } catch {
      // Host does not support ctx.effect.
    }
  }
}

export {
  AutoResearchProvider,
  AutoResearchServiceImpl,
  LayerFSWorkspaceFactory,
  SnapshotWorkspaceFactory,
  layerfsWorkspacePlugin,
  snapshotWorkspacePlugin,
  resolveConfig,
}
export type {
  AutoResearchService,
  SubprocessServiceLike,
  WorkspaceBackend,
  WorkspaceBackendCreateOptions,
  WorkspaceBackendFactory,
} from './types.js'
export {
  COORDINATOR_SKILL,
  SKILLS_ROOT,
  WORKER_SKILL,
  buildWorkerPrompt,
  skillFile,
} from './skills.js'
