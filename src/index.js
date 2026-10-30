/**
 * Cordis entry point for the `dsh-auto-research` bundle.
 *
 * The plugin registers the `auto-research` SubagentProvider and a stable
 * coordinator prompt section. Model-facing tools are installed by
 * `cordis.patch.yml` through `@deepseek-ai/dsh-tool-subagent`.
 */

import { AutoResearchProvider, resolveConfig } from './provider.js'
import { coordinatorPolicy } from './policies.js'

export const name = 'dsh-auto-research'
export const inject = ['subagents', 'systemPrompt']

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
    validate(value) {
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
 * @param {object} ctx Cordis context with `subagents` and `systemPrompt`
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const provider = new AutoResearchProvider({ ctx, config: resolved })
  ctx.subagents.registerProvider(provider)
  const order = typeof ctx.systemPrompt.getSectionOrder === 'function'
    ? ctx.systemPrompt.getSectionOrder(PLACEMENT) ?? 500
    : 500
  ctx.systemPrompt.section({
    name: 'auto-research:coordinator',
    order,
    interpolate: false,
    text: coordinatorPolicy(),
  })
}

export { AutoResearchProvider, resolveConfig, coordinatorPolicy }
export { RESEARCH_POLICY, RESEARCH_METHODS_POLICY, CONTINUE_POLICY, buildWorkerPrompt } from './policies.js'
