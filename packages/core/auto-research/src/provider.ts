/**
 * The `auto-research` SubagentProvider: one activation runs one batch.
 *
 * Setup failures reject `start()`; after the run is returned, every outcome
 * settles through `result`, never a rejection.
 */

import { createHash, randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { ExecutorBackend, WorkspaceBackend } from 'dsh-auto-research-api'
import { normalizeOptions, resolveWorkerAgentOptions, validatePlan } from './plan.js'
import type { Config } from './plan.js'
import type { ResearchExecutorRegistry, ResearchWorkspaceRegistry } from './registry.js'
import { ActiveWorkers, ResearchStoppedError, Runner } from './runner.js'
import type {
  ContentBlock,
  Latest,
  ProviderContext,
  ResearchPlanInput,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  WorkerAgentOptions,
} from './types.js'

/** The plugin configuration. */
export interface ProviderConfig extends Config {
  /** Plan file, relative to the coordinator's cwd. */
  planPath?: string
  /** An inline plan, for tests and scripted runs. */
  plan?: ResearchPlanInput
}

/** Where the coordinator's runs and `LATEST.json` live, relative to its cwd. */
const RUNTIME_DIR = '.auto-research-methods'

/** The synthetic tool-call id for a session-wide shell environment snapshot. */
const SHELL_ENV_CALL_ID = 'auto-research-env'

function text(blocks: string): ContentBlock[] {
  return [{ type: 'text', text: blocks }]
}

function sessionIdOf(agent: unknown): string | null {
  const id = (agent as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : null
}

/** `<runtime>/runner.lock`, so two batches in one folder fail instead of racing on `LATEST.json`. */
async function acquireLock(runtime: string, runId: string): Promise<() => Promise<void>> {
  await fsp.mkdir(runtime, { recursive: true })
  const path = join(runtime, 'runner.lock')
  const info = JSON.stringify({ pid: process.pid, runId, started_at: new Date().toISOString() }) + '\n'
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.writeFile(path, info, { flag: 'wx', mode: 0o600 })
      return () => fsp.rm(path, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // A lock from another process is stale: batches run inside the dsh process that started them.
      const owner = Number(/"pid":(\d+)/.exec(await fsp.readFile(path, 'utf8').catch(() => ''))?.[1])
      if (attempt > 0 || owner === process.pid) {
        throw new Error(`Another auto-research batch is running in this folder: ${path}`)
      }
      await fsp.rm(path, { force: true })
    }
  }
}

export class AutoResearchProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities = Object.freeze({ agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: false })
  readonly inheritsParentContext = false
  readonly workers = new ActiveWorkers()

  constructor(
    readonly ctx: ProviderContext,
    readonly config: ProviderConfig,
    readonly workspaces: ResearchWorkspaceRegistry,
    readonly executors: ResearchExecutorRegistry,
  ) {
    this.name = config.providerName ?? 'auto-research'
  }

  /**
   * The worker provider: one whose children can be continued (an in-process
   * dsh agent), so the continue phase resumes the leader's own session.
   */
  workerProviderName(requested?: string): string {
    const name = requested ?? this.config.workerProvider ?? 'spawn'
    const provider = this.ctx.subagents.getProvider(name)
    if (!provider) throw new Error(`worker provider "${name}" is not registered (available: ${this.ctx.subagents.list().join(', ')})`)
    if (name === this.name) throw new Error('auto-research cannot delegate to itself')
    if (typeof provider.prepareContinuable !== 'function') {
      throw new Error(`worker provider "${name}" cannot continue a session; use an in-process provider such as spawn`)
    }
    return name
  }

  /** Resolve a worker model by id or display name against the live `ctx.llm` catalog. */
  private async resolveModel(options: WorkerAgentOptions | null, parent: unknown): Promise<WorkerAgentOptions | null> {
    if (!options) return null
    const parentProvider = (parent as {
      session?: { requestHeader?: () => { config?: { provider?: unknown } } | undefined }
    } | null)?.session?.requestHeader?.()?.config?.provider
    const llm = this.ctx.llm
    if (options.model && llm) {
      const target = options.model.toLowerCase()
      const providers = options.provider
        ? [options.provider]
        : [...new Set([parentProvider, ...llm.listProviders().map(provider => provider.id)].filter((id): id is string => typeof id === 'string'))]
      for (const providerId of providers) {
        const match = (await llm.listModels(providerId)).find(model => model.id.toLowerCase() === target || model.name?.toLowerCase() === target)
        if (match) return { ...options, provider: providerId, model: match.id }
      }
      throw new Error(`worker model "${options.model}" matches no model id or name`)
    }
    return typeof parentProvider === 'string' && !options.provider ? { ...options, provider: parentProvider } : options
  }

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    const cwd = request.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('auto-research needs an absolute cwd')
    if (!request.parent) throw new Error('auto-research needs the live parent agent')
    const caller = sessionIdOf(request.parent)
    if (this.workers.ownsCwd(cwd) || (caller !== null && this.workers.sessions.has(caller))) {
      throw new Error('a branch worker cannot start an auto-research batch')
    }

    // Validate everything before any lock, folder or branch exists.
    const planPath = resolve(cwd, this.config.planPath ?? join(RUNTIME_DIR, 'plan.json'))
    const input = this.config.plan
      ? { ...this.config.plan }
      : JSON.parse(await fsp.readFile(planPath, 'utf8').catch(() => {
        throw new Error(`No research plan: write ${planPath}`)
      })) as ResearchPlanInput
    if (typeof input.evaluator === 'string' && !isAbsolute(input.evaluator)) input.evaluator = resolve(cwd, input.evaluator)
    const options = normalizeOptions(this.config, input)
    const plan = validatePlan(input, options)
    const evaluatorText = await fsp.readFile(plan.evaluator, 'utf8').catch(() => {
      throw new Error('The plan evaluator cannot be read: ' + plan.evaluator)
    })
    const evaluatorSha256 = createHash('sha256').update(evaluatorText).digest('hex')
    const workerProvider = this.workerProviderName(plan.options.workerProvider)
    const workerAgentOptions = await this.resolveModel(resolveWorkerAgentOptions(this.config, input, request.agentOptions), request.parent)

    const runtime = join(cwd, RUNTIME_DIR)
    const latestFile = join(runtime, 'LATEST.json')
    const latest = await fsp.readFile(latestFile, 'utf8').then(raw => JSON.parse(raw) as Latest, () => null)
    const runId = randomUUID()
    const output = join(runtime, 'runs', runId)
    const env = { ...process.env, ...this.ctx.shellEnv?.collect({ agent: request.parent, callId: SHELL_ENV_CALL_ID, rootCallId: SHELL_ENV_CALL_ID }) }
    const created = { runId, output, env, ...(this.ctx.logger ? { logger: this.ctx.logger } : {}) }

    const release = await acquireLock(runtime, runId)
    let workspace: WorkspaceBackend | null = null
    let executor: ExecutorBackend | null = null
    try {
      workspace = await this.workspaces.select(options.workspaceBackend, created)
      executor = await this.executors.select(options.executor, created)
    } catch (error) {
      await workspace?.close().catch(() => {})
      await release()
      throw error
    }
    const runner = new Runner({
      plan,
      options,
      runId,
      output,
      latestFile,
      latest,
      workspace,
      executor,
      evaluatorText,
      evaluatorSha256,
      subagents: this.ctx.subagents,
      parent: request.parent,
      workerProvider,
      workerAgentOptions,
      workers: this.workers,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(this.ctx.logger ? { logger: this.ctx.logger } : {}),
    })
    this.ctx.logger?.info?.(`[auto-research] batch ${runId}: project=${workspace.project} executor=${executor.name} worker=${workerProvider}${workerAgentOptions?.model ? ` model=${workerAgentOptions.provider}/${workerAgentOptions.model}` : ''}`)

    const result = (async (): Promise<SubagentResult> => {
      try {
        const batch = await runner.run()
        const leader = batch.leader
        return {
          stopReason: 'completed',
          output: text([
            'Auto-research batch COMPLETED.',
            `leader: ${leader.id}`,
            `score: ${leader.evaluation.score}`,
            `branch: ${leader.ref.branch} @ ${leader.ref.commit}`,
            `environment: ${leader.evaluation.environment ?? executor.name}`,
            `run: ${output}`,
            `dashboard: ${join(output, 'DASHBOARD.json')}`,
            `trajectories: ${batch.trajectories}`,
            'A batch boundary is not evidence that the objective is met. Nothing was merged or published.',
          ].join('\n')),
        }
      } catch (error) {
        const stopped = error instanceof ResearchStoppedError || runner.stopped()
        const message = error instanceof Error ? error.message : String(error)
        await fsp.writeFile(join(output, 'RESULT.json'), JSON.stringify({ status: stopped ? 'STOPPED' : 'FAILED', error: message }, null, 2) + '\n').catch(() => {})
        return {
          stopReason: stopped ? 'aborted' : 'error',
          diagnostic: message.slice(0, 4000),
          output: text(`Auto-research batch ${stopped ? 'STOPPED' : 'FAILED'}: ${message}\nrun: ${output}\nBranches and worker sessions are kept.`),
        }
      } finally {
        await executor.close?.().catch(() => {})
        await workspace.close().catch(() => {})
        await release().catch(() => {})
      }
    })()

    return {
      id: runId,
      result,
      dispose: async () => {
        runner.stop()
        await result
      },
    }
  }
}
