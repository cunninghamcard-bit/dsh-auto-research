/**
 * Cordis entry of the `dsh-auto-research` bundle.
 *
 * Provides the `ctx.researchExecutor` registry and registers the
 * `auto-research` SubagentProvider and the workers' `research_run` tool. The
 * workspace (`ctx.researchWorkspace`), the executors and the prompts are other
 * packages of the bundle; the `subagent_auto_research` tool comes from
 * `@deepseek-ai/dsh-tool-subagent`. All are rows of `cordis.patch.yml`.
 */

import type { PluginContext, WorkspaceService } from 'dsh-auto-research-api'
import { AutoResearchProvider } from './provider.js'
import type { ProviderConfig } from './provider.js'
import { ResearchExecutorRegistry } from './registry.js'
import { researchRunTool } from './research-run.js'
import type { ResearchRunTool } from './research-run.js'
import type { ProviderContext } from './types.js'

export const name = 'dsh-auto-research'
export const inject: string[] = ['subagents']

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
  const executors = new ResearchExecutorRegistry()
  ctx.provide('researchExecutor', executors)
  // Optional host services are present only while their `ctx.inject` fiber is alive.
  const host: ProviderContext = {
    subagents: ctx.subagents as ProviderContext['subagents'],
    ...(ctx.logger ? { logger: ctx.logger } : {}),
  }
  const provider = new AutoResearchProvider(host, config, executors)
  // Only running workers' steps see `research_run`.
  ctx.inject(['tools'], inner => {
    const tools = inner.tools as {
      register: (definition: ResearchRunTool, options: { when: (context: { agent: { id: string } }) => boolean }) => () => void
    }
    inner.effect(() => tools.register(researchRunTool(provider.workers), { when: ({ agent }) => provider.workers.has(agent.id) }))
  })
  ctx.inject(['researchWorkspace'], inner => {
    host.researchWorkspace = inner.researchWorkspace as WorkspaceService
    inner.effect(() => () => { delete host.researchWorkspace })
  })
  ctx.effect(() => host.subagents.registerProvider(provider))
}

export { AutoResearchProvider, ResearchExecutorRegistry }
export { Runner, ResearchStoppedError } from './runner.js'
export { normalizeOptions, validatePlan } from './plan.js'
