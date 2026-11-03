/**
 * One research batch.
 *
 * A port of ara's `Runner` onto LayerFS branches and dsh continuable
 * subagents: explore forks the leader's commit into fresh branches, each with
 * a new worker; continue resumes the leader's own worker session on its own
 * branch. Every state is a commit, scored by the plan's evaluator through the
 * batch executor.
 */

import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  BranchRef,
  ExecutorBackend,
  Logger,
  WorkspaceBackend,
} from 'dsh-auto-research-api'
import { scoreValue } from './plan.js'
import type { WorkerRunHandler, WorkerRuns } from './research-run.js'
import { sampleMetricViews, validatePortfolio } from './protocols.js'
import { branchFile, buildContinueMessage, buildWorkerPrompt } from './skills.js'
import type {
  BatchResult,
  ContentBlock,
  EvaluationResult,
  Frontier,
  Latest,
  MetricDiagnostic,
  MetricView,
  Phase,
  ResearchOptions,
  ResearchPlan,
  SubagentActivation,
  SubagentResult,
  SubagentsService,
  TrajectoryRow,
  WorkerAgentOptions,
} from './types.js'

/** Raised when the caller stops a batch; branches and sessions are kept. */
export class ResearchStoppedError extends Error {
  constructor(message = 'Research stopped; branches and sessions kept') {
    super(message)
    this.name = 'ResearchStoppedError'
  }
}

/** How long a worker may take to settle after it is interrupted. */
const WORKER_GRACE_MS = 30_000

/** Workers of running batches, for the skill catalog and the recursion guard. */
export class ActiveWorkers {
  readonly cwds = new Set<string>()
  readonly sessions = new Set<string>()
  onChange: () => void = () => {}

  add(cwd: string, session: string | null): void {
    this.cwds.add(cwd)
    if (session) this.sessions.add(session)
    this.onChange()
  }

  remove(cwd: string, session: string | null): void {
    this.cwds.delete(cwd)
    if (session) this.sessions.delete(session)
    this.onChange()
  }

  ownsCwd(cwd: string): boolean {
    for (const root of this.cwds) if (cwd === root || cwd.startsWith(root + '/')) return true
    return false
  }
}

export interface RunnerDeps {
  plan: ResearchPlan
  options: ResearchOptions
  runId: string
  /** The batch's run directory on the host. */
  output: string
  /** `LATEST.json` of this coordinator folder. */
  latestFile: string
  latest: Latest | null
  workspace: WorkspaceBackend
  executor: ExecutorBackend
  evaluatorText: string
  evaluatorSha256: string
  subagents: SubagentsService
  /** The coordinator agent: parent of every worker. */
  parent: unknown
  workerProvider: string
  workerAgentOptions: WorkerAgentOptions | null
  workers: ActiveWorkers
  /** `research_run` handlers of running workers. */
  runs: WorkerRuns
  signal?: AbortSignal
  logger?: Logger
  rng?: () => number
}

function outputText(output: SubagentResult['output']): string {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return (output as ContentBlock[]).map(block => typeof block.text === 'string' ? block.text : '').filter(Boolean).join('\n')
}

function compareKeys(a: number[], b: number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const difference = (a[index] as number) - (b[index] as number)
    if (difference !== 0) return difference
  }
  return 0
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + '\n')
  await fsp.rename(temporary, path)
}

/** A short, Docker-safe branch name component. */
function safe(value: string, max: number): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'x'
}

export class Runner {
  readonly plan: ResearchPlan
  readonly options: ResearchOptions
  readonly rows: TrajectoryRow[] = []
  readonly selections: Array<Record<string, unknown>> = []
  readonly abort = new AbortController()
  /** Activations still running, so a stop can interrupt them. */
  private readonly live = new Set<SubagentActivation>()
  anchor: number | null = null
  stalledWorkSeconds = 0

  constructor(readonly deps: RunnerDeps) {
    this.plan = deps.plan
    this.options = deps.options
    deps.signal?.addEventListener('abort', () => this.stop(), { once: true })
  }

