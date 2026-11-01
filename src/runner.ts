/**
 * One complete research Batch.
 *
 * This is the async Node.js port of `ara`'s `Runner`: a frozen evaluator, an
 * initial baseline that must pass before any worker starts, fork-and-flush /
 * RSI-top phase selection, isolated branches, cooperative evidence sharing, and
 * evidence-scored leader selection. Execution is delegated to whatever
 * `ctx.subagents` provider the deployment configures; this module owns
 * accounting and receipts, not scientific judgment.
 */

import * as fsp from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  canonicalJson,
  digestFile,
  freeBytes,
  inventory,
  inventoryBytes,
  jsonDigest,
  publicRow,
  writeJsonAtomic,
} from './layerfs-workspace.js'
import { FrozenEvaluator, scoreValue } from './evaluator.js'
import {
  buildPeerEvidence,
  buildZeroSynthesisContext,
  peerIdsOf,
  readSharedCheckpoint,
  sampleMetricViews,
  validatePeerReview,
  validatePortfolio,
  writeSharedContextAtomic,
} from './protocols.js'
import { buildWorkerPrompt, workerPolicy } from './policies.js'
import type {
  BatchResult,
  Clock,
  Config,
  ContentBlock,
  EvaluationResult,
  MetricDiagnostic,
  MetricView,
  Phase,
  PlanOptions,
  ProviderOutcome,
  ResearchOptions,
  ResearchPlan,
  ResearchPlanInput,
  RunnerDeps,
  SharedCheckpoint,
  SubagentResult,
  SubagentRun,
  TrajectoryRow,
  WorkspaceState,
} from './types.js'

/** Raised when a batch is stopped by the caller; artifacts are retained. */
export class ResearchStoppedError extends Error {
  constructor(message = 'Research stopped; artifacts retained') {
    super(message)
    this.name = 'ResearchStoppedError'
  }
}

const DEFAULT_CLOCK: Clock = {
  now: () => performance.now(),
  sleep: (milliseconds, signal) => new Promise<void>((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new ResearchStoppedError())
      return
    }
    let timer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      if (timer) clearTimeout(timer)
      reject(new ResearchStoppedError())
    }
    timer = setTimeout(() => {
      // A normally resolved sleep must not keep the signal (and this closure)
      // alive for the rest of a long batch.
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, Math.max(0, milliseconds))
    signal?.addEventListener('abort', onAbort, { once: true })
    timer.unref?.()
  }),
}

/** How long a worker activation may take to settle after its signal aborts. */
const DEFAULT_WORKER_GRACE_MS = 2000

/** Merge plan-level option overrides over plugin configuration. */
export function normalizeOptions(
  config: Config = {},
  plan: ResearchPlanInput = {},
): ResearchOptions {
  const overrides: PlanOptions = plan.options && typeof plan.options === 'object'
    ? plan.options as PlanOptions
    : {}
  return {
    rounds: overrides.rounds ?? config.rounds ?? 1,
    branches: overrides.branches ?? config.branches ?? 4,
    explorationMinutes: overrides.explorationMinutes ?? config.explorationMinutes ?? 30,
    exploitationMinutes: overrides.exploitationMinutes ?? config.exploitationMinutes ?? 30,
    rsiTop: overrides.rsiTop ?? config.rsiTop ?? false,
    forkAndFlush: overrides.forkAndFlush ?? config.forkAndFlush ?? false,
    shareContext: overrides.shareContext ?? config.shareContext ?? false,
    sharingIntervalMinutes: overrides.sharingIntervalMinutes ?? config.sharingIntervalMinutes ?? 10,
  }
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Validate the model-written plan against the execution contract and return
 * normalized defaults. Values are never replaced with repository heuristics.
 */
export function validatePlan(plan: unknown, options: ResearchOptions): ResearchPlan {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('Research plan must be a JSON object')
  }
  const input = plan as ResearchPlanInput
  if (typeof input.objective !== 'string' || input.objective.trim() === '') {
    throw new Error('Plan requires an objective')
  }
  if (typeof input.worker_prompt !== 'string' || input.worker_prompt.trim() === '') {
    throw new Error('Plan requires a worker_prompt')
  }
  if (typeof input.evaluator !== 'string' || input.evaluator.trim() === '') {
    throw new Error('Plan requires an evaluator script')
  }
  const evaluationSeconds = Number(input.evaluation_seconds)
  if (!finitePositive(evaluationSeconds)) throw new Error('Invalid evaluator configuration')
  const direction = input.direction ?? 'maximize'
  if (direction !== 'maximize' && direction !== 'minimize') {
    throw new Error('Invalid evaluator configuration')
  }
  const metrics = input.metrics ?? []
  if (!Array.isArray(metrics)) throw new Error('Plan metrics must be an array')
  const names: string[] = []
  for (const metric of metrics) {
    if (!metric || typeof metric !== 'object' || typeof (metric as { name?: unknown }).name !== 'string'
      || ((metric as { name: string }).name).trim() === '') {
      throw new Error('Invalid fixed metric definitions or subset size')
    }
    names.push((metric as { name: string }).name)
  }
  if (new Set(names).size !== names.length) {
    throw new Error('Invalid fixed metric definitions or subset size')
  }
  const selectionMetrics = input.selection_metrics ?? []
  if (!Array.isArray(selectionMetrics)) throw new Error('Selection metrics must be declared and independently evaluated')
  for (const spec of selectionMetrics) {
    if (!spec || typeof spec !== 'object'
      || !names.includes((spec as { name?: string }).name ?? '')
      || ((spec as { direction?: unknown }).direction !== 'maximize'
        && (spec as { direction?: unknown }).direction !== 'minimize')) {
      throw new Error('Selection metrics must be declared and independently evaluated')
    }
  }
  if (!Number.isInteger(options.branches) || options.branches < 2
    || !Number.isInteger(options.rounds) || options.rounds < 1) {
    throw new Error('Invalid branch/round budget')
  }
  for (const key of ['explorationMinutes', 'exploitationMinutes'] as const) {
    if (!finitePositive(options[key])) throw new Error('Invalid time budget')
  }
  if (options.shareContext && !finitePositive(options.sharingIntervalMinutes)) {
    throw new Error('Invalid context sharing interval')
  }
  let stall = typeof input.stall_seconds === 'number' ? input.stall_seconds : null
  let subset = typeof input.metric_subset === 'number' ? input.metric_subset : 1
  let portfolio = typeof input.portfolio_size === 'number' ? input.portfolio_size : 2
  const gain = input.meaningful_gain === undefined ? 0 : scoreValue(input.meaningful_gain, 'meaningful_gain')
  if (gain < 0) throw new Error('meaningful_gain must be non-negative')
  if (options.rsiTop) {
    if (!Number.isInteger(subset) || subset < 1 || subset > names.length) {
      throw new Error('Invalid fixed metric definitions or subset size')
    }
    if (!finitePositive(stall)) throw new Error('Invalid model-defined RSI intervention parameters')
    if (!Number.isInteger(portfolio) || portfolio < 2) {
      throw new Error('Invalid model-defined RSI intervention parameters')
    }
  }
  if ((options.rsiTop || Boolean(input.require_meaningful_gain)) && gain <= 0) {
    throw new Error('RSI-top requires a positive meaningful_gain')
  }
  const { workspace: rawWorkspace, evaluator_interpreter: rawInterpreter, options: rawOptions, ...rest } = input
  const normalized: ResearchPlan = {
    ...rest,
    objective: input.objective,
    worker_prompt: input.worker_prompt,
    evaluator: input.evaluator,
    evaluation_seconds: evaluationSeconds,
    direction,
    metrics: metrics as ResearchPlan['metrics'],
    selection_metrics: selectionMetrics as ResearchPlan['selection_metrics'],
    stall_seconds: stall,
    metric_subset: subset,
    portfolio_size: portfolio,
    meaningful_gain: gain,
  }
  if (typeof rawWorkspace === 'string') normalized.workspace = rawWorkspace
  if (typeof rawInterpreter === 'string' || Array.isArray(rawInterpreter)) {
    normalized.evaluator_interpreter = rawInterpreter as string | string[]
  }
  if (rawOptions && typeof rawOptions === 'object') normalized.options = rawOptions as PlanOptions
  return normalized
}

