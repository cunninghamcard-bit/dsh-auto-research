/**
 * Cordis entry `dsh-auto-research/local`: runs the frozen evaluator on this
 * host (priority 0, the fallback). Uses dsh's `ctx.subprocess` when the
 * profile provides it, else `node:child_process`.
 */
import { runEvaluatorProcess } from './evaluator.js';
export const name = 'dsh-auto-research-local';
export const inject = ['researchExecutor'];
export class LocalExecutor {
    name = 'local';
    subprocess;
    spawn;
    constructor(options = {}) {
        this.subprocess = options.subprocess ?? null;
        this.spawn = options.spawn;
    }
    evaluate(request) {
        return runEvaluatorProcess({
            argv: request.argv,
            cwd: request.cwd,
            env: request.env,
            timeoutMs: request.timeoutMs,
            ...(request.signal ? { signal: request.signal } : {}),
            stdoutPath: request.stdoutPath,
            stderrPath: request.stderrPath,
            ...(this.spawn ? { spawn: this.spawn } : {}),
            ...(this.subprocess ? { subprocess: this.subprocess } : {}),
        });
    }
}
export class LocalExecutorFactory {
    executor;
    name = 'local';
    priority = 0;
    constructor(executor = new LocalExecutor()) {
        this.executor = executor;
    }
    async create() {
        return this.executor;
    }
}
export function apply(ctx) {
    const factory = new LocalExecutorFactory();
    ctx.effect(() => ctx.researchExecutor.register(factory));
    // `ctx.subprocess` is optional: this fiber runs only while it exists.
    ctx.inject(['subprocess'], inner => {
        factory.executor.subprocess = inner.subprocess ?? null;
        inner.effect(() => () => { factory.executor.subprocess = null; });
    });
}
//# sourceMappingURL=local.js.map