  stopped(): boolean {
    return this.abort.signal.aborted
  }

  checkStopped(): void {
    if (this.stopped()) throw new ResearchStoppedError()
  }

  /** Stop scheduling and interrupt every running worker. */
  stop(): void {
    if (this.stopped()) return
    this.abort.abort()
    for (const activation of this.live) this.interrupt(activation)
  }

  private interrupt(activation: SubagentActivation): void {
    try {
      this.deps.subagents.interrupt(activation.childId, { kind: 'ancestor', agent: this.deps.parent })
    } catch (error) {
      this.deps.logger?.warn?.(`[auto-research] interrupt of ${activation.childId} failed: ${(error as Error).message}`)
    }
  }

  branchName(id: string): string {
    return `ar-${safe(this.deps.runId, 8)}-${safe(id, 40)}`
  }

  async run(): Promise<BatchResult> {
    await fsp.mkdir(this.deps.output, { recursive: true })
    await writeJson(join(this.deps.output, 'PLAN.json'), this.plan)
    let leader = await this.baseline()
    for (let round = 1; round <= this.options.rounds; round += 1) {
      this.checkStopped()
      const stalled = this.options.rsiTop
        && this.plan.stall_seconds !== null
        && this.stalledWorkSeconds >= this.plan.stall_seconds
      const phases: Phase[] = this.options.forkAndFlush || stalled ? ['explore', 'continue'] : ['continue']
      for (const phase of phases) {
        this.checkStopped()
        const started = performance.now()
        const candidates = phase === 'explore'
          ? await this.explore(leader, round)
          : [await this.continueLeader(leader, round)]
        this.rows.push(...candidates)
        const previous = leader
        leader = this.choose(leader, candidates)
        this.recordProgress(leader, (performance.now() - started) / 1000)
        this.selections.push({
          round,
          phase,
          previous: previous.id,
          selected: leader.id,
          score: leader.evaluation.score,
          candidates: Object.fromEntries(candidates.map(row => [row.id, row.evaluation.valid ? row.evaluation.score : row.evaluation.reason])),
        })
        await this.writeState(leader)
        this.deps.logger?.info?.(`[auto-research] round ${round}/${this.options.rounds} ${phase}: leader=${leader.id} score=${leader.evaluation.score}`)
      }
    }
    return this.finish(leader)
  }

  /**
   * The batch's starting state: the previous batch's leader when its frontier
   * was scored by the same evaluator on the same executor, else a fresh
   * branch at `plan.base`, which must evaluate as valid.
   */
  private async baseline(): Promise<TrajectoryRow> {
    const latest = this.deps.latest
    const frontier = latest?.frontier
    if (latest && frontier?.evaluator_sha256 === this.deps.evaluatorSha256 && frontier.executor === this.deps.executor.name) {
      this.anchor = frontier.anchor_score
      this.stalledWorkSeconds = frontier.stalled_work_seconds
      this.rows.push(latest.leader)
      return latest.leader
    }
    const ref = await this.deps.workspace.fork(latest?.leader.ref ?? this.plan.base, this.branchName('initial'))
    const folder = join(this.deps.output, 'initial')
    await fsp.mkdir(folder, { recursive: true })
    const initial: TrajectoryRow = {
      id: 'initial',
      parent: null,
      ref,
      session: null,
      scratch: null,
      completed: true,
      evaluation: await this.evaluate(ref, folder),
      time: Date.now(),
    }
    this.rows.push(initial)
    if (!initial.evaluation.valid) {
      throw new Error(`The starting commit failed evaluation; no worker started: ${initial.evaluation.reason ?? 'unknown reason'}`)
    }
    this.anchor = initial.evaluation.score ?? null
    return initial
  }

