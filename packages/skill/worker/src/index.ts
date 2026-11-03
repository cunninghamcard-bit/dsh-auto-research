/**
 * `dsh-auto-research-worker`: prompts only. Injects `worker.md` into the
 * prompt of every running branch worker, and of no other session.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { PluginContext, WorkersService } from 'dsh-auto-research-api'

export const name = 'dsh-auto-research-worker'
export const inject: string[] = ['systemPrompt', 'researchWorkers']

const TEXT = readFileSync(fileURLToPath(new URL('../worker.md', import.meta.url)), 'utf8')

/** `ctx.systemPrompt` surface: a context whose text is evaluated at every assembly. */
interface SystemPrompt {
  context: (context: {
    name: string
    order: number
    interpolate?: boolean
    text: (assembly: { agent?: { id: string } }) => string
  }) => () => void
  getContextOrder: (name: string) => number
}

export function apply(ctx: PluginContext): void {
  const prompt = ctx.systemPrompt as SystemPrompt
  const workers = ctx.researchWorkers as WorkersService
  ctx.effect(() => prompt.context({
    name: 'auto-research:worker',
    order: prompt.getContextOrder('WORKING_DIRECTORY') + 2,
    interpolate: false,
    text: assembly => (assembly.agent && workers.has(assembly.agent.id) ? TEXT : ''),
  }))
}
