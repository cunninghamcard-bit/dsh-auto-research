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
} from './protocols.js'
import { buildWorkerPrompt, RESEARCH_METHODS_POLICY, RESEARCH_POLICY, CONTINUE_POLICY } from './policies.js'

/** Raised when a batch is stopped by the caller; artifacts are retained. */
export class ResearchStoppedError extends Error {
  constructor(message = 'Research stopped; artifacts retained') {
    super(message)
    this.name = 'ResearchStoppedError'
  }
}

const DEFAULT_CLOCK = {
  now: () => performance.now(),
  sleep: (milliseconds, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ResearchStoppedError())
      return
    }
    const timer = setTimeout(resolve, Math.max(0, milliseconds))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ResearchStoppedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    timer.unref?.()
  }),
}

/** Merge plan-level option overrides over plugin configuration. */
export function normalizeOptions(config = {}, plan = {}) {
  return {
    rounds: config.rounds ?? 1,
    branches: config.branches ?? 4,
    explorationMinutes: config.explorationMinutes ?? 30,
    exploitationMinutes: config.exploitationMinutes ?? 30,
    rsiTop: config.rsiTop ?? false,
    forkAndFlush: config.forkAndFlush ?? false,
    shareContext: config.shareContext ?? false,
    sharingIntervalMinutes: config.sharingIntervalMinutes ?? 10,
    ...(plan.options && typeof plan.options === 'object' ? plan.options : {}),
  }
}

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Validate the model-written plan against the execution contract and return
 * normalized defaults. Values are never replaced with repository heuristics.
 */
export function validatePlan(plan, options) {
  if (plan === null || typeof plan !== 'object') throw new Error('Research plan must be a JSON object')
  if (typeof plan.objective !== 'string' || plan.objective.trim() === '') {
    throw new Error('Plan requires an objective')
  }
  if (typeof plan.worker_prompt !== 'string' || plan.worker_prompt.trim() === '') {
    throw new Error('Plan requires a worker_prompt')
  }
  if (typeof plan.evaluator !== 'string' || plan.evaluator.trim() === '') {
    throw new Error('Plan requires an evaluator script')
  }
  const evaluationSeconds = Number(plan.evaluation_seconds)
  if (!finitePositive(evaluationSeconds)) throw new Error('Invalid evaluator configuration')
  const direction = plan.direction ?? 'maximize'
  if (direction !== 'maximize' && direction !== 'minimize') {
    throw new Error('Invalid evaluator configuration')
  }
  const metrics = plan.metrics ?? []
  if (!Array.isArray(metrics)) throw new Error('Plan metrics must be an array')
  const names = []
  for (const metric of metrics) {
    if (!metric || typeof metric.name !== 'string' || metric.name.trim() === '') {
      throw new Error('Invalid fixed metric definitions or subset size')
    }
    names.push(metric.name)
  }
  if (new Set(names).size !== names.length) {
    throw new Error('Invalid fixed metric definitions or subset size')
  }
  const selectionMetrics = plan.selection_metrics ?? []
  if (!Array.isArray(selectionMetrics)) throw new Error('Selection metrics must be declared and independently evaluated')
  for (const spec of selectionMetrics) {
    if (!spec || !names.includes(spec.name) || (spec.direction !== 'maximize' && spec.direction !== 'minimize')) {
      throw new Error('Selection metrics must be declared and independently evaluated')
    }
  }
  if (!Number.isInteger(options.branches) || options.branches < 2 || !Number.isInteger(options.rounds) || options.rounds < 1) {
    throw new Error('Invalid branch/round budget')
  }
  for (const key of ['explorationMinutes', 'exploitationMinutes']) {
    if (!finitePositive(options[key])) throw new Error('Invalid time budget')
  }
  if (options.shareContext && !finitePositive(options.sharingIntervalMinutes)) {
    throw new Error('Invalid context sharing interval')
  }
  let stall = plan.stall_seconds ?? null
  let subset = plan.metric_subset ?? 1
  let portfolio = plan.portfolio_size ?? 2
  let gain = plan.meaningful_gain ?? 0
  if (options.rsiTop) {
    if (!Number.isInteger(subset) || subset < 1 || subset > names.length) {
      throw new Error('Invalid fixed metric definitions or subset size')
    }
    if (!finitePositive(stall)) throw new Error('Invalid model-defined RSI intervention parameters')
    try {
      gain = scoreValue(gain, 'meaningful_gain')
    } catch {
      throw new Error('Invalid model-defined RSI intervention parameters')
    }
    if (gain < 0 || !Number.isInteger(portfolio) || portfolio < 2) {
      throw new Error('Invalid model-defined RSI intervention parameters')
    }
  }
  return {
    ...plan,
    objective: plan.objective,
    worker_prompt: plan.worker_prompt,
    evaluator: plan.evaluator,
    evaluation_seconds: evaluationSeconds,
    direction,
    metrics,
    selection_metrics: selectionMetrics,
    stall_seconds: stall,
    metric_subset: subset,
    portfolio_size: portfolio,
    meaningful_gain: gain,
  }
}

