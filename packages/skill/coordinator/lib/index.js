/**
 * `dsh-auto-research-coordinator`: prompts only. Registers the `auto-research` skill.
 */
import { fileURLToPath } from 'node:url';
import { registerSkillDirectory } from 'dsh-auto-research-api';
export const name = 'dsh-auto-research-coordinator';
export const inject = ['skills'];
export function apply(ctx) {
    registerSkillDirectory(ctx.skills, name, fileURLToPath(new URL('../skills/', import.meta.url)), ['auto-research']);
}
//# sourceMappingURL=index.js.map