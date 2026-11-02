/**
 * Cordis entry `dsh-auto-research/colab`: runs the frozen evaluator on a
 * Google Colab GPU queue server (priority 100; declines when no endpoint is
 * configured), gives workers `$DSH_COLAB_CLI` through `ctx.shellEnv`, and
 * registers the `auto-research-colab` skill.
 */

import * as fsp from 'node:fs/promises'
import { loadSkill, skillCandidate } from '../skills.js'
import type {
  EvaluatorProcessResult,
  ExecutorBackend,
  ExecutorBackendFactory,
  FrozenEvaluationRequest,
  PluginContext,
} from '../api.js'
import {
  REMOTE_OMIT,
  ColabClient,
  packWorkspaceFiles,
  resolveColabConfig,
  writeColabConnectionFile,
} from './client.js'
import { COLAB_WORKER_PY, buildColabBootstrapCell } from './server-script.js'
import { runColabCli } from './cli.js'
import { createGpuAttentionBenchmark, createGraphCutBenchmark } from './benchmarks.js'
import type {
  ColabConfig,
  ColabExecResponse,
  ColabHealthResponse,
  ResolvedColabConfig,
} from './types.js'

export const name = 'dsh-auto-research-colab'
export const inject: string[] = ['researchExecutor', 'skills']

export const COLAB_SKILL = 'auto-research-colab'

/** `DSH_COLAB_*` variables declared to the `dsh` `ShellEnvRegistry`. */
export const COLAB_SHELL_ENV_VARIABLES: Readonly<Record<string, { description: string }>> = Object.freeze({
  DSH_COLAB_CLI: {
    description: 'Absolute path to the dsh-auto-research Colab GPU CLI bridge',
  },
  DSH_COLAB_ENDPOINT: {
    description: 'Configured Google Colab GPU Queue Server URL',
  },
  DSH_COLAB_CONNECTION: {
    description: 'Path to the private mode-0600 Colab connection JSON file',
  },
  DSH_COLAB_TIMEOUT_SECONDS: {
    description: 'Default timeout in seconds for remote Colab GPU jobs',
  },
})

/** Standard-schema v1 configuration validator for `dsh-auto-research/colab`. */
export const Config = Object.freeze({
  name: 'auto-research-colab',
  '~standard': {
    version: 1,
    vendor: 'dsh-auto-research-colab',
    validate(value: unknown): { value: ResolvedColabConfig } | { issues: Array<{ message: string; path: never[] }> } {
      try {
        return { value: resolveColabConfig((value ?? {}) as ColabConfig) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error), path: [] }] }
      }
    },
  },
})

export class ColabExecutor implements ExecutorBackend {
  readonly name = 'colab'
  readonly client: ColabClient

  constructor(config?: ColabConfig, env: NodeJS.ProcessEnv = process.env) {
    this.client = new ColabClient(config, env)
  }

  get config(): ResolvedColabConfig {
    return this.client.config
  }

  /** Whether an endpoint or connection file is configured. */
  configured(): boolean {
    return Boolean(this.config.endpoint || this.config.connectionFile)
  }

  health(options?: { timeoutSeconds?: number; signal?: AbortSignal }): Promise<ColabHealthResponse> {
    return this.client.health(options)
  }

  exec(workspace: string, command: string[], options?: Parameters<ColabClient['exec']>[2]): Promise<ColabExecResponse> {
    return this.client.exec(workspace, command, options)
  }

  /**
   * Run the frozen evaluator on Colab. The client rejects a response whose
   * workspace manifest changed; this also rejects one that ran a different
   * evaluator than the frozen copy.
   */
  async evaluate(request: FrozenEvaluationRequest): Promise<EvaluatorProcessResult> {
    const response = await this.client.evaluate(request.script, request.workspace, {
      timeoutSeconds: Math.max(1, Math.ceil(request.timeoutMs / 1000)),
      ...(request.signal ? { signal: request.signal } : {}),
    })
    if (response.evaluator_sha256 !== request.sha256) {
      throw new Error('Colab ran a different evaluator than the frozen copy')
    }
    await fsp.writeFile(request.stdoutPath, response.stdout)
    await fsp.writeFile(request.stderrPath, response.stderr)
    return {
      code: response.exit_code,
      timedOut: response.timed_out,
      aborted: request.signal?.aborted === true,
      stdout: response.stdout,
      stderr: response.stderr,
    }
  }

  /** Non-secret `DSH_COLAB_*` variables for worker shell calls. */
  shellEnvironment(): Record<string, string> {
    const out: Record<string, string> = {
      DSH_COLAB_CLI: this.config.cliPath,
      DSH_COLAB_TIMEOUT_SECONDS: String(this.config.timeoutSeconds),
    }
    if (this.config.endpoint) out.DSH_COLAB_ENDPOINT = this.config.endpoint
    if (this.config.connectionFile) out.DSH_COLAB_CONNECTION = this.config.connectionFile
    return out
  }
}

export class ColabExecutorFactory implements ExecutorBackendFactory {
  readonly name = 'colab'
  readonly priority = 100

  constructor(readonly executor: ColabExecutor) {}

  async create(): Promise<ColabExecutor | null> {
    return this.executor.configured() ? this.executor : null
  }
}

export function apply(ctx: PluginContext, config?: ColabConfig): void {
  const executor = new ColabExecutor(config)
  ctx.effect(() => ctx.researchExecutor!.register(new ColabExecutorFactory(executor)))
  const skill = [skillCandidate(COLAB_SKILL, name)]
  ctx.skills!.registerProvider(() => ({ name, list: async () => skill, get: loadSkill }))
  if (executor.config.injectShellEnv) {
    // `ctx.shellEnv` is optional: this fiber runs only while it exists.
    ctx.inject(['shellEnv'], inner => {
      inner.effect(() => inner.shellEnv!.register!({
        name: 'auto-research-colab',
        variables: COLAB_SHELL_ENV_VARIABLES,
        resolve: () => executor.shellEnvironment(),
      }))
    })
  }
}

export {
  REMOTE_OMIT,
  ColabClient,
  resolveColabConfig,
  writeColabConnectionFile,
  packWorkspaceFiles,
  COLAB_WORKER_PY,
  buildColabBootstrapCell,
  runColabCli,
  createGpuAttentionBenchmark,
  createGraphCutBenchmark,
}
export type * from './types.js'
export type { ColabBootstrapOptions } from './server-script.js'
export type {
  GpuBenchmarkOptions,
  GpuBenchmarkProject,
  GraphCutBenchmarkOptions,
  GraphCutBenchmarkProject,
} from './benchmarks.js'