/** Port of `provider_outcome`: transport diagnostics are not turn failures. */
export function providerOutcome(events = [], rc, timedOut) {
  let terminal = null
  let session = null
  const diagnostics = []
  for (const event of events) {
    const kind = event?.type
    if (kind === 'thread.started') session = event.thread_id
    if (event?.session_id) session = event.session_id
    if (kind === 'turn.completed') terminal = 'completed'
    else if (kind === 'turn.failed') terminal = 'failed'
    else if (kind === 'result') terminal = event.subtype === 'success' && !event.is_error ? 'completed' : 'failed'
    else if (kind === 'error' || event?.is_error) diagnostics.push(event)
  }
  return {
    completed: terminal === 'completed' && rc === 0 && !timedOut,
    provider_session: session,
    terminal,
    diagnostic_count: diagnostics.length,
  }
}

function combineSignals(signals) {
  const active = signals.filter(Boolean)
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

function compareKeys(a, b) {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1
    if (a[index] > b[index]) return 1
  }
  return 0
}

function mergeEnv(configured = {}, layerfsEnv = {}) {
  const result = {}
  const secret = /(token|key|secret|password|credential)/i
  for (const [key, value] of Object.entries({ ...layerfsEnv, ...configured })) {
    if (value === undefined || value === null) continue
    if (secret.test(key)) continue
    result[key] = String(value)
  }
  return result
}

/** One batch runner. */
export class Runner {
  constructor({ config = {}, plan, workspace, output, originalManifest = null, selectionFile = null, deps = {} }) {
    this.config = config
    this.options = normalizeOptions(config, plan)
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
    this.evaluator = deps.evaluator ?? new FrozenEvaluator({ plan: this.plan, output, logger: this.logger })
    this.originalManifest = originalManifest
    this.selectionFile = selectionFile
    this.rows = []
    this.selections = []
    this.peerBundle = null
    this.peerSlots = {}
    this.bestTime = this.clock.now()
    this.anchor = null
    this.cancelled = false
    this.abort = new AbortController()
    this.runId = deps.runId ?? basename(output)
    this.timedOutRows = []
  }

  now() {
    return this.clock.now()
  }

  async sleep(milliseconds) {
    if (milliseconds <= 0) return
    await this.clock.sleep(milliseconds, this.abort.signal)
  }

  stopped() {
    return this.cancelled || this.signal?.aborted === true
  }

  checkCancelled() {
    if (this.stopped()) throw new ResearchStoppedError()
  }

  /** Stop scheduling and abort in-flight workers/evaluations. */
  stop() {
    this.cancelled = true
    this.abort.abort()
  }

  signalForWork() {
    return combineSignals([this.abort.signal, this.signal])
  }

  metricDiagnostics() {
    const validRows = this.rows.filter(row => row.evaluation?.valid === true)
    return (this.plan.metrics ?? []).map(metric => {
      const values = validRows
        .filter(row => metric.name in (row.evaluation.metrics ?? {}))
        .map(row => row.evaluation.metrics[metric.name])
      const distinct = new Set(values.map(value => JSON.stringify(value)))
      return {
        name: metric.name,
        observations: values.length,
        missing_observations: validRows.length - values.length,
        distinct_values: distinct.size,
        constant_in_observed_checkpoints: values.length > 1 && distinct.size === 1,
      }
    })
  }

  dashboard() {
    return {
      metrics: this.plan.metrics ?? [],
      metric_diagnostics: this.metricDiagnostics(),
      trajectories: this.rows.map(publicRow),
    }
  }

  async checkDisk(workspace, count) {
    if (this.manager.kind !== 'snapshot') return
    const files = await inventory(workspace)
    const required = (await inventoryBytes(workspace, files)) * count
    const free = await freeBytes(this.output)
    if (required >= free) {
      throw new Error('Insufficient space for this cohort; existing research preserved')
    }
  }

