/**
 * Cordis entry point for the `dsh-auto-research` bundle.
 *
 * The plugin registers the `auto-research` SubagentProvider and the packaged
 * skills on `ctx.skills`. Model-facing tools are installed by
 * `cordis.patch.yml` through `@deepseek-ai/dsh-tool-subagent`.
 */

import { AutoResearchProvider, resolveConfig } from './provider.js'
import { ResearchExecutorRegistry, ResearchWorkspaceRegistry } from './registry.js'
import { registerSkills } from './skills.js'
import type { Config as PluginConfig, PluginContext, ProviderContext, ResolvedConfig } from './types.js'

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
  const executors = new ResearchExecutorRegistry()
  ctx.provide('researchWorkspace', workspaces)
  ctx.provide('researchExecutor', executors)
  // The provider reads optional host services from this object; each one is
  // present only while its `ctx.inject` sub-fiber is alive.
  const host: ProviderContext = { subagents: ctx.subagents, skills: ctx.skills!, ...(ctx.logger ? { logger: ctx.logger } : {}) }
  const provider = new AutoResearchProvider({ ctx: host, config: resolveConfig(config), workspaces, executors })
  for (const service of ['llm', 'workingDirectory'] as const) {
    ctx.inject([service], inner => {
      host[service] = inner[service] as never
      inner.effect(() => () => { delete host[service] })
    })
  }
  ctx.inject(['shellEnv'], inner => {
    host.shellEnv = inner.shellEnv!
    inner.effect(() => inner.shellEnv!.register(provider.workerEnvContributor()))
    inner.effect(() => () => { delete host.shellEnv })
  })
  const skills = registerSkills(host.skills!, cwd => provider.workerEnvs.ownsCheckout(cwd))
  provider.workerEnvs.onChange = skills.invalidate
  ctx.subagents.registerProvider(provider)
}

export { AutoResearchProvider, ResearchExecutorRegistry, ResearchWorkspaceRegistry, resolveConfig }
export type {
  ExecutorBackend,
  ExecutorBackendCreateOptions,
  ExecutorBackendFactory,
  FrozenEvaluationRequest,
  ResearchExecutorService,
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
