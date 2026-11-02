/**
 * HTTP/HTTPS client and workspace packager for the Colab GPU Queue Server.
 */
import type { ColabConfig, ColabEvalResponse, ColabExecResponse, ColabFileEntry, ColabHealthResponse, ResolvedColabConfig } from './types.js';
/** Directories and files omitted when packaging a workspace for remote execution. */
export declare const REMOTE_OMIT: Set<string>;
/**
 * Resolve Colab configuration from explicit options, a `connection.json` file,
 * or ambient `DSH_COLAB_*` environment variables.
 */
export declare function resolveColabConfig(input?: ColabConfig | null | undefined, env?: NodeJS.ProcessEnv): ResolvedColabConfig;
/**
 * Write a mode-0600 connection JSON file so worker processes and evaluators can
 * authenticate without exposing tokens in command-line arguments or prompt text.
 */
export declare function writeColabConnectionFile(filePath: string, connection: {
    endpoint: string;
    token: string;
    timeoutSeconds?: number;
    queueTimeoutSeconds?: number;
    allowInsecureHttp?: boolean;
}): Promise<string>;
/**
 * Package a local workspace directory for remote Colab execution.
 *
 * Excludes secrets (`.env*`, `.ssh`, `.git`, etc.), heavy local caches
 * (`node_modules`, `.venv`, `__pycache__`), and `SHARED_CONTEXT/methods-*`
 * while preserving published `SHARED_CONTEXT/*` files so remote inventory
 * digests match `COLAB_WORKER_PY`'s `workspace_inventory()` 100%.
 */
export declare function packWorkspaceFiles(workspace: string, maxPayloadBytes?: number): Promise<{
    files: ColabFileEntry[];
    manifest: Record<string, string>;
    manifestSha256: string;
    totalBytes: number;
}>;
/** Client for communicating with a remote or local Colab GPU Queue Server. */
export declare class ColabClient {
    readonly config: ResolvedColabConfig;
    private readonly rawConfig;
    private readonly baseEnv;
    constructor(config?: ColabConfig | null, env?: NodeJS.ProcessEnv);
    private requireCredentials;
    private requestJson;
    /** Query the Colab GPU server health, hardware telemetry, and current queue depth. */
    health(options?: {
        timeoutSeconds?: number;
        signal?: AbortSignal;
    }): Promise<ColabHealthResponse>;
    /**
     * Package `workspace` and execute `command` inside an isolated sandbox on the
     * serialized Colab GPU queue.
     */
    exec(workspace: string, command: string[], options?: {
        id?: string;
        compileCommand?: string[];
        coldL2Flush?: boolean;
        timeoutSeconds?: number;
        queueTimeoutSeconds?: number;
        env?: Record<string, string>;
        signal?: AbortSignal;
    }): Promise<ColabExecResponse>;
    /**
     * Run a frozen evaluator script against `workspace` on the remote Colab GPU
     * while enforcing pre/post SHA-256 integrity of both the evaluator and the
     * candidate workspace.
     */
    evaluate(evaluatorScriptPath: string, workspace: string, options?: {
        id?: string;
        timeoutSeconds?: number;
        queueTimeoutSeconds?: number;
        signal?: AbortSignal;
    }): Promise<ColabEvalResponse>;
}
//# sourceMappingURL=client.d.ts.map