  views(count) {
    if (!this.options.rsiTop) {
      return Array.from({ length: count }, () => ({ definitions: [], diagnostics: [], rows: [] }))
    }
    return sampleMetricViews({
      metrics: this.plan.metrics,
      subset: this.plan.metric_subset,
      count,
      diagnostics: this.metricDiagnostics(),
      rows: this.rows,
      rng: this.rng,
    })
  }

  async run() {
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
    const baseManifest = await inventory(baseState.path)
    await writeJsonAtomic(join(initialFolder, 'INPUT-MANIFEST.json'), baseManifest)
    const initial = {
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

    let leader = initial
    for (let roundNumber = 1; roundNumber <= options.rounds; roundNumber += 1) {
      this.checkCancelled()
      const stalled = Boolean(options.rsiTop
        && (this.now() - this.bestTime) / 1000 >= this.plan.stall_seconds)
      const explore = Boolean(options.forkAndFlush || (options.rsiTop && stalled))
      const phases = explore ? ['explore', 'continue'] : ['continue']
      for (const phase of phases) {
        this.checkCancelled()
        await writeJsonAtomic(join(this.output, 'DASHBOARD.json'), this.dashboard())
        const count = phase === 'explore' ? options.branches : 1
        await this.checkDisk(leader.workspace, count)
        const views = this.views(count)
        let candidates
        if (options.shareContext) {
          candidates = await this.cooperativeCohort(leader, count, phase, roundNumber, views)
        } else {
          candidates = await Promise.all(Array.from({ length: count }, (_, index) => this.branch(
            leader,
            index,
            phase,
            join(this.output, `round-${roundNumber}-${phase}-${index + 1}`),
            views[index],
          )))
        }
        this.rows.push(...candidates)
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
        await this.recycle(candidates, leader)
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
        if (this.anchor === null || gain > this.plan.meaningful_gain) {
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

  async writeSelection(leader) {
    if (!this.selectionFile) return
    await writeJsonAtomic(this.selectionFile, {
      leader_workspace: leader.workspace,
      leader_branch: leader._state?.branch ?? null,
      original_manifest: this.originalManifest,
      run: this.output,
      updated_at: new Date().toISOString(),
    })
  }

  async publishPeers(rows, folder) {
    let updated = false
    for (const row of rows) {
      if (row.completed && !row.collaboration_failed && row.shared_checkpoint) {
        this.peerSlots[`${row.phase}:${row.collaborator}`] = {
          id: row.id,
          parent: row.parent,
          phase: row.phase,
          collaborator: row.collaborator,
          evaluation: row.evaluation,
          checkpoint: row.shared_checkpoint,
        }
        updated = true
      }
    }
    if (!updated) return this.peerBundle
    const peers = Object.values(this.peerSlots)
    const path = join(folder, 'PEER-EVIDENCE.json')
    await writeJsonAtomic(path, buildPeerEvidence({ objective: this.plan.objective, peers }))
    await fsp.chmod(path, 0o444)
    this.peerBundle = path
    await fsp.mkdir(folder, { recursive: true })
    await fsp.writeFile(join(folder, 'shared-context.md'), buildZeroSynthesisContext({
      objective: this.plan.objective,
      rows: peers.map(peer => ({ id: peer.id, shared_checkpoint: peer.checkpoint })),
    }))
    return path
  }

  async cooperativeCohort(leader, count, phase, roundNumber, views) {
    const minutes = phase === 'explore' ? this.options.explorationMinutes : this.options.exploitationMinutes
    const seconds = 60 * minutes
    const interval = 60 * this.options.sharingIntervalMinutes
    const start = this.now()
    const deadline = start + seconds * 1000
    let parents = Array.from({ length: count }, () => leader)
    const history = []
    const checkpoints = new Array(count).fill(null)
    let epoch = 0
    while (true) {
      this.checkCancelled()
      const remaining = (deadline - this.now()) / 1000
      if (remaining <= this.plan.evaluation_seconds) break
      const shareAt = Math.min(deadline, start + (epoch + 1) * interval * 1000)
      const prefix = `round-${roundNumber}-${phase}-epoch-${epoch + 1}`
      const bundle = this.peerBundle
      const candidates = await Promise.all(parents.map((parent, index) => this.branch(
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
        },
      )))
      for (let index = 0; index < candidates.length; index += 1) {
        const row = candidates[index]
        if (row.completed && row.evaluation?.valid === true && !row.collaboration_failed) {
          checkpoints[index] = await this.manager.retainCompletedState(publicRow(row))
        }
      }
      const publication = join(this.output, `${prefix}-shared`)
      await this.publishPeers(candidates, publication)
      history.push({
        epoch: epoch + 1,
        target_seconds: (shareAt - start) / 1000,
        actual_seconds: (this.now() - start) / 1000,
        rows: candidates.map(publicRow),
        peer_bundle: this.peerBundle,
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
        const restored = []
        for (let index = 0; index < candidates.length; index += 1) {
          const row = candidates[index]
          const broken = !row.completed || row.evaluation?.valid !== true || row.collaboration_failed
          if (checkpoints[index] && broken) {
            await this.preserveUnverified(row)
            restored.push(await this.manager.restoreCompletedState(checkpoints[index], publicRow(row)))
          } else {
            restored.push(row)
          }
        }
        return restored
      }
      parents = candidates
      epoch += 1
      const wait = shareAt - this.now()
      if (wait > 0) await this.sleep(wait)
    }
    return history.length > 0 ? parents : []
  }

  async branch(parent, index, phase, folder, view = { definitions: [] }, cooperation = null) {
    await fsp.mkdir(folder, { recursive: true })
    const resume = Boolean(cooperation?.resume)
    let state
    let ownsState = false
    try {
      if (resume) {
        state = parent._state
        if (!state) throw new Error('Cooperative resume requires the parent workspace')
      } else {
        this.checkCancelled()
        state = await this.manager.fork(parent._state, basename(folder))
        ownsState = true
      }
      const checkout = state.path
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

      let peer = null
      if (cooperation?.bundle) {
        const bundleText = await fsp.readFile(cooperation.bundle, 'utf8')
        const bundle = JSON.parse(bundleText)
        peer = {
          path: join(checkout, 'SHARED_CONTEXT', `peer-evidence-${basename(folder)}.json`),
          digest: null,
          ids: peerIdsOf(bundle),
        }
        await fsp.mkdir(join(checkout, 'SHARED_CONTEXT'), { recursive: true })
        await fsp.writeFile(peer.path, bundleText)
        await fsp.chmod(peer.path, 0o444)
        peer.digest = await digestFile(peer.path)
      }

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
        env: this.workerEnv,
        provider: this.workerProvider,
        policy: [RESEARCH_POLICY, RESEARCH_METHODS_POLICY, CONTINUE_POLICY].join('\n\n'),
        seconds,
      })
      await writeJsonAtomic(join(folder, 'LAUNCH.json'), {
        phase,
        parent: parent.id,
        fresh_context: !session,
        provider_session: session,
        seconds,
        metric_view: view.definitions ?? [],
        cooperative_resume: resume,
        peer_manifest_sha256: peer?.digest ?? null,
        share_target_unix: cooperation ? Date.now() + Math.max(0, cooperation.shareAt - this.now()) : null,
        worker_provider: this.workerProvider,
        environment: Object.keys(this.workerEnv),
      })
      const providerSeconds = cooperation ? seconds - this.plan.evaluation_seconds : seconds
      await writeJsonAtomic(join(folder, 'BUDGET.json'), {
        provider_seconds: providerSeconds,
        evaluation_reserve_seconds: cooperation ? this.plan.evaluation_seconds : 0,
      })
      if (providerSeconds <= 0) {
        throw new Error('No provider window remains after reserving evaluation')
      }

      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), providerSeconds * 1000)
      timer.unref?.()
      const signal = combineSignals([this.signalForWork(), timeout.signal])
      let result
      let childId = null
      try {
        const activation = await this.subagents.startActivation({
          provider: this.workerProvider,
          label: `${this.runId}:${basename(folder)}`,
          request: {
            cwd: checkout,
            prompt: [{ type: 'text', text: prompt }],
            parent: this.parent,
          },
          signal,
          delivery: 'caller',
        })
        childId = activation.childId ?? null
        result = await activation.result
        try {
          await activation.dispose()
        } catch (error) {
          this.logger?.warn?.(`[auto-research] worker dispose failed: ${error.message}`)
        }
      } finally {
        clearTimeout(timer)
      }
      this.checkCancelled()
      const completed = result?.stopReason === 'completed'
      const timedOut = result?.stopReason === 'aborted' && !this.stopped()
      const outcome = {
        completed,
        provider_session: childId ?? session,
        terminal: result?.stopReason ?? 'error',
        diagnostic_count: result?.diagnostic ? 1 : 0,
      }
      const row = {
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
          row.evaluation = { valid: false, reason: 'RSI portfolio protocol: ' + error.message }
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
          row.evaluation = { valid: false, reason: 'Collaboration protocol: ' + error.message }
          row.collaboration_failed = true
        }
      }
      await writeJsonAtomic(join(folder, 'RESULT.json'), publicRow(row))
      return { ...row, _state: state, _ownsState: ownsState }
    } catch (error) {
      if (ownsState && state) {
        try {
          await this.manager.release(state, { discard: true })
        } catch (releaseError) {
          this.logger?.warn?.(`[auto-research] branch release failed: ${releaseError.message}`)
        }
      }
      throw error
    }
  }

