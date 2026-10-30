/**
 * Cordis entry point for the `dsh-auto-research` bundle.
 *
 * The plugin registers the `auto-research` SubagentProvider and a stable
 * coordinator prompt section. Model-facing tools are installed by
 * `cordis.patch.yml` through `@deepseek-ai/dsh-tool-subagent`.
 */

import { AutoResearchProvider, resolveConfig } from './provider.js'
import { coordinatorPolicy } from './policies.js'
import type { Config as PluginConfig, PluginContext, ResolvedConfig } from './types.js'

export const name = 'dsh-auto-research'
export const inject: string[] = ['subagents', 'systemPrompt']

const PLACEMENT = 'PLAN_POLICY'

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
 * Register the provider and coordinator guidance.
 */
export function apply(ctx: PluginContext, config?: PluginConfig): void {
  const resolved = resolveConfig(config)
  const provider = new AutoResearchProvider({ ctx, config: resolved })
  ctx.subagents.registerProvider?.(provider)
  const prompt = ctx.systemPrompt
  if (!prompt) return
  const order = typeof prompt.getSectionOrder === 'function'
    ? prompt.getSectionOrder(PLACEMENT) ?? 500
    : 500
  prompt.section({
    name: 'auto-research:coordinator',
    order,
    interpolate: false,
    text: coordinatorPolicy(),
  })
}

export { AutoResearchProvider, resolveConfig, coordinatorPolicy }
export {
  RESEARCH_POLICY,
  RESEARCH_METHODS_POLICY,
  CONTINUE_POLICY,
  SHARED_CONTEXT_POLICY,
  DSH_COORDINATOR_ADDENDUM,
  buildWorkerPrompt,
  workerPolicy,
} from './policies.js'
