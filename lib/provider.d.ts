/**
 * `SubagentProvider` named `auto-research`.
 *
 * One activation runs one complete research Batch. Setup failures reject
 * `start()` before publication; after the handle is returned, every terminal
 * outcome settles through `result` (never a rejection), as the seam requires.
 */
import type { ResearchWorkspaceRegistry } from './registry.js';
import type { Config, ProviderContext, ResearchPlanInput, ResolvedConfig, SubagentProvider, SubagentRun, SubagentStartRequest } from './types.js';
/** Out-of-process capability advertisement: forwards child `agentOptions` to worker branches. */
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
 * Refuse a runtime root that is a symlink escaping the workspace.
 *
 * `.auto-research-methods` holds every branch artifact and the runner lock, so
 * a planted symlink would redirect those writes outside the assigned
 * checkout. A missing runtime root is fine (it is created later).
 */
export declare function assertRuntimeRootContained(workspaceRoot: string, runtimeRoot: string): Promise<void>;
/**
 * Acquire `<runtimeRoot>/runner.lock` so two `subagent_auto_research`
 * invocations on one checkout fail loud instead of racing on `LATEST.json`.
 *
 * The payload is written to a unique sibling first and then hard-linked into
 * place, so a lock file is never observable empty or half-written. A stale
 * lock is reclaimed only when its owning PID is gone; an unparsable lock that
 * is younger than {@link LOCK_WRITE_GRACE_MS} is treated as live rather than
 * unlinked, which closes the remaining creation window.
 */
export declare function acquireRunnerLock(runtimeRoot: string, runId: string, { cwd, pid, alive, now, writeGraceMs, }?: {
    cwd?: string;
    pid?: number;
    alive?: (pid: number) => boolean;
    now?: () => number;
    writeGraceMs?: number;
}): Promise<RunnerLock>;
/** The worker environment keys this plugin owns in a `dsh` shell registry. */
export declare const AUTO_RESEARCH_ENV_KEYS: readonly ['DSH_AUTO_RESEARCH_WORKER', 'DSH_AUTO_RESEARCH_BRANCH', 'DSH_AUTO_RESEARCH_CHECKOUT', 'DSH_AUTO_RESEARCH_SANDBOX_PATH'];
/** Live handle for one running branch worker. */
export interface WorkerEnvRegistration {
    readonly id: string;
    readonly checkout: string;
    /** Bind the worker's real child session id once the provider reports it. */
    setChildSession: (sessionId: string | null) => void;
    dispose: () => void;
}
/**
 * The branch environments of the workers that are running right now.
 *
 * `dsh` rebuilds the `DSH_*` namespace for every model shell call and asks each
 * registered contributor for the values of the calling execution. The runner
 * registers a worker's branch environment before starting its activation and
 * removes it in `finally`, so a worker's own `bash` calls receive
 * `DSH_AUTO_RESEARCH_*` (and the configured `workerEnv`) in their real process
 * environment, while the coordinator's calls receive nothing.
 */
export declare class WorkerEnvRegistry {
    private readonly entries;
    private nextKey;
    /** Called whenever a worker starts or stops (the skill catalog depends on it). */
    onChange: (() => void) | null;
    private readonly resolveCwd;
    constructor(options?: {
        /** Resolve the per-session assigned checkout (`ctx.workingDirectory.get`). */
        resolveCwd?: (session: unknown, agent: unknown) => string | null;
    });
    get size(): number;
    /** @returns every checkout that currently has a live worker. */
    checkouts(): string[];
    /** Whether `sessionId` is the child session of a live worker. */
    hasChildSession(sessionId: string): boolean;
    /** Whether `path` is one of the live worker checkouts (or inside it). */
    ownsCheckout(path: string): boolean;
    register({ id, checkout, parentSessionId, childSessionId, env, }: {
        id: string;
        checkout: string;
        parentSessionId?: string | null;
        childSessionId?: string | null;
        env?: Record<string, string>;
    }): WorkerEnvRegistration;
    /** The branch environment for one shell tool execution, or `{}`. */
    resolve(execution: unknown): Record<string, string>;
    /** The registered entry that belongs to `execution`, if any. */
    private match;
}
/** The runtime session id of a live agent, when the host exposes one. */
export declare function sessionIdOf(agent: unknown): string | null;
/** `dsh`-owned names that a plugin contributor may never claim. */
export declare const DSH_RESERVED_ENV_KEYS: Set<string>;
/**
 * The `DSH_*` keys the `auto-research` contributor declares.
 *
 * The owned worker keys are always declared; a configured `workerEnv` adds
 * every well-formed `DSH_*` name (except `DSH_LAYERFS_*`, owned by
 * `@dsh-layerfs/host`, and the harness-reserved names). Other names cannot
 * travel through a `dsh` shell registry at all, so they stay in the prompt
 * environment only.
 */