  choose(incumbent, candidates) {
    const eligible = [incumbent, ...candidates].filter(row => row.evaluation?.valid === true)
    if (eligible.length === 0) throw new Error('No valid evaluated branch; all work retained')
    const key = row => {
      let primary = scoreValue(row.evaluation.score)
      if (this.plan.direction === 'minimize') primary = -primary
      const progress = (this.plan.selection_metrics ?? []).map(spec => {
        const value = scoreValue(row.evaluation.metrics[spec.name], `selection metric ${spec.name}`)
        return spec.direction === 'maximize' ? value : -value
      })
      return [primary, ...progress, row.id !== 'initial' ? 1 : 0, row.time ?? 0]
    }
    const ordered = [...eligible].sort((a, b) => compareKeys(key(b), key(a)))
    return ordered[0]
  }

  async recycle(candidates, leader) {
    for (const row of candidates) {
      if (!row._ownsState || !row._state) continue
      if (row.id === leader.id) {
        try {
          await this.manager.commit(row._state, { message: `auto-research: verified ${row.id}` })
        } catch (error) {
          this.logger?.warn?.(`[auto-research] commit failed: ${error.message}`)
        }
        continue
      }
      const valid = row.evaluation?.valid === true
      const preserve = row.timed_out === true || row.pending_workspace !== undefined
        || row.collaboration_failed === true || row.completed === false
      try {
        if (valid) await this.manager.commit(row._state, { message: `auto-research: verified ${row.id}` })
        else if (preserve) await this.manager.commit(row._state, { message: `auto-research: unverified ${row.id}` })
      } catch (error) {
        this.logger?.warn?.(`[auto-research] commit failed: ${error.message}`)
      }
      try {
        await this.manager.release(row._state, { discard: !valid && !preserve })
      } catch (error) {
        this.logger?.warn?.(`[auto-research] release failed: ${error.message}`)
      }
      row._state = null
      row._released = true
    }
  }

