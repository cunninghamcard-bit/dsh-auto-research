/**
 * `SubagentProvider` named `auto-research`.
 *
 * One activation runs one complete research Batch. Setup failures reject
 * `start()` before publication; after the handle is returned, every terminal
 * outcome settles through `result` (never a rejection), as the seam requires.
 */
import type { Config, PluginContext, ResearchPlanInput, ResolvedConfig, SubagentProvider, SubagentRun, SubagentStartRequest } from './types.js';
/** Out-of-process capability advertisement: no parent-enforced start features. */
export declare const NO_START_CAPABILITIES: Record<string, unknown>;
/** Normalize plugin config (also used by the Cordis standard schema). */
export declare function resolveConfig(input?: unknown): ResolvedConfig;
/** Extract the standalone user text from a `ContentBlock[]` or string. */
export declare function extractPromptText(prompt: unknown): string;
/**
 * Find a plan object embedded in a delegation prompt: a fenced JSON block, a
 * `PLAN_JSON:` line, or a prompt that is itself the JSON object.
 */
export declare function parsePlanFromPrompt(text: string): ResearchPlanInput | null;
/**
 * Resolve the plan from config, the plan file, or the delegation prompt.
 */
export declare function resolvePlan({ cwd, config, promptText, }: {
    cwd: string;
    config: ResolvedConfig;
    promptText: string;
}): Promise<{
    plan: ResearchPlanInput;
    source: string;
}>;
/** A held checkout-level single-instance lock. */
export interface RunnerLock {
    path: string;
    info: {
        pid: number;
        runId: string;
        cwd: string;
        started_at: string;
    };
    release: () => Promise<void>;
}
/**
 * Acquire `<runtimeRoot>/runner.lock` so two `subagent_auto_research`
 * invocations on one checkout fail loud instead of racing on `LATEST.json`.
 * A stale lock is reclaimed only when its owning PID is gone.
 */
export declare function acquireRunnerLock(runtimeRoot: string, runId: string, { cwd, pid, alive, }?: {
    cwd?: string;
    pid?: number;
    alive?: (pid: number) => boolean;
}): Promise<RunnerLock>;
/** One provider instance, normally created by the Cordis plugin entry. */
export declare class AutoResearchProvider implements SubagentProvider {
    readonly ctx: PluginContext;
    readonly config: ResolvedConfig;
    readonly name: string;
    readonly capabilities: Record<string, unknown>;
    readonly inheritsParentContext: boolean;
    constructor({ ctx, config }: {
        ctx: PluginContext;
        config?: Config;
    });
    private providerInfo;
    private isRecursiveWorker;
    /**
     * Choose the worker provider. Explicit configuration wins (after validation);
     * otherwise external/non-inheriting providers are preferred over in-process
     * context-inheriting providers such as `fork`.
     */
    workerProviderName(): string;
    start(request: SubagentStartRequest): Promise<SubagentRun>;
}
/** @returns a provider for the Cordis entry point. */
export declare function createProvider(options: {
    ctx: PluginContext;
    config?: Config;
}): AutoResearchProvider;
//# sourceMappingURL=provider.d.ts.map