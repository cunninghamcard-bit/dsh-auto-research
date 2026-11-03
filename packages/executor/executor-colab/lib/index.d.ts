/**
 * `dsh-auto-research-executor-colab`: run a command on a commit on a Google
 * Colab GPU through the signed-in Colab CLI.
 *
 * A Colab kernel runs one request at a time and shares its state, CUDA
 * context and `/content` across requests, so this executor keeps one queue
 * per session, gives each request its own directory and a fresh process
 * group, kills that group at the timeout, and restarts the kernel when the
 * CLI itself gave up waiting. Sessions cost compute units: by default only
 * sessions named in the configuration are used.
 */
import type { ExecutionRequest, ExecutionResult, ExecutorBackend, ExecutorBackendFactory, Logger, PluginContext } from 'dsh-auto-research-api';
export declare const name = "dsh-auto-research-executor-colab";
export declare const inject: string[];
export interface ColabConfig {
    /** The Colab CLI. */
    cli?: string;
    /** Names of running sessions to use, one request at a time each. */
    sessions?: string[];
    /** Let the executor create sessions when none are configured (costs compute units). */
    createSessions?: boolean;
    /** GPU for created sessions: T4, L4, G4, H100, A100. */
    gpu?: string;
    /** How many sessions to create. */
    maxSessions?: number;
}
export declare class ColabExecutor implements ExecutorBackend {
    readonly config: ColabConfig;
    readonly logger: Logger | null;
    readonly name = "colab";
    readonly cli: string;
    /** Each session's queue: the promise of its last request. */
    private readonly queues;
    private readonly pending;
    private readonly created;
    constructor(config: ColabConfig, logger?: Logger | null);
    private colab;
    /** Sessions to use; creates them on first use when allowed. */
    private sessions;
    /** The session with the fewest queued requests. */
    private pick;
    run(request: ExecutionRequest): Promise<ExecutionResult>;
    private runOn;
    /** Stop only the sessions this executor created. */
    close(): Promise<void>;
}
export declare class ColabExecutorFactory implements ExecutorBackendFactory {
    readonly config: ColabConfig;
    readonly name = "colab";
    readonly priority = 100;
    constructor(config: ColabConfig);
    /** Null unless sessions are named or may be created, so `auto` falls back to local. */
    create(options: {
        logger?: Logger;
    }): Promise<ColabExecutor | null>;
}
export declare function apply(ctx: PluginContext, config?: ColabConfig): void;
//# sourceMappingURL=index.d.ts.map