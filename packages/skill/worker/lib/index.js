/**
 * `dsh-auto-research-worker`: prompts only. Injects `worker.md` into the
 * prompt of every running branch worker, and of no other session.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export const name = 'dsh-auto-research-worker';
export const inject = ['systemPrompt', 'researchWorkers'];
const TEXT = readFileSync(fileURLToPath(new URL('../worker.md', import.meta.url)), 'utf8');
export function apply(ctx) {
    const prompt = ctx.systemPrompt;
    const workers = ctx.researchWorkers;
    ctx.effect(() => prompt.context({
        name: 'auto-research:worker',
        order: prompt.getContextOrder('WORKING_DIRECTORY') + 2,
        interpolate: false,
        text: assembly => (assembly.agent && workers.has(assembly.agent.id) ? TEXT : ''),
    }));
}
//# sourceMappingURL=index.js.map