export declare function declaredWorkerEnvKeys(workerEnv?: Record<string, unknown> | null): Record<string, {
    description: string;
}>;
/** One provider instance, normally created by the Cordis plugin entry. */
export declare class AutoResearchProvider implements SubagentProvider {
    readonly ctx: ProviderContext;
    readonly config: ResolvedConfig;
    readonly name: string;
    readonly capabilities: Record<string, unknown>;
    readonly inheritsParentContext: boolean;
    /** Workspace backends registered by `ctx.researchWorkspace` plugins. */
    readonly workspaces: ResearchWorkspaceRegistry;
    /** Branch environments of the workers that are running right now. */
    readonly workerEnvs: WorkerEnvRegistry;
    /**
     * `DSH_*` keys the shell contributor may return.
     *
     * A `dsh` registry refuses an undeclared key, so the owned keys plus every
     * `DSH_*` name from `config.workerEnv` are declared up front. `DSH_LAYERFS_*`
     * is never declared here: `@dsh-layerfs/host` owns those keys for the same
     * session and a second owner is a hard registration error.
     */
    readonly workerEnvKeys: Readonly<Record<string, {
        description: string;
    }>>;
    /** Batches whose runner is still alive (used to reject recursive delegation). */
    activeBatches: number;
    private disposeShellEnv;
    constructor({ ctx, config, workspaces }: {
        ctx: ProviderContext;
        config?: Config;
        workspaces: ResearchWorkspaceRegistry;
    });
    /** The `ctx.subprocess` service (`@deepseek-ai/dsh-subprocess`), read safely. */
    private subprocessService;
    /** The `ctx.shellEnv` service, read without tripping Cordis's inject guard. */
    private shellEnvService;
    /** Release the `shellEnv` contributor when the plugin unloads. */
    dispose(): void;
    /**
     * Register the branch `shellEnv` contributor once a `dsh` shell registry is
     * available. The registry may be injected after this provider is built, so
     * `ctx.inject` is used when the service is not there yet.
     */
    private installShellEnvContributor;
    /** The contributor handed to `ctx.shellEnv.register`. */
    workerEnvContributor(): {
        name: string;
        variables: Record<string, {
            description: string;
        }>;
        resolve: (execution: unknown) => Record<string, string>;
    };
    /**
     * The branch environment for one shell execution, filtered to declared keys.
     *
     * `resolve` is only invoked for a worker's own session (see
     * {@link WorkerEnvRegistry.match}); a coordinator's call gets nothing.
     */
    workerEnvFor(execution: unknown): Record<string, string>;
    private providerInfo;
    private isRecursiveWorker;
    /**
     * Refuse `subagent_auto_research` from a branch worker.
     *
     * A worker already owns one branch of a running batch: delegating another
     * batch from inside it would recurse and race the runner lock. Two signals,
     * either sufficient: the cwd is inside a checkout carrying the runner's
     * `.auto-research-methods/WORKER.json` marker, or the caller's session is a
     * live worker's child session.
     */
    private assertNotRecursive;
    /**
     * The assigned checkout of one session, when the host exposes
     * `ctx.workingDirectory.get(session)`.
     */
    private sessionWorkingDirectory;
    /**
     * Choose the worker provider. Explicit configuration wins (after validation);
     * a plan-level override is honored when registered; otherwise external/non-inheriting
     * providers are preferred over in-process context-inheriting providers such as `fork`.
     */
    workerProviderName(planOverride?: unknown, preferAgentOptions?: boolean): string;
    /**
     * Resolve worker `agentOptions` against the live parent agent's current LLM
     * state and `dsh`'s active `llm` registry so callers only need to specify a
     * model ID or display name (e.g. `glm-5.3-flash` or `GLM Flash`) without
     * hardcoding the internal provider adapter ID.
     */
    private resolveLiveWorkerAgentOptions;
    start(request: SubagentStartRequest): Promise<SubagentRun>;
}
/** @returns a provider for the Cordis entry point. */
export declare function createProvider(options: {
    ctx: ProviderContext;
    config?: Config;
    workspaces: ResearchWorkspaceRegistry;
}): AutoResearchProvider;
//# sourceMappingURL=provider.d.ts.map