  async finish(leader, reason = 'configured_batch_complete', pending = null) {
    const unfinished = {}
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
    const result = {
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
  async releaseAll() {
    for (const row of this.rows) {
      if (row._state) {
        const valid = row.evaluation?.valid === true
        const preserve = row.timed_out === true || row.pending_workspace !== undefined
          || row.collaboration_failed === true || row.completed === false
        if (preserve && !valid) {
          await this.preserveUnverified(row)
          continue
        }
        try {
          if (valid) await this.manager.commit(row._state, { message: `auto-research: retained ${row.id}` })
        } catch (error) {
          this.logger?.warn?.(`[auto-research] final commit failed: ${error.message}`)
        }
        try {
          await this.manager.release(row._state, { discard: !valid })
        } catch (error) {
          this.logger?.warn?.(`[auto-research] final release failed: ${error.message}`)
        }
        row._state = null
      }
    }
    try {
      await this.manager.close()
    } catch (error) {
      this.logger?.warn?.(`[auto-research] workspace close failed: ${error.message}`)
    }
  }

  /** Keep an unverified workspace available for independent review. */
  async preserveUnverified(row) {
    if (!row._state) return
    try {
      await this.manager.commit(row._state, { message: `auto-research: unverified ${row.id}` })
    } catch (error) {
      this.logger?.warn?.(`[auto-research] unverified commit failed: ${error.message}`)
    }
    try {
      await this.manager.release(row._state, { discard: false })
    } catch (error) {
      this.logger?.warn?.(`[auto-research] unverified release failed: ${error.message}`)
    }
    row._state = null
    row._released = true
  }
}

export { jsonDigest, buildZeroSynthesisContext, publicRow }
