/**
 * Cordis entry of the `dsh-auto-research` bundle.
 *
 * Provides the `ctx.researchWorkspace` and `ctx.researchExecutor` registries,
 * registers the `auto-research` SubagentProvider, the workers' `research_run`
 * tool and the packaged skills. The `subagent_auto_research` tool comes from
 * `@deepseek-ai/dsh-tool-subagent` through `cordis.patch.yml`.
 */

import type { PluginContext } from 'dsh-auto-research-api'
import { AutoResearchProvider } from './provider.js'
import type { ProviderConfig } from './provider.js'
import { ResearchExecutorRegistry, ResearchWorkspaceRegistry } from './registry.js'
import { researchRunTool } from './research-run.js'
import type { ResearchRunTool } from './research-run.js'
import { registerSkills } from './skills.js'
import type { ProviderContext } from './types.js'

export const name = 'dsh-auto-research'
export const inject: string[] = ['subagents', 'skills']

/** Standard-schema config: an object, validated per batch with the plan. */
export const Config = Object.freeze({
  name: 'auto-research',
  '~standard': {
    version: 1,
    vendor: 'dsh-auto-research',
    validate(value: unknown): { value: ProviderConfig } | { issues: Array<{ message: string; path: never[] }> } {
      if (value === undefined || value === null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'config must be an object', path: [] }] }
      return { value: value as ProviderConfig }
    },
  },
})

export function apply(ctx: PluginContext, config: ProviderConfig = {}): void {
  const workspaces = new ResearchWorkspaceRegistry()
  const executors = new ResearchExecutorRegistry()
  ctx.provide('researchWorkspace', workspaces)
  ctx.provide('researchExecutor', executors)
  // Optional host services are present only while their `ctx.inject` fiber is alive.
  const host: ProviderContext = {
    subagents: ctx.subagents as ProviderContext['subagents'],
    ...(ctx.logger ? { logger: ctx.logger } : {}),
  }
  const provider = new AutoResearchProvider(host, config, workspaces, executors)
  // Only running workers' steps see `research_run`.
  ctx.inject(['tools'], inner => {
    const tools = inner.tools as {
      register: (definition: ResearchRunTool, options: { when: (context: { agent: { id: string } }) => boolean }) => () => void
    }
    inner.effect(() => tools.register(researchRunTool(provider.runs), { when: ({ agent }) => provider.runs.has(agent.id) }))
  })
  for (const service of ['llm', 'shellEnv'] as const) {
    ctx.inject([service], inner => {
      host[service] = inner[service] as never
      inner.effect(() => () => { delete host[service] })
    })
  }
  const skills = registerSkills(ctx.skills!, cwd => provider.workers.ownsCwd(cwd))
  provider.workers.onChange = skills.invalidate
  ctx.effect(() => host.subagents.registerProvider(provider))
}

export { AutoResearchProvider, ResearchExecutorRegistry, ResearchWorkspaceRegistry }
export { Runner, ResearchStoppedError } from './runner.js'
export { normalizeOptions, validatePlan } from './plan.js'