/** Port of `provider_outcome`: transport diagnostics are not turn failures. */
export function providerOutcome(
  events: unknown[] = [],
  rc: number | null,
  timedOut: boolean,
): ProviderOutcome {
  let terminal: string | null = null
  let session: string | null = null
  const diagnostics: unknown[] = []
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const record = event as Record<string, unknown>
    const kind = record.type
    if (kind === 'thread.started' && typeof record.thread_id === 'string') session = record.thread_id
    if (typeof record.session_id === 'string') session = record.session_id
    if (kind === 'turn.completed') terminal = 'completed'
    else if (kind === 'turn.failed') terminal = 'failed'
    else if (kind === 'result') {
      terminal = record.subtype === 'success' && !record.is_error ? 'completed' : 'failed'
    } else if (kind === 'error' || record.is_error) diagnostics.push(event)
  }
  return {
    completed: terminal === 'completed' && rc === 0 && !timedOut,
    provider_session: session,
    terminal,
    diagnostic_count: diagnostics.length,
  }
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active)
  const controller = new AbortController()
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function compareKeys(a: number[], b: number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] as number
    const right = b[index] as number
    if (left < right) return -1
    if (left > right) return 1
  }
  return 0
}

function mergeEnv(
  configured: Record<string, unknown> = {},
  layerfsEnv: Record<string, unknown> = {},
): Record<string, string> {
  const result: Record<string, string> = {}
  const secret = /(token|key|secret|password|credential)/i
  for (const [key, value] of Object.entries({ ...layerfsEnv, ...configured })) {
    if (value === undefined || value === null) continue
    if (secret.test(key)) continue
    result[key] = String(value)
  }
  return result
}

