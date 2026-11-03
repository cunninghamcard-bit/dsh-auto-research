/**
 * Cordis entry `dsh-auto-research/local`: runs the frozen evaluator on this
 * host (priority 0, the fallback). Uses dsh's `ctx.subprocess` when the
 * profile provides it, else `node:child_process`.
 */

import type { spawn } from 'node:child_process'
import { runEvaluatorProcess } from './evaluator.js'
import type {
  EvaluatorProcessResult,
  ExecutorBackend,
  ExecutorBackendFactory,
  FrozenEvaluationRequest,
  PluginContext,
  SubprocessServiceLike,
} from './types.js'

export const name = 'dsh-auto-research-local'
export const inject: string[] = ['researchExecutor']

export class LocalExecutor implements ExecutorBackend {
  readonly name = 'local'
  subprocess: SubprocessServiceLike | null
  private readonly spawn: typeof spawn | undefined

  constructor(options: { subprocess?: SubprocessServiceLike | null; spawn?: typeof spawn } = {}) {
    this.subprocess = options.subprocess ?? null
    this.spawn = options.spawn
  }

  evaluate(request: FrozenEvaluationRequest): Promise<EvaluatorProcessResult> {
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
    })
  }
}

export class LocalExecutorFactory implements ExecutorBackendFactory {
  readonly name = 'local'
  readonly priority = 0

  constructor(readonly executor = new LocalExecutor()) {}

  async create(): Promise<LocalExecutor> {
    return this.executor
  }
}

export function apply(ctx: PluginContext): void {
  const factory = new LocalExecutorFactory()
  ctx.effect(() => ctx.researchExecutor!.register(factory))
  // `ctx.subprocess` is optional: this fiber runs only while it exists.
  ctx.inject(['subprocess'], inner => {
    factory.executor.subprocess = inner.subprocess ?? null
    inner.effect(() => () => { factory.executor.subprocess = null })
  })
}
