/**
 * `dsh-auto-research-worker`: prompts only. Registers the `auto-research-worker` skill.
 */

import { fileURLToPath } from 'node:url'
import { registerSkillDirectory } from 'dsh-auto-research-api'
import type { PluginContext, SkillsService } from 'dsh-auto-research-api'

export const name = 'dsh-auto-research-worker'
export const inject: string[] = ['skills']

export function apply(ctx: PluginContext): void {
  registerSkillDirectory(ctx.skills as SkillsService, name, fileURLToPath(new URL('../skills/', import.meta.url)), ['auto-research-worker'])
}
