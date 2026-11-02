/**
 * Cordis entry `dsh-auto-research/local`: runs the frozen evaluator on this
 * host (priority 0, the fallback). Uses dsh's `ctx.subprocess` when the
 * profile provides it, else `node:child_process`.
 */
import type { spawn } from 'node:child_process';
import type { EvaluatorProcessResult, ExecutorBackend, ExecutorBackendFactory, FrozenEvaluationRequest, PluginContext, SubprocessServiceLike } from './types.js';
export declare const name = "dsh-auto-research-local";
export declare const inject: string[];
export declare class LocalExecutor implements ExecutorBackend {
    readonly name = "local";
    subprocess: SubprocessServiceLike | null;
    private readonly spawn;
    constructor(options?: {
        subprocess?: SubprocessServiceLike | null;
        spawn?: typeof spawn;
    });
    evaluate(request: FrozenEvaluationRequest): Promise<EvaluatorProcessResult>;
}
export declare class LocalExecutorFactory implements ExecutorBackendFactory {
    readonly executor: LocalExecutor;
    readonly name = "local";
    readonly priority = 0;
    constructor(executor?: LocalExecutor);
    create(): Promise<LocalExecutor>;
}
export declare function apply(ctx: PluginContext): void;
//# sourceMappingURL=local.d.ts.map