/**
 * `dsh-auto-research-executor-local`: run a command on a commit in the batch
 * workspace's own Sandbox (CPU). Nothing runs on the host.
 */

import type {
  ExecutionRequest,
  ExecutionResult,
  ExecutorBackend,
  ExecutorBackendFactory,
  PluginContext,
} from 'dsh-auto-research-api'

export const name = 'dsh-auto-research-executor-local'
export const inject: string[] = ['researchExecutor']

export class LocalExecutor implements ExecutorBackend {
  readonly name = 'local'

  run(request: ExecutionRequest): Promise<ExecutionResult> {
    const { ref, workspace, ...options } = request
    return workspace.run(ref, options)
  }
}

export class LocalExecutorFactory implements ExecutorBackendFactory {
  readonly name = 'local'
  readonly priority = 0

  async create(): Promise<LocalExecutor> {
    return new LocalExecutor()
  }
}

export function apply(ctx: PluginContext): void {
  ctx.effect(() => ctx.researchExecutor!.register(new LocalExecutorFactory()))
}
