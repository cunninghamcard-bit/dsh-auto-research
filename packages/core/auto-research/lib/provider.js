/**
 * The `auto-research` SubagentProvider: one activation runs one batch.
 *
 * Setup failures reject `start()`; after the run is returned, every outcome
 * settles through `result`.
 */
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { normalizeOptions, resolveWorkerAgentOptions, validatePlan } from './plan.js';
import { WorkerRuns } from './research-run.js';
import { ActiveWorkers, ResearchStoppedError, Runner } from './runner.js';
/** Where the coordinator's runs and `LATEST.json` live, relative to its cwd. */
const RUNTIME_DIR = '.auto-research-methods';
/** The synthetic tool-call id for a session-wide shell environment snapshot. */
const SHELL_ENV_CALL_ID = 'auto-research-env';
function text(blocks) {
    return [{ type: 'text', text: blocks }];
}
export class AutoResearchProvider {
    ctx;
    config;
    workspaces;
    executors;
    name;
    capabilities = Object.freeze({ agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: false });
    inheritsParentContext = false;
    workers = new ActiveWorkers();
    runs = new WorkerRuns();
    constructor(ctx, config, workspaces, executors) {
        this.ctx = ctx;
        this.config = config;
        this.workspaces = workspaces;
        this.executors = executors;
        this.name = config.providerName ?? 'auto-research';
    }
    async start(request) {
        const cwd = request.cwd;
        const planPath = resolve(cwd, this.config.planPath ?? join(RUNTIME_DIR, 'plan.json'));
        const input = this.config.plan
            ? { ...this.config.plan }
            : JSON.parse(await fsp.readFile(planPath, 'utf8'));
        if (typeof input.evaluator === 'string' && !isAbsolute(input.evaluator))
            input.evaluator = resolve(cwd, input.evaluator);
        const options = normalizeOptions(this.config, input);
        const plan = validatePlan(input, options);
        const evaluatorText = await fsp.readFile(plan.evaluator, 'utf8');
        const workerProvider = plan.options.workerProvider ?? this.config.workerProvider ?? 'spawn';
        const workerAgentOptions = resolveWorkerAgentOptions(this.config, input, request.agentOptions);
        // A worker model without a provider runs on the coordinator's provider.
        const parentProvider = request.parent
            .session?.requestHeader?.()?.config?.provider;
        if (workerAgentOptions && !workerAgentOptions.provider && parentProvider)
            workerAgentOptions.provider = parentProvider;
        const runtime = join(cwd, RUNTIME_DIR);
        const latestFile = join(runtime, 'LATEST.json');
        const latest = await fsp.readFile(latestFile, 'utf8').then(raw => JSON.parse(raw), () => null);
        const runId = randomUUID();
        const output = join(runtime, 'runs', runId);
        const env = this.ctx.shellEnv?.collect({ agent: request.parent, callId: SHELL_ENV_CALL_ID, rootCallId: SHELL_ENV_CALL_ID }) ?? {};
        const created = { runId, output, env, ...(this.ctx.logger ? { logger: this.ctx.logger } : {}) };
        const workspace = await this.workspaces.select(options.workspaceBackend, created);
        const executor = await this.executors.select(options.executor, created).catch(async (error) => {
            await workspace.close().catch(() => { });
            throw error;
        });
        const runner = new Runner({
            plan,
            options,
            runId,
            output,
            latestFile,
            latest,
            workspace,
            executor,
            evaluatorText,
            subagents: this.ctx.subagents,
            parent: request.parent,
            workerProvider,
            workerAgentOptions,
            workers: this.workers,
            runs: this.runs,
            ...(request.signal ? { signal: request.signal } : {}),
            ...(this.ctx.logger ? { logger: this.ctx.logger } : {}),
        });
        this.ctx.logger?.info?.(`[auto-research] batch ${runId}: project=${workspace.project} executor=${executor.name} worker=${workerProvider}${workerAgentOptions?.model ? ` model=${workerAgentOptions.provider}/${workerAgentOptions.model}` : ''}`);
        const result = (async () => {
            try {
                const batch = await runner.run();
                const leader = batch.leader;
                return {
                    stopReason: 'completed',
                    output: text([
                        'Auto-research batch COMPLETED.',
                        `leader: ${leader.id}`,
                        `score: ${leader.evaluation.score}`,
                        `branch: ${leader.ref.branch} @ ${leader.ref.commit}`,
                        `environment: ${leader.evaluation.environment ?? executor.name}`,
                        `run: ${output}`,
                        `dashboard: ${join(output, 'DASHBOARD.json')}`,
                        `trajectories: ${batch.trajectories}`,
                        'A batch boundary is not evidence that the objective is met. Nothing was merged or published.',
                    ].join('\n')),
                };
            }
            catch (error) {
                const stopped = error instanceof ResearchStoppedError || runner.stopped();
                const message = error instanceof Error ? error.message : String(error);
                await fsp.writeFile(join(output, 'RESULT.json'), JSON.stringify({ status: stopped ? 'STOPPED' : 'FAILED', error: message }, null, 2) + '\n').catch(() => { });
                return {
                    stopReason: stopped ? 'aborted' : 'error',
                    diagnostic: message.slice(0, 4000),
                    output: text(`Auto-research batch ${stopped ? 'STOPPED' : 'FAILED'}: ${message}\nrun: ${output}\nBranches and worker sessions are kept.`),
                };
            }
            finally {
                await executor.close?.().catch(() => { });
                await workspace.close().catch(() => { });
            }
        })();
        return {
            id: runId,
            result,
            dispose: async () => {
                runner.stop();
                await result;
            },
        };
    }
}
//# sourceMappingURL=provider.js.map