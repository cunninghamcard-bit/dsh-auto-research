/**
 * Cordis entry of the `dsh-auto-research` bundle.
 *
 * Provides the `ctx.researchWorkspace` and `ctx.researchExecutor` registries,
 * registers the `auto-research` SubagentProvider and the packaged skills. The
 * `subagent_auto_research` tool comes from `@deepseek-ai/dsh-tool-subagent`
 * through `cordis.patch.yml`.
 */
import { AutoResearchProvider } from './provider.js';
import { ResearchExecutorRegistry, ResearchWorkspaceRegistry } from './registry.js';
import { RUN_ENV_VARIABLES } from './run-server.js';
import { registerSkills } from './skills.js';
export const name = 'dsh-auto-research';
export const inject = ['subagents', 'skills'];
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
    const workspaces = new ResearchWorkspaceRegistry();
    const executors = new ResearchExecutorRegistry();
    ctx.provide('researchWorkspace', workspaces);
    ctx.provide('researchExecutor', executors);
    // Optional host services are present only while their `ctx.inject` fiber is alive.
    const host = {
        subagents: ctx.subagents,
        ...(ctx.logger ? { logger: ctx.logger } : {}),
    };
    const provider = new AutoResearchProvider(host, config, workspaces, executors);
    // Running workers' bash calls get the research-run CLI, endpoint and token.
    ctx.inject(['shellEnv'], inner => {
        const shellEnv = inner.shellEnv;
        inner.effect(() => shellEnv.register({
            name: 'auto-research',
            variables: { ...RUN_ENV_VARIABLES },
            resolve: execution => provider.runs.environment(typeof execution.agent?.id === 'string' ? execution.agent.id : null),
        }));
    });
    for (const service of ['llm', 'shellEnv']) {
        ctx.inject([service], inner => {
            host[service] = inner[service];
            inner.effect(() => () => { delete host[service]; });
        });
    }
    const skills = registerSkills(ctx.skills, cwd => provider.workers.ownsCwd(cwd));
    provider.workers.onChange = skills.invalidate;
    ctx.effect(() => host.subagents.registerProvider(provider));
}
export { AutoResearchProvider, ResearchExecutorRegistry, ResearchWorkspaceRegistry };
export { Runner, ResearchStoppedError } from './runner.js';
export { normalizeOptions, validatePlan } from './plan.js';
//# sourceMappingURL=index.js.map