  /** Fork the leader's commit into `branches` fresh branches, one new worker each. */
  private async explore(leader: TrajectoryRow, round: number): Promise<TrajectoryRow[]> {
    const views = this.views(this.options.branches)
    const settled = await Promise.allSettled(views.map((view, index) => this.freshWorker(
      leader,
      `round-${round}-explore-${index + 1}`,
      'explore',
      this.options.explorationMinutes * 60,
      view,
    )))
    const rows: TrajectoryRow[] = []
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') rows.push(outcome.value)
      else if (!(outcome.reason instanceof ResearchStoppedError)) {
        this.deps.logger?.warn?.(`[auto-research] explore branch failed: ${(outcome.reason as Error)?.message ?? outcome.reason}`)
      }
    }
    this.checkStopped()
    if (rows.length === 0) throw new Error('No explore branch started; see the logs')
    return rows
  }

  /**
   * Continue the leader's own worker session on the leader's branch. A leader
   * without a session (the baseline), or one whose session cannot resume (a
   * different coordinator conversation), gets a fresh worker on a fork instead.
   */
  private async continueLeader(leader: TrajectoryRow, round: number): Promise<TrajectoryRow> {
    const id = `round-${round}-continue`
    const seconds = this.options.exploitationMinutes * 60
    if (leader.session && leader.scratch) {
      try {
        return await this.resumeWorker(leader, id, seconds)
      } catch (error) {
        if (error instanceof ResearchStoppedError) throw error
        this.deps.logger?.warn?.(`[auto-research] cannot continue session ${leader.session}: ${(error as Error).message}; starting a fresh worker`)
      }
    }
    return this.freshWorker(leader, id, 'continue', seconds, null)
  }

  private async freshWorker(
    parent: TrajectoryRow,
    id: string,
    phase: Phase,
    seconds: number,
    view: MetricView | null,
  ): Promise<TrajectoryRow> {
    this.checkStopped()
    const ref = await this.deps.workspace.fork(parent.ref, this.branchName(id))
    const folder = join(this.deps.output, id)
    const scratch = join(folder, 'scratch')
    await fsp.mkdir(scratch, { recursive: true })
    const rsiTop = phase === 'explore' && this.options.rsiTop && view !== null
    await this.writeBranchFile(scratch, { id, phase, ref, seconds, view: rsiTop ? view : null })
    const prompt = buildWorkerPrompt({
      plan: this.plan,
      project: this.deps.workspace.project,
      branch: ref.branch,
      scratch,
      seconds,
    })
    const passOptions = this.deps.workerAgentOptions
      && this.deps.subagents.getProvider(this.deps.workerProvider)?.capabilities.agentOptions === true
    // A reserved session id gives the worker research_run from its first step.
    const childId = randomUUID()
    const unregister = this.deps.runs.register(childId, this.workerRun(ref.branch, folder, seconds))
    const activation = await this.deps.subagents.startActivation({
      provider: this.deps.workerProvider,
      label: `${this.deps.runId.slice(0, 8)}:${id}`,
      childId,
      request: {
        cwd: scratch,
        prompt: [{ type: 'text', text: prompt }],
        parent: this.deps.parent,
        ...(passOptions ? { agentOptions: this.deps.workerAgentOptions! } : {}),
      },
      signal: this.abort.signal,
      delivery: 'caller',
    }).catch((error: unknown) => {
      unregister()
      throw error
    })
    return this.settle({ activation, unregister, parent, id, phase, ref, scratch, folder, seconds, portfolio: rsiTop })
  }

  private async resumeWorker(leader: TrajectoryRow, id: string, seconds: number): Promise<TrajectoryRow> {
    this.checkStopped()
    const scratch = leader.scratch!
    const ref = await this.deps.workspace.head(leader.ref.branch)
    const folder = join(this.deps.output, id)
    await fsp.mkdir(folder, { recursive: true })
    await this.writeBranchFile(scratch, { id, phase: 'continue', ref, seconds, view: null })
    const unregister = this.deps.runs.register(leader.session!, this.workerRun(ref.branch, folder, seconds))
    const activation = await this.deps.subagents.continueActivation({
      parent: this.deps.parent,
      childId: leader.session!,
      content: [{ type: 'text', text: buildContinueMessage({ plan: this.plan, leader, head: ref, seconds }) }],
      signal: this.abort.signal,
      delivery: 'caller',
    }).catch((error: unknown) => {
      unregister()
      throw error
    })
    return this.settle({ activation, unregister, parent: leader, id, phase: 'continue', ref, scratch, folder, seconds, portfolio: false })
  }

  private async writeBranchFile(
    scratch: string,
    branch: { id: string; phase: Phase; ref: BranchRef; seconds: number; view: MetricView | null },
  ): Promise<void> {
    await writeJson(branchFile(scratch), {
      run_id: this.deps.runId,
      branch_id: branch.id,
      phase: branch.phase,
      layerfs_project: this.deps.workspace.project,
      layerfs_branch: branch.ref.branch,
      start_commit: branch.ref.commit,
      deadline_unix: Math.floor(Date.now() / 1000 + branch.seconds),
      seconds: branch.seconds,
      rsi_top: branch.view ? { portfolio_size: this.plan.portfolio_size, metric_view: branch.view } : null,
    })
  }

  /**
   * Wait for one worker turn under its time budget, then read its branch head
   * and evaluate it. A worker that ran out of time is interrupted; whatever it
   * committed is still evaluated.
   */
  private async settle(turn: {
    activation: SubagentActivation
    unregister: () => void
    parent: TrajectoryRow
    id: string
    phase: Phase
    ref: BranchRef
    scratch: string
    folder: string
    seconds: number
    portfolio: boolean
  }): Promise<TrajectoryRow> {
    const { activation } = turn
    this.live.add(activation)
    this.deps.workers.add(turn.scratch, activation.childId)
    let timedOut = false
    let result: SubagentResult
    try {
      result = await this.awaitSettled(activation, turn.seconds * 1000, () => { timedOut = true })
    } finally {
      turn.unregister()
      this.live.delete(activation)
      this.deps.workers.remove(turn.scratch, activation.childId)
    }
    this.checkStopped()
    const head = await this.deps.workspace.head(turn.ref.branch)
    const output = outputText(result.output)
    await fsp.writeFile(join(turn.folder, 'worker-output.md'), output)
    const row: TrajectoryRow = {
      id: turn.id,
      parent: turn.parent.id,
      phase: turn.phase,
      ref: head,
      session: activation.childId,
      scratch: turn.scratch,
      completed: result.stopReason === 'completed',
      timed_out: timedOut,
      stop_reason: result.stopReason ?? 'error',
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      evaluation: head.commit === turn.ref.commit
        ? { valid: false, reason: 'The worker committed nothing' }
        : await this.evaluate(head, turn.folder),
      time: Date.now(),
      last_output: output.slice(-4000),
    }
    if (turn.portfolio && row.evaluation.valid) {
      try {
        const text = await fsp.readFile(join(turn.scratch, 'PORTFOLIO.json'), 'utf8')
        row.portfolio = validatePortfolio(JSON.parse(text), { portfolioSize: this.plan.portfolio_size, parentId: turn.parent.id })
      } catch (error) {
        row.evaluation = { valid: false, reason: 'RSI portfolio: ' + (error as Error).message }
      }
    }
    await writeJson(join(turn.folder, 'RESULT.json'), row)
    return row
  }

  /**
   * The activation's result. At `budgetMs` the worker is interrupted; after an
   * interrupt (deadline or stop) it gets {@link WORKER_GRACE_MS} to settle
   * before the activation is disposed. Its session stays persisted either way.
   */
  private async awaitSettled(activation: SubagentActivation, budgetMs: number, onDeadline: () => void): Promise<SubagentResult> {
    let grace: NodeJS.Timeout | undefined
    let deadline: NodeJS.Timeout | undefined
    const expired = new Promise<SubagentResult>(resolveExpired => {
      const open = (): void => {
        grace ??= setTimeout(() => {
          void activation.dispose().catch(() => {})
          resolveExpired({ stopReason: 'aborted', diagnostic: 'worker did not settle after interrupt' })
        }, WORKER_GRACE_MS)
      }
      deadline = setTimeout(() => {
        onDeadline()
        this.interrupt(activation)
        open()
      }, budgetMs)
      this.abort.signal.addEventListener('abort', open, { once: true })
      if (this.abort.signal.aborted) open()
    })
    try {
      return await Promise.race([activation.result, expired])
    } finally {
      clearTimeout(deadline)
      clearTimeout(grace)
    }
  }

  /**
   * A worker's `research_run` handler: run a bash command on its branch head through the
   * batch executor, no longer than the turn has left. Every request is
   * appended to the branch's `research-runs.jsonl`.
   */
  private workerRun(branch: string, folder: string, seconds: number): WorkerRunHandler {
    const deadline = Date.now() + seconds * 1000
    return async (command, timeoutSeconds, signal) => {
      this.checkStopped()
      const left = Math.floor((deadline - Date.now()) / 1000)
      if (left < 5) throw new Error('the turn has no time left for another run')
      const ref = await this.deps.workspace.head(branch)
      const started = Date.now()
      const result = await this.deps.executor.run({
        ref,
        workspace: this.deps.workspace,
        argv: ['bash', '-c', command],
        timeoutMs: Math.min(timeoutSeconds, left) * 1000,
        signal: AbortSignal.any([this.abort.signal, signal]),
      })
      await fsp.appendFile(join(folder, 'research-runs.jsonl'), JSON.stringify({
        at: new Date(started).toISOString(),
        seconds: (Date.now() - started) / 1000,
        commit: ref.commit,
        command,
        code: result.code,
        timed_out: result.timedOut,
        environment: result.environment,
      }) + '\n')
      return { ...result, commit: ref.commit }
    }
  }

  /** Score one commit with the plan's evaluator, through the batch executor. */
  async evaluate(ref: BranchRef, folder: string): Promise<EvaluationResult> {
    const script = `.auto-research/${basename(this.plan.evaluator)}`
    const run = await this.deps.executor.run({
      ref,
      workspace: this.deps.workspace,
      files: [{ name: script, text: this.deps.evaluatorText }],
      argv: [...this.plan.evaluator_interpreter, script, '.'],
      timeoutMs: this.plan.evaluation_seconds * 1000,
      signal: this.abort.signal,
    })
    await fsp.mkdir(folder, { recursive: true })
    await fsp.writeFile(join(folder, 'evaluation.log'), run.stdout)
    await fsp.writeFile(join(folder, 'evaluation.err.log'), run.stderr)
    const base = { environment: run.environment, exit_code: run.code }
    if (run.timedOut) return { ...base, valid: false, reason: `Evaluator exceeded ${this.plan.evaluation_seconds}s` }
    if (run.code !== 0) return { ...base, valid: false, reason: `Evaluator exited ${run.code}: ${run.stderr.trim().slice(-300)}` }
    const last = run.stdout.trim().split('\n').at(-1) ?? ''
    try {
      return { ...base, ...this.parseEvaluation(JSON.parse(last)) }
    } catch (error) {
      return { ...base, valid: false, reason: `Evaluator output: ${(error as Error).message}` }
    }
  }

  private parseEvaluation(value: unknown): EvaluationResult {
    if (value === null || typeof value !== 'object') throw new Error('the last line is not a JSON object')
    const output = value as Record<string, unknown>
    if (output.valid !== true) {
      return { valid: false, reason: typeof output.reason === 'string' ? output.reason.slice(0, 500) : 'the evaluator rejected the candidate' }
    }
    const score = scoreValue(output.score)
    const metrics = (output.metrics ?? {}) as Record<string, number | string>
    if (typeof metrics !== 'object' || Array.isArray(metrics)) throw new Error('metrics must be an object')
    for (const spec of this.plan.metrics) {
      if (spec.optional === true && !Object.hasOwn(metrics, spec.name)) continue
      scoreValue(metrics[spec.name], `metric ${spec.name}`)
    }
    for (const spec of this.plan.selection_metrics) scoreValue(metrics[spec.name], `selection metric ${spec.name}`)
    return { valid: true, score, metrics }
  }

  /** The best valid state among the incumbent and the candidates. */
  choose(incumbent: TrajectoryRow, candidates: TrajectoryRow[]): TrajectoryRow {
    const eligible = [incumbent, ...candidates].filter(row => row.evaluation.valid)
    const key = (row: TrajectoryRow): number[] => {
      let primary = row.evaluation.score as number
      if (this.plan.direction === 'minimize') primary = -primary
      const progress = this.plan.selection_metrics.map(spec => {
        const value = scoreValue(row.evaluation.metrics?.[spec.name])
        return spec.direction === 'maximize' ? value : -value
      })
      return [primary, ...progress, row.id === 'initial' ? 0 : 1, row.time]
    }
    return [...eligible].sort((a, b) => compareKeys(key(b), key(a)))[0] ?? incumbent
  }

  /** Reset the stall clock on a meaningful gain, else add this phase's work time. */
  private recordProgress(leader: TrajectoryRow, seconds: number): void {
    const current = leader.evaluation.score as number
    let gain = this.anchor === null ? null : current - this.anchor
    if (gain !== null && this.plan.direction === 'minimize') gain = -gain
    if (gain === null || gain > this.plan.meaningful_gain) {
      this.anchor = current
      this.stalledWorkSeconds = 0
    } else {
      this.stalledWorkSeconds += seconds
    }
  }

  metricDiagnostics(): MetricDiagnostic[] {
    const valid = this.rows.filter(row => row.evaluation.valid)
    return this.plan.metrics.map(metric => {
      const values = valid
        .filter(row => Object.hasOwn(row.evaluation.metrics ?? {}, metric.name))
        .map(row => JSON.stringify(row.evaluation.metrics?.[metric.name]))
      const distinct = new Set(values).size
      return {
        name: metric.name,
        observations: values.length,
        missing_observations: valid.length - values.length,
        distinct_values: distinct,
        constant_in_observed_checkpoints: values.length > 1 && distinct === 1,
      }
    })
  }

  private views(count: number): MetricView[] {
    if (!this.options.rsiTop) return Array.from({ length: count }, () => ({ definitions: [], diagnostics: [], rows: [] }))
    return sampleMetricViews({
      metrics: this.plan.metrics,
      subset: this.plan.metric_subset,
      count,
      diagnostics: this.metricDiagnostics(),
      rows: this.rows.map(row => ({ id: row.id, parent: row.parent, workspace: row.ref.branch, evaluation: row.evaluation })),
      rng: this.deps.rng ?? Math.random,
    })
  }

  private frontier(): Frontier {
    return {
      evaluator_sha256: this.deps.evaluatorSha256,
      executor: this.deps.executor.name,
      anchor_score: this.anchor,
      stalled_work_seconds: this.stalledWorkSeconds,
    }
  }

  private async writeState(leader: TrajectoryRow): Promise<void> {
    await writeJson(join(this.deps.output, 'DASHBOARD.json'), {
      metrics: this.plan.metrics,
      metric_diagnostics: this.metricDiagnostics(),
      selections: this.selections,
      trajectories: this.rows,
    })
    await writeJson(join(this.deps.output, 'LEADER.json'), leader)
    const latest: Latest = { leader, frontier: this.frontier(), run: this.deps.output, updated_at: new Date().toISOString() }
    await writeJson(this.deps.latestFile, latest)
  }

  private async finish(leader: TrajectoryRow): Promise<BatchResult> {
    await this.writeState(leader)
    const result: BatchResult = {
      status: 'COMPLETED',
      stop_reason: 'configured_batch_complete',
      leader,
      result_file: join(this.deps.output, 'RESULT.json'),
      evaluator_sha256: this.deps.evaluatorSha256,
      trajectories: this.rows.length,
    }
    await writeJson(result.result_file, result)
    return result
  }
}
