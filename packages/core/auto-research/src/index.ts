/**
 * Cordis entry of the `dsh-auto-research` bundle.
 *
 * Provides the `ctx.researchExecutor` registry and `ctx.researchWorkers`, and
 * registers the `auto-research` SubagentProvider, the `auto-research-continue`
 * provider continue workers start through, and the workers' `research_run` tool;
 * workers' agents do not get the batch tool (`batchTool`). The
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
import type { ProviderContext, SessionQuery } from './types.js'

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

/** The `ctx.tools` calls this plugin makes. */
interface Tools {
  register: (definition: ResearchRunTool, options: { when: (context: { agent: { id: string } }) => boolean }) => () => void
  get: (name: string) => unknown
  restrict: (filter: { deny: string[] }) => () => void
}

type AgentCreated = (event: 'agent/created', listener: (payload: { agent: { id: string; ctx: { tools: unknown } } }) => void) => () => void

export function apply(ctx: PluginContext, config: ProviderConfig = {}): void {
  const executors = new ResearchExecutorRegistry()
  ctx.provide('researchExecutor', executors)
  // Optional host services are present only while their `ctx.inject` fiber is alive.
  const host: ProviderContext = {
    subagents: ctx.subagents as ProviderContext['subagents'],
    ...(ctx.logger ? { logger: ctx.logger } : {}),
  }
  const provider = new AutoResearchProvider(host, config, executors)
  ctx.provide('researchWorkers', provider.workers)
  ctx.inject(['tools'], inner => {
    const tools = inner.tools as Tools
    // Only running workers' steps see `research_run`.
    inner.effect(() => tools.register(researchRunTool(provider.workers), { when: ({ agent }) => provider.workers.has(agent.id) }))
    // Workers never start batches: their agents are created without the batch tool.
    const batchTool = config.batchTool ?? 'subagent_auto_research'
    ;(inner.on as AgentCreated)('agent/created', ({ agent }) => {
      if (provider.workers.has(agent.id) && tools.get(batchTool)) (agent.ctx.tools as Tools).restrict({ deny: [batchTool] })
    })
  })
  ctx.inject(['sessionQuery'], inner => {
    host.sessionQuery = inner.sessionQuery as SessionQuery
    inner.effect(() => () => { delete host.sessionQuery })
  })
  ctx.inject(['researchWorkspace'], inner => {
    host.researchWorkspace = inner.researchWorkspace as WorkspaceService
    inner.effect(() => () => { delete host.researchWorkspace })
  })
  ctx.effect(() => host.subagents.registerProvider(provider))
  ctx.effect(() => host.subagents.registerProvider(provider.continuation))
}

export { AutoResearchProvider, ResearchExecutorRegistry }
export { Runner, ResearchStoppedError } from './runner.js'
export { normalizeOptions, validatePlan } from './plan.js'
