/**
 * Cordis entry `dsh-auto-research/colab`: runs the frozen evaluator on a
 * Google Colab GPU queue server (priority 100; declines when no endpoint is
 * configured), gives workers `$DSH_COLAB_CLI` through `ctx.shellEnv`, and
 * registers the `auto-research-colab` skill.
 */
import type { EvaluatorProcessResult, ExecutorBackend, ExecutorBackendFactory, FrozenEvaluationRequest, PluginContext } from '../api.js';
import { REMOTE_OMIT, ColabClient, packWorkspaceFiles, resolveColabConfig, writeColabConnectionFile } from './client.js';
import { COLAB_WORKER_PY, buildColabBootstrapCell } from './server-script.js';
import { runColabCli } from './cli.js';
import { createGpuAttentionBenchmark, createGraphCutBenchmark } from './benchmarks.js';
import type { ColabConfig, ColabExecResponse, ColabHealthResponse, ResolvedColabConfig } from './types.js';
export declare const name = "dsh-auto-research-colab";
export declare const inject: string[];
export declare const COLAB_SKILL = "auto-research-colab";
/** `DSH_COLAB_*` variables declared to the `dsh` `ShellEnvRegistry`. */
export declare const COLAB_SHELL_ENV_VARIABLES: Readonly<Record<string, {
    description: string;
}>>;
/** Standard-schema v1 configuration validator for `dsh-auto-research/colab`. */
export declare const Config: Readonly<{
    name: "auto-research-colab";
    '~standard': {
        version: number;
        vendor: string;
        validate(value: unknown): {
            value: ResolvedColabConfig;
        } | {
            issues: Array<{
                message: string;
                path: never[];
            }>;
        };
    };
}>;
export declare class ColabExecutor implements ExecutorBackend {
    readonly name = "colab";
    readonly client: ColabClient;
    constructor(config?: ColabConfig, env?: NodeJS.ProcessEnv);
    get config(): ResolvedColabConfig;
    /** Whether an endpoint or connection file is configured. */
    configured(): boolean;
    health(options?: {
        timeoutSeconds?: number;
        signal?: AbortSignal;
    }): Promise<ColabHealthResponse>;
    exec(workspace: string, command: string[], options?: Parameters<ColabClient['exec']>[2]): Promise<ColabExecResponse>;
    /**
     * Run the frozen evaluator on Colab. The client rejects a response whose
     * workspace manifest changed; this also rejects one that ran a different
     * evaluator than the frozen copy.
     */
    evaluate(request: FrozenEvaluationRequest): Promise<EvaluatorProcessResult>;
    /** Non-secret `DSH_COLAB_*` variables for worker shell calls. */
    shellEnvironment(): Record<string, string>;
}
export declare class ColabExecutorFactory implements ExecutorBackendFactory {
    readonly executor: ColabExecutor;
    readonly name = "colab";
    readonly priority = 100;
    constructor(executor: ColabExecutor);
    create(): Promise<ColabExecutor | null>;
}
export declare function apply(ctx: PluginContext, config?: ColabConfig): void;
export { REMOTE_OMIT, ColabClient, resolveColabConfig, writeColabConnectionFile, packWorkspaceFiles, COLAB_WORKER_PY, buildColabBootstrapCell, runColabCli, createGpuAttentionBenchmark, createGraphCutBenchmark, };
export type * from './types.js';
export type { ColabBootstrapOptions } from './server-script.js';
export type { GpuBenchmarkOptions, GpuBenchmarkProject, GraphCutBenchmarkOptions, GraphCutBenchmarkProject, } from './benchmarks.js';
//# sourceMappingURL=index.d.ts.map