/** Extract assistant text from a provider `output` value. */
export function outputText(output: SubagentResult['output']): string {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return (output as ContentBlock[])
    .map(block => {
      if (typeof block === 'string') return block
      if (block?.type === 'text' && typeof block.text === 'string') return block.text
      if (typeof block?.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

interface PeerSlot {
  id: string
  parent: string | null
  phase: Phase | undefined
  collaborator: number | undefined
  evaluation: EvaluationResult
  checkpoint: SharedCheckpoint
  workspace: string
  transcript: string
  notes: string
}

/** One batch runner. */
export class Runner {
  readonly config: Config
  readonly options: ResearchOptions
  readonly plan: ResearchPlan
  readonly workspace: string
  readonly output: string
  readonly deps: RunnerDeps
  readonly manager: RunnerDeps['workspaceManager']
  readonly subagents: RunnerDeps['subagents']
  readonly clock: Clock
  readonly rng: () => number
  readonly logger: RunnerDeps['logger']
  readonly workerProvider: string
  readonly parent: unknown
  readonly signal: AbortSignal | undefined
  readonly workerEnv: Record<string, string>
  /** Provider-owned registry of live branch environments (for `ctx.shellEnv`). */
  readonly workerEnvRegistry: RunnerDeps['workerEnvRegistry']
  /** Runtime session id of the coordinator that owns this batch. */
  readonly parentSessionId: string | null
  readonly evaluator: RunnerDeps['evaluator'] & { hash: string | null }
  readonly originalManifest: Record<string, string> | null
  readonly selectionFile: string | null
  readonly runId: string
  readonly rows: TrajectoryRow[] = []
  readonly selections: Array<Record<string, unknown>> = []
  peerBundle: string | null = null
  readonly peerSlots: Record<string, PeerSlot> = {}
  bestTime: number
  anchor: number | null = null
  cancelled = false
  readonly abort = new AbortController()
  timedOutRows: TrajectoryRow[] = []
  readonly abandoned: TrajectoryRow[] = []
  readonly activeStates = new Map<WorkspaceState, { id: string; parent: string | null; workspace: string }>()
  /** Every state a backend created, from the moment it was returned. */
  readonly trackedStates = new Map<WorkspaceState, { id: string; parent: string | null; workspace: string }>()
  readonly releasedStates = new Set<WorkspaceState>()
  readonly workerGraceMs: number
  private managerClosed = false

  constructor({
    config = {},
    plan,
    workspace,
    output,
    originalManifest = null,
    selectionFile = null,
    deps,
  }: {
    config?: Config
    plan: unknown
    workspace: string
    output: string
    originalManifest?: Record<string, string> | null
    selectionFile?: string | null
    deps: RunnerDeps
  }) {
    this.config = config
    this.options = normalizeOptions(config, plan as ResearchPlanInput)
    this.plan = validatePlan(plan, this.options)
    this.workspace = workspace
    this.output = output
    this.deps = deps
    this.manager = deps.workspaceManager
    if (!this.manager) throw new Error('Runner requires a workspace manager')
    this.subagents = deps.subagents
    if (!this.subagents?.startActivation) throw new Error('Runner requires ctx.subagents.startActivation')
    this.clock = deps.clock ?? DEFAULT_CLOCK
    this.rng = deps.rng ?? Math.random
    this.logger = deps.logger ?? console
    this.workerProvider = deps.workerProvider
    if (!this.workerProvider) throw new Error('Runner requires a worker provider')
    this.parent = deps.parent
    this.signal = deps.signal
    this.workerEnv = mergeEnv(deps.workerEnv ?? config.workerEnv ?? {}, deps.layerfsEnv ?? {})
    this.workerEnvRegistry = deps.workerEnvRegistry
    this.parentSessionId = typeof deps.parentSessionId === 'string' && deps.parentSessionId.length > 0
      ? deps.parentSessionId
      : null
    this.evaluator = (deps.evaluator ?? new FrozenEvaluator({ plan: this.plan, output, logger: this.logger ?? null })) as RunnerDeps['evaluator'] & { hash: string | null }
    this.originalManifest = originalManifest
    this.selectionFile = selectionFile
    this.bestTime = this.clock.now()
    this.runId = deps.runId ?? basename(output)
    const grace = Number(deps.workerGraceMs)
    this.workerGraceMs = Number.isFinite(grace) && grace > 0 ? grace : DEFAULT_WORKER_GRACE_MS
  }

  now(): number {
    return this.clock.now()
  }

  async sleep(milliseconds: number): Promise<void> {
    if (milliseconds <= 0) return
    await this.clock.sleep(milliseconds, this.abort.signal)
  }

  stopped(): boolean {
    return this.cancelled || this.signal?.aborted === true || this.abort.signal.aborted
  }

  /** Whether the caller (not a sibling failure) stopped this batch. */
  intentionalStop(): boolean {
    return this.cancelled || this.signal?.aborted === true
  }

  checkCancelled(): void {
    if (this.stopped()) throw new ResearchStoppedError()
  }

  /** Stop scheduling and abort in-flight workers/evaluations. */
  stop(): void {
    this.cancelled = true
    this.abort.abort()
  }

  signalForWork(): AbortSignal {
    return combineSignals([this.abort.signal, this.signal]) ?? this.abort.signal
  }

  /** Remember a created state so a failed sibling or cohort cannot leak it. */
  private trackState(
    state: WorkspaceState | null | undefined,
    info: { id: string; parent?: string | null },
  ): void {
    if (!state) return
    if (this.trackedStates.has(state)) return
    this.trackedStates.set(state, {
      id: info.id,
      parent: info.parent ?? null,
      workspace: state.path,
    })
  }

  /**
   * Record rows in the dashboard exactly once.
   *
   * Cooperative cohorts record each epoch as it finishes (so earlier epochs
   * keep their trajectories) while `runBatch` records the final epoch, so this
   * has to be idempotent.
   */
  recordRows(rows: TrajectoryRow[]): void {
    for (const row of rows) {
      if (!this.rows.includes(row)) this.rows.push(row)
    }
  }

  /** Clear the row handles that point at a state whose release succeeded. */
  private markReleased(state: WorkspaceState): void {
    for (const row of this.rows) {
      if (row._state !== state) continue
      row._state = null
      row._released = true
    }
    for (const row of this.abandoned) {
      if (row._state !== state) continue
      row._state = null
      row._released = true
    }
  }

  /**
   * Release one state. The handle is retained when the backend refuses, so a
   * later `releaseAll()` can retry and `pendingWorkspaces()` still reports it.
   */
  private async releaseTracked(
    state: WorkspaceState,
    discard: boolean,
    label: string,
    keepReported = false,
  ): Promise<boolean> {
    try {
      await this.manager.release(state, { discard })
    } catch (error) {
      this.logger?.warn?.(`[auto-research] ${label} release failed: ${(error as Error).message}`)
      return false
    }
    this.releasedStates.add(state)
    if (!keepReported) this.activeStates.delete(state)
    this.markReleased(state)
    return true
  }

  /**
   * Await a worker activation, but never past a short grace after its signal
   * aborts. A provider that ignores abort gets disposed and the batch moves on.
   */
  private async awaitActivationResult(
    activation: SubagentRun,
    signal: AbortSignal | undefined,
    dispose: () => Promise<void>,
  ): Promise<SubagentResult> {
    if (!signal) return activation.result
    if (signal.aborted) {
      void dispose()
      throw new ResearchStoppedError('Worker activation aborted before it started')
    }
    return new Promise<SubagentResult>((resolvePromise, rejectPromise) => {
      let settled = false
      let grace: NodeJS.Timeout | undefined
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(grace)
        signal.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = (): void => {
        void dispose()
        grace = setTimeout(() => {
          finish(() => rejectPromise(new ResearchStoppedError('Worker activation ignored abort; bounded wait expired')))
        }, this.workerGraceMs)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      activation.result.then(
        value => finish(() => resolvePromise(value)),
        (error: unknown) => finish(() => rejectPromise(error)),
      )
    })
  }

  /** Wait for a disposal, but do not let a stuck provider hold the batch. */
  private async disposeWithin(disposal: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const grace = new Promise<void>(resolvePromise => {
      timer = setTimeout(resolvePromise, this.workerGraceMs)
    })
    try {
      await Promise.race([disposal, grace])
    } finally {
      clearTimeout(timer)
    }
  }

  metricDiagnostics(): MetricDiagnostic[] {
    const validRows = this.rows.filter(row => row.evaluation?.valid === true)
    return (this.plan.metrics ?? []).map(metric => {
      const values = validRows
        .filter(row => Object.hasOwn(row.evaluation.metrics ?? {}, metric.name))
        .map(row => (row.evaluation.metrics ?? {})[metric.name])
      // Canonical JSON keeps `{a,b}` and `{b,a}` comparable, so a metric is not
      // reported as varying only because its object keys were reordered.
      const distinct = new Set(values.map(value => canonicalJson(value)))
      return {
        name: metric.name,
        observations: values.length,
        missing_observations: validRows.length - values.length,
        distinct_values: distinct.size,
        constant_in_observed_checkpoints: values.length > 1 && distinct.size === 1,
      }
    })
  }

  dashboard(): Record<string, unknown> {
    return {
      metrics: this.plan.metrics ?? [],
      metric_diagnostics: this.metricDiagnostics(),
      trajectories: this.rows.map(publicRow),
    }
  }

  async checkDisk(workspace: string, count: number): Promise<void> {
    // Both backends materialize a host copy per branch (the snapshot backend
    // duplicates the tree, the LayerFS backend stages Sandbox mounts), so the
    // free-space check applies to both.
    const files = await inventory(workspace)
    const required = (await inventoryBytes(workspace, files)) * count
    const free = await freeBytes(this.output)
    if (required >= free) {
      throw new Error('Insufficient space for this cohort; existing research preserved')
    }
  }

  views(count: number): MetricView[] {
    if (!this.options.rsiTop) {
      return Array.from({ length: count }, () => ({ definitions: [], diagnostics: [], rows: [] }))
    }
    return sampleMetricViews({
      metrics: this.plan.metrics,
      subset: this.plan.metric_subset,
      count,
      diagnostics: this.metricDiagnostics(),
      rows: this.rows.map(row => ({
        id: row.id,
        parent: row.parent,
        workspace: row.workspace,
        evaluation: row.evaluation,
      })),
      rng: this.rng,
    })
  }

  /** Run all branches; one unexpected rejection aborts its siblings. */
  private async runBranches(tasks: Array<Promise<TrajectoryRow>>): Promise<TrajectoryRow[]> {
    const guarded = tasks.map(task => task.catch((error: unknown) => {
      this.abort.abort()
      throw error
    }))
    const settled = await Promise.allSettled(guarded)
    const rows: TrajectoryRow[] = []
    let firstError: unknown = null
    let inducedStop: unknown = null
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        rows.push(outcome.value)
        continue
      }
      // A sibling failure aborts its peers; those induced stop errors must not
      // mask the underlying unexpected error in the batch diagnostic.
      if (outcome.reason instanceof ResearchStoppedError) {
        if (inducedStop === null) inducedStop = outcome.reason
      } else if (firstError === null) {
        firstError = outcome.reason
      }
    }
    if (firstError !== null || inducedStop !== null) {
      // The cohort is aborting. Keep the fulfilled siblings on record so their
      // artifacts and mounted states are committed/released by releaseAll().
      this.abandoned.push(...rows)
      if (firstError !== null) throw firstError
      throw inducedStop
    }
    return rows
  }

  async run(): Promise<BatchResult> {
    try {
      return await this.runBatch()
    } catch (error) {
      if (this.intentionalStop()) {
        await this.writeStoppedResult().catch(() => {})
      }
      throw error
    }
  }

  /** Persist the honest cancellation artifact (idempotent). */
  async writeStoppedResult(): Promise<Record<string, unknown>> {
    const result = {
      status: 'STOPPED',
      stop_reason: 'stopped',
      pending_workspaces: this.pendingWorkspaces(),
      artifacts_preserved: true,
    }
    await writeJsonAtomic(join(this.output, 'RESULT.json'), result)
    return result
  }

  /** Live branches that have not been committed/unmounted yet. */
  pendingWorkspaces(): Array<Record<string, unknown>> {
    const pending = new Map<string, Record<string, unknown>>()
    for (const row of [...this.rows, ...this.abandoned]) {
      if (!row._state || row._released || row.id === 'initial') continue
      pending.set(row.workspace, {
        id: row.id,
        workspace: row.workspace,
        branch: row._state.branch ?? null,
      })
    }
    for (const [state, active] of this.activeStates) {
      pending.set(active.workspace, {
        id: active.id,
        parent: active.parent,
        workspace: active.workspace,
        branch: state.branch ?? null,
      })
    }
    // States created for a sibling that never produced a row (or whose row
    // release failed) still hold a mount and must be reported.
    for (const [state, info] of this.trackedStates) {
      if (this.releasedStates.has(state) || info.id === 'initial') continue
      if (pending.has(info.workspace)) continue
      pending.set(info.workspace, {
        id: info.id,
        parent: info.parent,
        workspace: info.workspace,
        branch: state.branch ?? null,
      })
    }
    return [...pending.values()]
  }

  private async runBatch(): Promise<BatchResult> {
    const options = this.options
    await fsp.mkdir(this.output, { recursive: true })
    await writeJsonAtomic(join(this.output, 'PLAN.json'), this.plan)
    await writeJsonAtomic(join(this.output, 'CONFIG.json'), this.config)
    await this.evaluator.freeze()

    const initialFolder = join(this.output, 'initial')
    await fsp.mkdir(initialFolder, { recursive: true })
    const baseState = this.deps.initialState
      ? { ...this.deps.initialState, id: 'initial' }
      : await this.manager.baseline(this.workspace, 'initial')
    this.trackState(baseState, { id: 'initial', parent: null })
    const baseManifest = await inventory(baseState.path)
    await writeJsonAtomic(join(initialFolder, 'INPUT-MANIFEST.json'), baseManifest)
    const initial: TrajectoryRow = {
      id: 'initial',
      parent: null,
      workspace: baseState.path,
      provider_session: null,
      evaluation: await this.evaluator.evaluate(baseState.path, initialFolder, {
        signal: this.signalForWork(),
        now: () => this.now(),
      }),
      time: Date.now(),
      _state: baseState,
      _ownsState: true,
    }
    this.rows.push(initial)
    if (initial.evaluation.valid !== true) {
      const reason = initial.evaluation.reason ?? 'unknown evaluation failure'
      await writeJsonAtomic(join(this.output, 'RESULT.json'), {
        status: 'FAILED',
        error: 'Initial candidate failed frozen evaluation; no research workers started: ' + reason,
        artifacts_preserved: true,
      })
      throw new Error('Initial candidate failed frozen evaluation; no research workers started: ' + reason)
    }
    this.anchor = scoreValue(initial.evaluation.score)
    this.bestTime = this.now()

    let leader: TrajectoryRow = initial
    for (let roundNumber = 1; roundNumber <= options.rounds; roundNumber += 1) {
      this.checkCancelled()
      const stalled = Boolean(options.rsiTop
        && (this.plan.stall_seconds ?? Number.POSITIVE_INFINITY) > 0
        && (this.now() - this.bestTime) / 1000 >= (this.plan.stall_seconds ?? Number.POSITIVE_INFINITY))
      const explore = Boolean(options.forkAndFlush || (options.rsiTop && stalled))
      const phases: Phase[] = explore ? ['explore', 'continue'] : ['continue']
      for (const phase of phases) {
        this.checkCancelled()
        await writeJsonAtomic(join(this.output, 'DASHBOARD.json'), this.dashboard())
        const count = phase === 'explore' ? options.branches : 1
        await this.checkDisk(leader.workspace, count)
        const views = this.views(count)
        let candidates: TrajectoryRow[]
        if (options.shareContext) {
          candidates = await this.cooperativeCohort(leader, count, phase, roundNumber, views)
        } else {
          candidates = await this.runBranches(Array.from({ length: count }, (_, index) => this.branch(
            leader,
            index,
            phase,
            join(this.output, `round-${roundNumber}-${phase}-${index + 1}`),
            views[index],
          )))
        }
        this.recordRows(candidates)
        if (candidates.some(candidate => candidate.collaboration_failed)) {
          throw new Error('Peer checkpoint/review protocol failed; all evidence preserved and no candidate promoted')
        }
        await writeJsonAtomic(join(this.output, 'DASHBOARD.json'), this.dashboard())
        if (!candidates.some(candidate => candidate.completed)) {
          const budget = (candidates.length === 0 || candidates.every(candidate => candidate.timed_out))
          if (leader.evaluation?.valid === true && budget) {
            this.timedOutRows = candidates
            return this.finish(leader, 'phase_budget_reached', candidates)
          }
          throw new Error('No provider branch completed; inspect preserved logs before retrying')
        }
        const previous = leader
        leader = this.choose(leader, candidates)
        await this.recycle(candidates, leader, previous)
        this.selections.push({
          round: roundNumber,
          phase,
          previous: previous.id,
          selected: leader.id,
          score: leader.evaluation.score,
          selection_metrics: this.plan.selection_metrics ?? [],
          candidate_scores: Object.fromEntries(candidates.map(candidate => [candidate.id, candidate.evaluation?.score ?? null])),
        })
        await writeJsonAtomic(join(this.output, 'SELECTIONS.json'), this.selections)
        const current = scoreValue(leader.evaluation.score)
        let gain = this.anchor === null ? null : current - this.anchor
        if (gain !== null && this.plan.direction === 'minimize') gain = -gain
        if (this.anchor === null || (gain !== null && gain > this.plan.meaningful_gain)) {
          this.anchor = current
          this.bestTime = this.now()
        }
        await writeJsonAtomic(join(this.output, 'LEADER.json'), publicRow(leader))
        await this.writeSelection(leader)
        this.logger?.info?.(`[auto-research] round ${roundNumber}/${options.rounds} ${phase}: leader=${leader.id} score=${current}`)
      }
    }
    return this.finish(leader)
  }

  async writeSelection(leader: TrajectoryRow): Promise<void> {
    if (!this.selectionFile) return
    await writeJsonAtomic(this.selectionFile, {
      leader_workspace: leader.workspace,
      leader_branch: leader._state?.branch ?? null,
      original_manifest: this.originalManifest,
      run: this.output,
      updated_at: new Date().toISOString(),
    })
  }

  private peerSlotsOf(rows: TrajectoryRow[]): PeerSlot[] {
    for (const row of rows) {
      if (row.completed && !row.collaboration_failed && row.shared_checkpoint) {
        const key = `${row.phase ?? 'explore'}:${row.collaborator ?? 0}`
        this.peerSlots[key] = {
          id: row.id,
          parent: row.parent,
          phase: row.phase,
          collaborator: row.collaborator,
          evaluation: row.evaluation,
          checkpoint: row.shared_checkpoint,
          workspace: row.workspace,
          transcript: join(row.workspace, 'provider.jsonl'),
          notes: join(row.workspace, 'RESEARCH_HANDOFF.md'),
        }
      }
    }
    return Object.values(this.peerSlots)
  }

  async publishPeers(rows: TrajectoryRow[], folder: string): Promise<string | null> {
    const peers = this.peerSlotsOf(rows)
    if (peers.length === 0) return null
    const path = join(folder, 'PEER-EVIDENCE.json')
    await fsp.mkdir(folder, { recursive: true })
    await writeJsonAtomic(path, buildPeerEvidence({ objective: this.plan.objective, peers }))
    await fsp.chmod(path, 0o444)
    this.peerBundle = path
    const context = buildZeroSynthesisContext({
      objective: this.plan.objective,
      checkpoints: peers.map(peer => ({
        id: peer.id,
        summary: peer.checkpoint.summary,
        files: peer.checkpoint.files,
        checkout: peer.workspace,
        transcript: peer.transcript,
        notes: peer.notes,
      })),
    })
    await writeSharedContextAtomic(join(folder, 'shared-context.md'), context, { mode: 0o600 })
    return path
  }

  async cooperativeCohort(
    leader: TrajectoryRow,
    count: number,
    phase: Phase,
    roundNumber: number,
    views: MetricView[],
  ): Promise<TrajectoryRow[]> {
    const minutes = phase === 'explore' ? this.options.explorationMinutes : this.options.exploitationMinutes
    const seconds = 60 * minutes
    const interval = 60 * this.options.sharingIntervalMinutes
    const start = this.now()
    const deadline = start + seconds * 1000
    let parents: TrajectoryRow[] = Array.from({ length: count }, () => leader)
    const history: Array<Record<string, unknown>> = []
    const checkpoints: Array<string | null> = new Array(count).fill(null)
    let previousSharedContext: string | null = null
    let epoch = 0
    while (true) {
      this.checkCancelled()
      const remaining = (deadline - this.now()) / 1000
      if (remaining <= this.plan.evaluation_seconds) break
      const shareAt = Math.min(deadline, start + (epoch + 1) * interval * 1000)
      const prefix = `round-${roundNumber}-${phase}-epoch-${epoch + 1}`
      const bundle = this.peerBundle
      const candidates = await this.runBranches(parents.map((parent, index) => this.branch(
        parent,
        index,
        phase,
        join(this.output, `${prefix}-branch-${index + 1}`),
        views[index] ?? { definitions: [], diagnostics: [], rows: [] },
        {
          resume: epoch > 0,
          bundle,
          deadline,
          shareAt,
          count,
          seconds: remaining,
          index,
          sharedContext: previousSharedContext,
        },
      )))
      for (let index = 0; index < candidates.length; index += 1) {
        const row = candidates[index]
        if (row && row.completed && row.evaluation?.valid === true && !row.collaboration_failed) {
          checkpoints[index] = await this.manager.retainCompletedState(publicRow(row))
        }
      }
      const publication = join(this.output, `${prefix}-shared`)
      const published = await this.publishPeers(candidates, publication)
      if (published) previousSharedContext = join(publication, 'shared-context.md')
      history.push({
        epoch: epoch + 1,
        target_seconds: (shareAt - start) / 1000,
        actual_seconds: (this.now() - start) / 1000,
        rows: candidates.map(publicRow),
        peer_bundle: this.peerBundle,
        shared_context: previousSharedContext,
      })
      await writeJsonAtomic(join(this.output, `round-${roundNumber}-${phase}-COLLABORATION.json`), {
        phase_budget_seconds: seconds,
        sharing_interval_seconds: interval,
        epochs: history,
      })
      const incomplete = candidates.some(row => !row.completed
        || row.evaluation?.valid !== true
        || row.collaboration_failed
        || !row.provider_session)
      if (incomplete) {
        const restored: TrajectoryRow[] = []
        for (let index = 0; index < candidates.length; index += 1) {
          const row = candidates[index]
          if (!row) continue
          const broken = !row.completed || row.evaluation?.valid !== true || row.collaboration_failed
          const checkpoint = checkpoints[index]
          if (checkpoint && broken) {
            await this.preserveUnverified(row)
            restored.push(await this.manager.restoreCompletedState(checkpoint, publicRow(row)))
          } else {
            restored.push(row)
          }
        }
        this.claimCohortOwnership(restored, parents, leader)
        return restored
      }
      // Earlier epochs are real, evaluated trajectories: record them before the
      // next epoch replaces the working set. `runBatch` records the final epoch
      // (or its restored rows) through the idempotent `recordRows`.
      this.recordRows(candidates)
      this.claimCohortOwnership(candidates, parents, leader)
      parents = candidates
      epoch += 1
      const wait = shareAt - this.now()
      if (wait > 0) await this.sleep(wait)
    }
    return history.length > 0 ? parents : []
  }

  /**
   * Hand branch ownership to the rows a cohort returns.
   *
   * Epoch 0 forks a state (`_ownsState: true`); epoch 1+ resumes that same
   * state (`_ownsState: false`). `recycle` only commits/unmounts rows it owns,
   * so without this transfer every multi-epoch cooperative branch would leak
   * its Sandbox mount until the batch ended and the leader would never be
   * committed.
   */
  private claimCohortOwnership(
    returned: TrajectoryRow[],
    parents: TrajectoryRow[],
    incumbent?: TrajectoryRow,
  ): void {
    for (const parent of parents) {
      if (parent === incumbent || !parent._state || returned.includes(parent)) continue
      parent._ownsState = false
    }
    for (const row of returned) {
      if (row._state) row._ownsState = true
    }
  }

  async branch(
    parent: TrajectoryRow,
    index: number,
    phase: Phase,
    folder: string,
    view: MetricView = { definitions: [], diagnostics: [], rows: [] },
    cooperation: {
      resume: boolean
      bundle: string | null
      deadline: number
      shareAt: number
      count: number
      seconds: number
      index: number
      sharedContext: string | null
    } | null = null,
  ): Promise<TrajectoryRow> {
    await fsp.mkdir(folder, { recursive: true })
    const resume = Boolean(cooperation?.resume)
    let state: WorkspaceState | undefined
    let ownsState = false
    try {
      if (resume) {
        state = parent._state ?? undefined
        if (!state) throw new Error('Cooperative resume requires the parent workspace')
      } else {
        this.checkCancelled()
        state = await this.manager.fork(parent._state as WorkspaceState, basename(folder))
        ownsState = true
      }
      const checkout = state.path
      this.trackState(state, { id: basename(folder), parent: parent.id })
      this.activeStates.set(state, { id: basename(folder), parent: parent.id, workspace: checkout })
      const manifest = await inventory(checkout)
      await writeJsonAtomic(join(folder, 'INPUT-MANIFEST.json'), manifest)

      const minutes = phase === 'explore' ? this.options.explorationMinutes : this.options.exploitationMinutes
      let seconds = 60 * minutes
      if (cooperation) {
        seconds = Math.max(0, (cooperation.deadline - this.now()) / 1000)
        if (seconds <= 0) {
          throw new Error('Cohort budget exhausted before invocation; no extra turn started')
        }
      }
      const target = cooperation
        ? Math.min(
          Math.max(0, seconds - this.plan.evaluation_seconds),
          Math.max(0, (cooperation.shareAt - this.now()) / 1000),
        )
        : seconds
      const session = phase === 'continue' || resume ? parent.provider_session ?? null : null

      let peer: { path: string; digest: string; ids: string[] } | null = null
      if (cooperation?.bundle) {
        const bundleText = await fsp.readFile(cooperation.bundle, 'utf8')
        const bundle = JSON.parse(bundleText)
        peer = {
          path: join(checkout, 'SHARED_CONTEXT', `peer-evidence-${basename(folder)}.json`),
          digest: '',
          ids: peerIdsOf(bundle),
        }
        await fsp.mkdir(join(checkout, 'SHARED_CONTEXT'), { recursive: true })
        await fsp.writeFile(peer.path, bundleText)
        await fsp.chmod(peer.path, 0o444)
        peer.digest = await digestFile(peer.path)
      }

      let sharedContextPath: string | null = null
      if (cooperation?.sharedContext) {
        const targetFile = join(checkout, 'SHARED_CONTEXT', 'shared-context.md')
        await fsp.mkdir(join(checkout, 'SHARED_CONTEXT'), { recursive: true })
        await fsp.copyFile(cooperation.sharedContext, targetFile)
        try {
          await fsp.chmod(targetFile, 0o600)
        } catch {
          // Read-only mounts still receive the bytes.
        }
        sharedContextPath = targetFile
      }

      let handoff: { from: string; text: string; path?: string } | null = null
      if ((phase === 'continue' || resume) && typeof parent.last_output === 'string' && parent.last_output.trim() !== '') {
        const handoffPath = join(checkout, '.auto-research-methods-handoff.md')
        await fsp.writeFile(handoffPath, parent.last_output, { mode: 0o600 })
        handoff = { from: parent.id, text: parent.last_output, path: handoffPath }
      }

      const branchEnv: Record<string, string> = { ...this.workerEnv }
      // The worker flag belongs to the live registry entry, never to a copied
      // environment value.
      for (const key of Object.keys(branchEnv)) {
        if (key.startsWith('DSH_AUTO_RESEARCH_')) delete branchEnv[key]
      }
      if (state.branch) branchEnv.DSH_AUTO_RESEARCH_BRANCH = state.branch
      if (state.sandboxPath) branchEnv.DSH_AUTO_RESEARCH_SANDBOX_PATH = state.sandboxPath
      branchEnv.DSH_AUTO_RESEARCH_CHECKOUT = checkout

      const prompt = buildWorkerPrompt({
        plan: this.plan,
        parent: publicRow(parent),
        checkout,
        phase,
        view,
        options: this.options,
        cooperation: cooperation
          ? { index, count: cooperation.count, target, seconds }
          : null,
        peer,
        env: branchEnv,
        provider: this.workerProvider,
        policy: workerPolicy({ cooperation: Boolean(cooperation) }),
        seconds,
        handoff,
        sharedContext: sharedContextPath,
      })
      await writeJsonAtomic(join(folder, 'LAUNCH.json'), {
        phase,
        parent: parent.id,
        fresh_context: !session,
        provider_session: session,
        seconds,
        metric_view: view,
        cooperative_resume: resume,
        peer_manifest_sha256: peer?.digest ?? null,
        share_target_unix: cooperation ? Date.now() + Math.max(0, cooperation.shareAt - this.now()) : null,
        worker_provider: this.workerProvider,
        environment: Object.keys(branchEnv),
        handoff_from: handoff?.from ?? null,
        handoff_path: handoff?.path ?? null,
        shared_context: sharedContextPath,
        workspace_branch: state.branch,
        sandbox_path: state.sandboxPath,
      })
      const providerSeconds = cooperation ? seconds - this.plan.evaluation_seconds : seconds
      await writeJsonAtomic(join(folder, 'BUDGET.json'), {
        provider_seconds: providerSeconds,
        evaluation_reserve_seconds: cooperation ? this.plan.evaluation_seconds : 0,
      })
      if (providerSeconds <= 0) {
        throw new Error('No provider window remains after reserving evaluation')
      }

      const started = Date.now()
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), providerSeconds * 1000)
      timer.unref?.()
      const signal = combineSignals([this.signalForWork(), timeout.signal])
      let result: SubagentResult | undefined
      let childId: string | null = null
      const providerEvents: Array<Record<string, unknown>> = [{
        type: 'prompt',
        at: new Date(started).toISOString(),
        provider: this.workerProvider,
        text: prompt,
      }]
      // Register the branch environment before the worker starts, so its very
      // first `bash` call already receives DSH_AUTO_RESEARCH_*: `dsh` resolves
      // `ctx.shellEnv` per execution, and the resolver matches this checkout.
      const workerRegistration = this.workerEnvRegistry?.register({
        id: basename(folder),
        checkout,
        parentSessionId: this.parentSessionId,
        env: branchEnv,
      }) ?? null
      try {
        const activation = await this.subagents.startActivation({
          provider: this.workerProvider,
          label: `${this.runId}:${basename(folder)}`,
          request: {
            cwd: checkout,
            prompt: [{ type: 'text', text: prompt }],
            parent: this.parent,
          },
          ...(signal ? { signal } : {}),
          delivery: 'caller',
        })
        childId = activation.childId ?? null
        if (childId) workerRegistration?.setChildSession(childId)
        let disposal: Promise<void> | null = null
        const disposeOnce = (): Promise<void> => {
          if (!disposal) {
            disposal = (async () => {
              try {
                await activation.dispose()
              } catch (error) {
                this.logger?.warn?.(`[auto-research] worker dispose failed: ${(error as Error).message}`)
              }
            })()
          }
          return disposal
        }
        try {
          result = await this.awaitActivationResult(activation, signal, disposeOnce)
        } finally {
          // An abort may have started disposal already; never await it past the
          // same short grace, so a provider that ignores abort cannot hang.
          await this.disposeWithin(disposeOnce())
        }
      } finally {
        clearTimeout(timer)
        workerRegistration?.dispose()
      }
      this.checkCancelled()
      const assistantText = outputText(result?.output)
      providerEvents.push({
        type: 'assistant',
        at: new Date().toISOString(),
        text: assistantText,
      })
      providerEvents.push({
        type: 'result',
        at: new Date().toISOString(),
        stop_reason: result?.stopReason ?? 'error',
        diagnostic: result?.diagnostic ?? null,
        duration_ms: Date.now() - started,
      })
      await fsp.writeFile(
        join(folder, 'provider.jsonl'),
        providerEvents.map(event => JSON.stringify(event)).join('\n') + '\n',
      )
      const completed = result?.stopReason === 'completed'
      const timedOut = result?.stopReason === 'aborted' && !this.stopped()
      const outcome: ProviderOutcome = {
        completed,
        provider_session: childId ?? session,
        terminal: result?.stopReason ?? 'error',
        diagnostic_count: result?.diagnostic ? 1 : 0,
      }
      const row: TrajectoryRow = {
        id: basename(folder),
        parent: parent.id,
        phase,
        collaborator: index + 1,
        workspace: checkout,
        provider_session: outcome.provider_session,
        exit_code: completed ? 0 : null,
        timed_out: timedOut,
        completed,
        provider_outcome: outcome,
        time: Date.now(),
        last_output: assistantText,
        ...(handoff?.path ? { handoff_path: handoff.path } : {}),
        evaluation: completed
          ? await this.evaluator.evaluate(checkout, folder, {
            ...(cooperation ? { deadline: cooperation.deadline } : {}),
            signal: this.signalForWork(),
            now: () => this.now(),
          })
          : { valid: false, reason: 'Provider did not complete successfully' },
        ...(result?.diagnostic ? { diagnostic: result.diagnostic } : {}),
      }
      if (row.completed && this.options.rsiTop && phase === 'explore') {
        try {
          const portfolio = JSON.parse(await fsp.readFile(join(checkout, 'PORTFOLIO.json'), 'utf8'))
          validatePortfolio(portfolio, { portfolioSize: this.plan.portfolio_size, parentId: parent.id })
          row.portfolio_sha256 = await digestFile(join(checkout, 'PORTFOLIO.json'))
        } catch (error) {
          row.evaluation = { valid: false, reason: 'RSI portfolio protocol: ' + (error as Error).message }
        }
      }
      if (cooperation && row.completed) {
        try {
          row.shared_checkpoint = await readSharedCheckpoint(checkout)
          if (peer) {
            if (await digestFile(peer.path) !== peer.digest) throw new Error('Peer evidence snapshot changed')
            const review = JSON.parse(await fsp.readFile(join(checkout, 'PEER-REVIEW.json'), 'utf8'))
            validatePeerReview(review, { peerDigest: peer.digest, peerIds: peer.ids })
            row.peer_review_sha256 = await digestFile(join(checkout, 'PEER-REVIEW.json'))
            row.peer_manifest_sha256 = peer.digest
            await writeJsonAtomic(join(folder, 'PEER-REVIEW.json'), review)
          }
        } catch (error) {
          row.evaluation = { valid: false, reason: 'Collaboration protocol: ' + (error as Error).message }
          row.collaboration_failed = true
        }
      }
      await writeJsonAtomic(join(folder, 'RESULT.json'), publicRow(row))
      this.activeStates.delete(state)
      return { ...row, _state: state, _ownsState: ownsState }
    } catch (error) {
      if (ownsState && state) {
        const stopped = this.intentionalStop()
        const orphan: TrajectoryRow = {
          id: basename(folder),
          parent: parent.id,
          phase,
          workspace: state.path,
          evaluation: { valid: false, reason: stopped ? 'Branch stopped before completion' : 'Branch aborted before completion' },
          completed: false,
          _state: state,
          _ownsState: true,
          _released: false,
        }
        this.abandoned.push(orphan)
        // Cancellation and an unexpected provider error both preserve the
        // branch: its partial evidence is committed and the mount is released
        // without discarding, so a reviewer can inspect what the worker did.
        try {
          await this.manager.commit(state, { message: `auto-research: unverified ${orphan.id}` })
        } catch (commitError) {
          this.logger?.warn?.(`[auto-research] branch commit failed: ${(commitError as Error).message}`)
        }
        // A stop still reports the pending path in RESULT.json before cleanup.
        await this.releaseTracked(state, false, 'branch', stopped)
      }
      throw error
    }
  }

  choose(incumbent: TrajectoryRow, candidates: TrajectoryRow[]): TrajectoryRow {
    const eligible = [incumbent, ...candidates].filter(row => row.evaluation?.valid === true)
    if (eligible.length === 0) throw new Error('No valid evaluated branch; all work retained')
    const key = (row: TrajectoryRow): number[] => {
      let primary = scoreValue(row.evaluation.score)
      if (this.plan.direction === 'minimize') primary = -primary
      const progress = (this.plan.selection_metrics ?? []).map(spec => {
        const value = scoreValue(row.evaluation.metrics?.[spec.name], `selection metric ${spec.name}`)
        return spec.direction === 'maximize' ? value : -value
      })
      return [primary, ...progress, row.id !== 'initial' ? 1 : 0, row.time ?? 0]
    }
    const ordered = [...eligible].sort((a, b) => compareKeys(key(b), key(a)))
    const selected = ordered[0]
    if (!selected) throw new Error('No valid evaluated branch; all work retained')
    return selected
  }

  /**
   * Commit and unmount this phase's branches. A completed branch that failed
   * science is preserved as `rejected`, never discarded; only a branch that
   * never completed is treated as unverified. No state is released twice.
   */
  async recycle(candidates: TrajectoryRow[], leader: TrajectoryRow, previous?: TrajectoryRow): Promise<void> {
    for (const row of candidates) {
      if (!row._ownsState || !row._state) continue
      if (this.releasedStates.has(row._state)) {
        row._state = null
        row._released = true
        continue
      }
      const state = row._state
      if (row.id === leader.id) {
        try {
          await this.manager.commit(state, { message: `auto-research: verified ${row.id}` })
        } catch (error) {
          this.logger?.warn?.(`[auto-research] commit failed: ${(error as Error).message}`)
        }
        // The leader stays mounted: the next phase continues from this exact
        // workspace, and `releaseAll()` commits/unmounts it at batch end.
        continue
      }
      {
        const valid = row.evaluation?.valid === true
        const completed = row.completed === true
        const label = valid ? 'verified' : completed ? 'rejected' : 'unverified'
        try {
          await this.manager.commit(state, { message: `auto-research: ${label} ${row.id}` })
        } catch (error) {
          this.logger?.warn?.(`[auto-research] commit failed: ${(error as Error).message}`)
        }
      }
      // Mark released only after the backend confirms it; a failed release
      // keeps the handle for `releaseAll()` and `pendingWorkspaces()`.
      await this.releaseTracked(state, false, 'release')
    }
    // A defeated leader (the baseline, or an earlier round's leader) is no
    // longer the working branch. Commit and unmount it now instead of holding
    // its Sandbox mount for the rest of the batch.
    await this.releaseSuperseded(previous, leader)
  }

  /** Commit and release the state of a leader that lost the selection. */
  private async releaseSuperseded(previous: TrajectoryRow | undefined, leader: TrajectoryRow): Promise<void> {
    if (!previous) return
    if (previous.id === leader.id) return
    const state = previous._state
    if (!state) return
    if (state === leader._state) return
    if (this.releasedStates.has(state)) {
      previous._state = null
      previous._released = true
      return
    }
    try {
      await this.manager.commit(state, { message: `auto-research: release ${previous.id}` })
    } catch (error) {
      this.logger?.warn?.(`[auto-research] superseded commit failed: ${(error as Error).message}`)
    }
    await this.releaseTracked(state, false, 'release')
  }

  async finish(
    leader: TrajectoryRow,
    reason = 'configured_batch_complete',
    pending: TrajectoryRow[] | null = null,
  ): Promise<BatchResult> {
    const unfinished: Record<string, Record<string, unknown>> = {}
    for (const row of pending ?? []) {
      unfinished[row.workspace] = {
        id: row.id,
        workspace: row.workspace,
        status: 'requires_independent_review',
        timed_out: Boolean(row.timed_out),
      }
    }
    for (const row of this.rows) {
      if (row.pending_workspace) {
        unfinished[row.pending_workspace] = {
          id: row.incomplete_successor,
          workspace: row.pending_workspace,
          status: 'requires_independent_review',
        }
      }
    }
    const result: BatchResult = {
      status: 'COMPLETED',
      leader: publicRow(leader),
      workspace_modified: false,
      stop_reason: reason,
      pending_workspaces: Object.values(unfinished),
      result_file: join(this.output, 'RESULT.json'),
      scope: 'Batch boundary only. Unfinished artifacts remain unverified; no research completion or benchmark gain claimed.',
      evaluator_sha256: this.evaluator.hash,
      trajectories: this.rows.length,
    }
    await writeJsonAtomic(join(this.output, 'DASHBOARD.json'), this.dashboard())
    await writeJsonAtomic(join(this.output, 'LEADER.json'), publicRow(leader))
    await this.writeSelection(leader)
    await writeJsonAtomic(join(this.output, 'RESULT.json'), result)
    return result
  }

  /** Release every mounted workspace at the end of a batch. */
  async releaseAll(): Promise<void> {
    const rows = [...this.rows, ...this.abandoned]
    const byState = new Map<WorkspaceState, TrajectoryRow>()
    for (const row of rows) {
      if (row._state) byState.set(row._state, row)
    }
    const states = new Set<WorkspaceState>([...this.trackedStates.keys(), ...byState.keys()])
    let incomplete = false
    for (const state of states) {
      if (this.releasedStates.has(state)) {
        this.markReleased(state)
        continue
      }
      const row = byState.get(state)
      const valid = row?.evaluation?.valid === true
      const completed = row?.completed === true
      const id = row?.id ?? this.trackedStates.get(state)?.id ?? ''
      try {
        if (valid) await this.manager.commit(state, { message: `auto-research: retained ${id}` })
        else if (completed) await this.manager.commit(state, { message: `auto-research: rejected ${id}` })
        else await this.manager.commit(state, { message: `auto-research: unverified ${id}` })
      } catch (error) {
        this.logger?.warn?.(`[auto-research] final commit failed: ${(error as Error).message}`)
      }
      const released = await this.releaseTracked(state, false, 'final')
      if (!released) incomplete = true
    }
    // Keep the manager (and its LayerFS client) open while a state is still
    // mounted, so a later releaseAll() can retry.
    if (incomplete || this.managerClosed) return
    this.managerClosed = true
    try {
      await this.manager.close?.()
    } catch (error) {
      this.logger?.warn?.(`[auto-research] workspace close failed: ${(error as Error).message}`)
    }
  }

  /** Keep an unverified workspace available for independent review. */
  async preserveUnverified(row: TrajectoryRow): Promise<void> {
    const state = row._state
    if (!state || this.releasedStates.has(state)) {
      row._state = null
      row._released = true
      return
    }
    try {
      await this.manager.commit(state, { message: `auto-research: unverified ${row.id}` })
    } catch (error) {
      this.logger?.warn?.(`[auto-research] unverified commit failed: ${(error as Error).message}`)
    }
    await this.releaseTracked(state, false, 'unverified')
  }
}

export { jsonDigest, buildZeroSynthesisContext, publicRow }
export { DEFAULT_CLOCK }
