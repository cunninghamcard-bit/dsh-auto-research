/**
 * `dsh-auto-research-executor-colab`: run a command on a commit on a Google
 * Colab GPU, over ssh through the signed-in Colab CLI's proxy.
 *
 * Each request streams the commit as a tarball into a fresh directory on the
 * VM, runs the command there under `timeout`, and removes the directory. One
 * ssh connection per session is kept open and reused. Requests on one
 * session run one at a time, so runs do not share the GPU; a request whose
 * caller gave up still holds its session until the command ends. Sessions cost
 * compute units: by default only sessions named in the configuration are used.
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
    private readonly used;
    private key;
    constructor(config: ColabConfig, logger?: Logger | null);
    private sshOptions;
    private ensureKey;
    /** Sessions to use; creates them on first use when allowed. */
    private sessions;
    /** The session with the fewest queued requests. */
    private pick;
    run(request: ExecutionRequest): Promise<ExecutionResult>;
    /** One request, until the command on the VM has ended: an aborted caller does not cut it short. */
    private runOn;
    /** Close the reused connections; stop only the sessions this executor created. */
    close(): Promise<void>;
}
export declare class ColabExecutorFactory implements ExecutorBackendFactory {
    readonly config: ColabConfig;
    readonly name = "colab";
    readonly priority = 100;
    constructor(config: ColabConfig);
    /** Null unless sessions are named or may be created, so `auto` falls back to the Sandbox. */
    create(options: {
        logger?: Logger;
    }): Promise<ColabExecutor | null>;
}
export declare function apply(ctx: PluginContext, config?: ColabConfig): void;
//# sourceMappingURL=index.d.ts.map