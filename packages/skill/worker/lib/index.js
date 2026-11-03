/**
 * `dsh-auto-research-worker`: prompts only. Registers the `auto-research-worker` skill.
 */
import { fileURLToPath } from 'node:url';
import { registerSkillDirectory } from 'dsh-auto-research-api';
export const name = 'dsh-auto-research-worker';
export const inject = ['skills'];
export function apply(ctx) {
    registerSkillDirectory(ctx.skills, name, fileURLToPath(new URL('../skills/', import.meta.url)), ['auto-research-worker']);
}
//# sourceMappingURL=index.js.map