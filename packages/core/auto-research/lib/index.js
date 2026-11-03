/**
 * Cordis entry of the `dsh-auto-research` bundle.
 *
 * Provides the `ctx.researchExecutor` registry and `ctx.researchWorkers`, and
 * registers the `auto-research` SubagentProvider and the workers' `research_run` tool. The
 * workspace (`ctx.researchWorkspace`), the executors and the prompts are other
 * packages of the bundle; the `subagent_auto_research` tool comes from
 * `@deepseek-ai/dsh-tool-subagent`. All are rows of `cordis.patch.yml`.
 */
import { AutoResearchProvider } from './provider.js';
import { ResearchExecutorRegistry } from './registry.js';
import { researchRunTool } from './research-run.js';
export const name = 'dsh-auto-research';
export const inject = ['subagents'];
/** Standard-schema config: an object, validated per batch with the plan. */
export const Config = Object.freeze({
    name: 'auto-research',
    '~standard': {
        version: 1,
        vendor: 'dsh-auto-research',
        validate(value) {
            if (value === undefined || value === null)
                return { value: {} };
            if (typeof value !== 'object' || Array.isArray(value))
                return { issues: [{ message: 'config must be an object', path: [] }] };
            return { value: value };
        },
    },
});
export function apply(ctx, config = {}) {
    const executors = new ResearchExecutorRegistry();
    ctx.provide('researchExecutor', executors);
    // Optional host services are present only while their `ctx.inject` fiber is alive.
    const host = {
        subagents: ctx.subagents,
        ...(ctx.logger ? { logger: ctx.logger } : {}),
    };
    const provider = new AutoResearchProvider(host, config, executors);
    ctx.provide('researchWorkers', provider.workers);
    // Only running workers' steps see `research_run`.
    ctx.inject(['tools'], inner => {
        const tools = inner.tools;
        inner.effect(() => tools.register(researchRunTool(provider.workers), { when: ({ agent }) => provider.workers.has(agent.id) }));
    });
    ctx.inject(['researchWorkspace'], inner => {
        host.researchWorkspace = inner.researchWorkspace;
        inner.effect(() => () => { delete host.researchWorkspace; });
    });
    ctx.effect(() => host.subagents.registerProvider(provider));
}
export { AutoResearchProvider, ResearchExecutorRegistry };
export { Runner, ResearchStoppedError } from './runner.js';
export { normalizeOptions, validatePlan } from './plan.js';
//# sourceMappingURL=index.js.map