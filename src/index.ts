/**
 * Cordis entry point for the `dsh-auto-research` bundle.
 *
 * The plugin registers the `auto-research` SubagentProvider and the packaged
 * skills on `ctx.skills`. Model-facing tools are installed by
 * `cordis.patch.yml` through `@deepseek-ai/dsh-tool-subagent`.
 */

import { AutoResearchProvider, resolveConfig } from './provider.js'
import { ResearchWorkspaceRegistry } from './registry.js'
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
 * Provide `ctx.researchWorkspace`, then register the `auto-research`
 * SubagentProvider and the packaged skills. Workspace backends arrive as
 * separate plugins (`dsh-auto-research/layerfs`, `dsh-auto-research/snapshot`).
 */
export function apply(ctx: PluginContext, config?: PluginConfig): void {
  const workspaces = new ResearchWorkspaceRegistry()
  ctx.provide('researchWorkspace', workspaces)
  const provider = new AutoResearchProvider({ ctx, config: resolveConfig(config), workspaces })
  const skills = registerSkills(ctx.skills!, cwd => provider.workerEnvs.ownsCheckout(cwd))
  provider.workerEnvs.onChange = skills.invalidate
  ctx.subagents.registerProvider(provider)
  ctx.effect(() => () => provider.dispose())
}

export { AutoResearchProvider, ResearchWorkspaceRegistry, resolveConfig }
export type {
  ResearchWorkspaceService,
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
