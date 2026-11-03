/**
 * `dsh-auto-research-executor-local`: run a command on a commit in the batch
 * workspace's own Sandbox (CPU). Nothing runs on the host.
 */
import type { ExecutionRequest, ExecutionResult, ExecutorBackend, ExecutorBackendFactory, PluginContext } from 'dsh-auto-research-api';
export declare const name = "dsh-auto-research-executor-local";
export declare const inject: string[];
export declare class LocalExecutor implements ExecutorBackend {
    readonly name = "local";
    run(request: ExecutionRequest): Promise<ExecutionResult>;
}
export declare class LocalExecutorFactory implements ExecutorBackendFactory {
    readonly name = "local";
    readonly priority = 0;
    create(): Promise<LocalExecutor>;
}
export declare function apply(ctx: PluginContext): void;
//# sourceMappingURL=index.d.ts.map