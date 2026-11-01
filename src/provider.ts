/**
 * `SubagentProvider` named `auto-research`.
 *
 * One activation runs one complete research Batch. Setup failures reject
 * `start()` before publication; after the handle is returned, every terminal
 * outcome settles through `result` (never a rejection), as the seam requires.
 */

import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import {
  createWorkspaceManager,
  inventory,
  isContained,
  jsonEqual,
  layerfsEnvironment,
  resolveLayerfsConfig,
  resolveShellEnvironment,
  selectPlanWorkspace,
  withoutLayerfsTrace,
  writeJsonAtomic,
} from './layerfs-workspace.js'
import { FrozenEvaluator } from './evaluator.js'
import { ResearchStoppedError, Runner } from './runner.js'
import type {
  Config,
  ContentBlock,
  LayerFSBinding,
  LayerFSSettings,
  PluginContext,
  ResearchPlanInput,
  ResolvedConfig,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
  SubagentStartRequest,
  WorkspaceState,
} from './types.js'

/** Out-of-process capability advertisement: no parent-enforced start features. */
export const NO_START_CAPABILITIES: Record<string, unknown> = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

const MAX_DIAGNOSTIC_BYTES = 4096
const DIAGNOSTIC_SUFFIX = '\n[diagnostic truncated]'
const PREFERRED_WORKERS = ['claude-code', 'codex', 'acp', 'dsh-sdk', 'spawn']

/** Normalize plugin config (also used by the Cordis standard schema). */
export function resolveConfig(input: unknown = {}): ResolvedConfig {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('config must be an object')
  }
  const config: Config = input as Config
  if (config.workerEnv !== undefined
    && (config.workerEnv === null || typeof config.workerEnv !== 'object' || Array.isArray(config.workerEnv))) {
    throw new Error('workerEnv must be an object')
  }
  if (config.rounds !== undefined) requirePositiveInteger(config.rounds, 'rounds')
  if (config.branches !== undefined) requirePositiveInteger(config.branches, 'branches')
  for (const key of ['explorationMinutes', 'exploitationMinutes', 'sharingIntervalMinutes'] as const) {
    if (config[key] !== undefined) requirePositiveNumber(config[key], key)
  }
  for (const key of ['rsiTop', 'forkAndFlush', 'shareContext'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') {
      throw new Error(`${key} must be a boolean`)
    }
  }
  if (config.workspaceBackend !== undefined
    && config.workspaceBackend !== 'auto'
    && config.workspaceBackend !== 'layerfs'
    && config.workspaceBackend !== 'snapshot') {
    throw new Error("workspaceBackend must be 'auto', 'layerfs' or 'snapshot'")
  }
  for (const key of ['providerName', 'planPath', 'workerProvider'] as const) {
    if (config[key] !== undefined) requireNonEmptyString(config[key], key)
  }
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? 'auto-research',
    planPath: config.planPath ?? '.auto-research-methods/plan.json',
    rounds: config.rounds ?? 1,
    branches: config.branches ?? 4,
    explorationMinutes: config.explorationMinutes ?? 30,
    exploitationMinutes: config.exploitationMinutes ?? 30,
    rsiTop: config.rsiTop ?? false,
    forkAndFlush: config.forkAndFlush ?? false,
    shareContext: config.shareContext ?? false,
    sharingIntervalMinutes: config.sharingIntervalMinutes ?? 10,
    workerEnv: config.workerEnv ?? {},
  }
  if (config.workerProvider !== undefined) resolved.workerProvider = config.workerProvider
  if (config.workspaceBackend !== undefined) resolved.workspaceBackend = config.workspaceBackend
  if (config.layerfs !== undefined) resolved.layerfs = config.layerfs
  if (config.plan !== undefined) resolved.plan = config.plan
  return resolved
}

function requirePositiveInteger(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function requirePositiveNumber(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`)
  }
}

function requireNonEmptyString(value: unknown, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`)
  }
}

/** Extract the standalone user text from a `ContentBlock[]` or string. */
export function extractPromptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  return (prompt as unknown[])
    .map(block => {
      if (typeof block === 'string') return block
      if (!block || typeof block !== 'object') return ''
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') return record.text
      if (typeof record.text === 'string') return record.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function looksLikePlan(value: unknown): value is ResearchPlanInput {
  return Boolean(value) && typeof value === 'object'
    && typeof (value as ResearchPlanInput).objective === 'string'
    && typeof (value as ResearchPlanInput).evaluator === 'string'
}

/**
 * Find a plan object embedded in a delegation prompt: a fenced JSON block, a
 * `PLAN_JSON:` line, or a prompt that is itself the JSON object.
 */
export function parsePlanFromPrompt(text: string): ResearchPlanInput | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi
  for (const match of text.matchAll(fenced)) {
    try {
      const value = JSON.parse(match[1] as string)
      if (looksLikePlan(value)) return value
    } catch {
      // Try the next block.
    }
  }
  const marker = /PLAN_JSON:\s*(\{[\s\S]*\})\s*$/m.exec(text)
  if (marker) {
    try {
      const value = JSON.parse(marker[1] as string)
      if (looksLikePlan(value)) return value
    } catch {
      // Fall through to the whole-prompt attempt.
    }
  }
  try {
    const value = JSON.parse(text.trim())
    return looksLikePlan(value) ? value : null
  } catch {
    return null
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(path, 'utf8'))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the plan from config, the plan file, or the delegation prompt.
 */
export async function resolvePlan({
  cwd,
  config,
  promptText,
}: {
  cwd: string
  config: ResolvedConfig
  promptText: string
}): Promise<{ plan: ResearchPlanInput; source: string }> {
  if (config.plan && typeof config.plan === 'object') {
    return { plan: { ...config.plan }, source: 'config' }
  }
  const planPath = isAbsolute(config.planPath) ? config.planPath : resolve(cwd, config.planPath)
  if (await pathExists(planPath)) {
    const value = await readJson(planPath)
    if (!looksLikePlan(value)) throw new Error(`Research plan is incomplete: ${planPath}`)
    return { plan: value, source: planPath }
  }
  const embedded = parsePlanFromPrompt(promptText)
  if (embedded) return { plan: embedded, source: 'prompt' }
  throw new Error(
    `No research plan: write ${config.planPath} (or include a PLAN_JSON object in the delegation prompt)`,
  )
}

function truncateDiagnostic(text: unknown): string {
  const value = String(text ?? '')
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= MAX_DIAGNOSTIC_BYTES) return value
  const suffix = Buffer.from(DIAGNOSTIC_SUFFIX, 'utf8')
  let end = MAX_DIAGNOSTIC_BYTES - suffix.length
  while (end > 0 && ((bytes[end] as number) & 0b1100_0000) === 0b1000_0000) end -= 1
  return bytes.subarray(0, end).toString('utf8') + DIAGNOSTIC_SUFFIX
}

function textOutput(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** Strip live handles and obvious secret values before config is serialized. */
function publicConfig(config: ResolvedConfig): Config {
  const { plan, layerfs, workerEnv, ...rest } = config
  void plan
  const safeEnv: Record<string, unknown> = {}
  const secret = /(token|key|secret|password|credential)/i
  for (const [key, value] of Object.entries(workerEnv ?? {})) {
    if (!secret.test(key)) safeEnv[key] = value
  }
  // The tri-state opt-out is part of the public contract: CONFIG.json must
  // record `layerfs: false`, not silently drop the field.
  const safeLayerfs: LayerFSBinding | false | undefined = layerfs === false
    ? false
    : layerfs && typeof layerfs === 'object'
      ? layerfs.client
        ? { project: layerfs.project ?? null }
        : layerfs
      : undefined
  return {
    ...rest,
    workerEnv: safeEnv,
    ...(safeLayerfs !== undefined ? { layerfs: safeLayerfs } : {}),
  }
}

function summaryText(result: Awaited<ReturnType<Runner['run']>>, output: string): string {
  const leader = result.leader ?? ({} as typeof result.leader)
  const pending = result.pending_workspaces ?? []
  const lines = [
    'Auto-research batch COMPLETED.',
    `status: ${result.status}`,
    `leader: ${leader.id ?? '(none)'}`,
    `score: ${leader.evaluation?.score ?? '(none)'}`,
    `workspace: ${leader.workspace ?? '(none)'}`,
    `run: ${output}`,
    `result: ${join(output, 'RESULT.json')}`,
    `dashboard: ${join(output, 'DASHBOARD.json')}`,
    `leader_file: ${join(output, 'LEADER.json')}`,
    `selections: ${join(output, 'SELECTIONS.json')}`,
    `stop_reason: ${result.stop_reason}`,
    `pending_workspaces: ${pending.length}`,
    ...pending.map(entry => `pending: ${String((entry as Record<string, unknown>).workspace ?? '')}`),
    'scope: ' + result.scope,
  ]
  return lines.join('\n')
}

/** A held checkout-level single-instance lock. */
export interface RunnerLock {
  path: string
  info: { pid: number; runId: string; cwd: string; started_at: string }
  release: () => Promise<void>
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Refuse a runtime root that is a symlink escaping the workspace.
 *
 * `.auto-research-methods` holds every branch artifact and the runner lock, so
 * a planted symlink would redirect those writes outside the assigned
 * checkout. A missing runtime root is fine (it is created later).
 */
export async function assertRuntimeRootContained(
  workspaceRoot: string,
  runtimeRoot: string,
): Promise<void> {
  let stats: Awaited<ReturnType<typeof fsp.lstat>>
  try {
    stats = await fsp.lstat(runtimeRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stats.isSymbolicLink()) {
    if (!stats.isDirectory()) {
      throw new Error(`Auto-research runtime root is not a directory: ${runtimeRoot}`)
    }
    return
  }
  let realRoot: string
  let realRuntime: string
  try {
    [realRoot, realRuntime] = await Promise.all([fsp.realpath(workspaceRoot), fsp.realpath(runtimeRoot)])
  } catch (error) {
    throw new Error(
      `Auto-research runtime root is an unresolvable symlink: ${runtimeRoot} (${(error as Error).message})`,
    )
  }
  if (!isContained(realRoot, realRuntime)) {
    throw new Error(
      `Auto-research runtime root is a symlink escaping the workspace: ${runtimeRoot} -> ${realRuntime}`,
    )
  }
}

/** A lock file that stayed unparsable this recently is still being written. */
const LOCK_WRITE_GRACE_MS = 2000

/**
 * Acquire `<runtimeRoot>/runner.lock` so two `subagent_auto_research`
 * invocations on one checkout fail loud instead of racing on `LATEST.json`.
 *
 * The payload is written to a unique sibling first and then hard-linked into
 * place, so a lock file is never observable empty or half-written. A stale
 * lock is reclaimed only when its owning PID is gone; an unparsable lock that
 * is younger than {@link LOCK_WRITE_GRACE_MS} is treated as live rather than
 * unlinked, which closes the remaining creation window.
 */
export async function acquireRunnerLock(
  runtimeRoot: string,
  runId: string,
  {
    cwd = runtimeRoot,
    pid = process.pid,
    alive = processAlive,
    now = Date.now,
    writeGraceMs = LOCK_WRITE_GRACE_MS,
  }: {
    cwd?: string
    pid?: number
    alive?: (pid: number) => boolean
    now?: () => number
    writeGraceMs?: number
  } = {},
): Promise<RunnerLock> {
  await fsp.mkdir(runtimeRoot, { recursive: true })
  const path = join(runtimeRoot, 'runner.lock')
  const info = { pid, runId, cwd, started_at: new Date(now()).toISOString() }
  const payload = JSON.stringify(info, null, 2) + '\n'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temporary = join(runtimeRoot, `.runner.lock.${pid}.${randomUUID()}`)
    try {
      await fsp.writeFile(temporary, payload, { mode: 0o600 })
      // link() is atomic and refuses an existing target, so the visible lock is
      // always the complete payload.
      await fsp.link(temporary, path)
      let released = false
      return {
        path,
        info,
        release: async () => {
          if (released) return
          released = true
          try {
            const saved = JSON.parse(await fsp.readFile(path, 'utf8')) as { pid?: unknown; runId?: unknown }
            if (saved.pid === pid && saved.runId === runId) await fsp.unlink(path)
          } catch {
            // Already unlocked or replaced by a newer owner.
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let saved: { pid?: unknown; runId?: unknown; started_at?: unknown } | null = null
      let readable = true
      try {
        saved = JSON.parse(await fsp.readFile(path, 'utf8')) as { pid?: unknown; runId?: unknown }
      } catch {
        saved = null
        readable = false
      }
      const owner = typeof saved?.pid === 'number' ? saved.pid : null
      if (owner !== null && alive(owner)) {
        throw new Error(
          `Another auto-research batch is already running for this checkout: ${path} (pid ${owner}, run ${String(saved?.runId ?? 'unknown')})`,
        )
      }
      if (owner === null) {
        // Either a writer that has not finished or a corrupt lock. Only a lock
        // old enough to be certainly abandoned may be removed.
        const stats = await fsp.stat(path).catch(() => null)
        if (stats && now() - stats.mtimeMs < writeGraceMs) {
          throw new Error(
            `Another auto-research batch is starting for this checkout: ${path}${readable ? '' : ' (lock still being written)'}`,
          )
        }
      }
      // Stale lock: reclaim only when the owner is definitely gone.
      await fsp.unlink(path).catch(() => {})
    } finally {
      await fsp.unlink(temporary).catch(() => {})
    }
  }
  throw new Error(`Could not acquire the auto-research runner lock: ${path}`)
}

/** The worker environment keys this plugin owns in a `dsh` shell registry. */
export const AUTO_RESEARCH_ENV_KEYS = [
  'DSH_AUTO_RESEARCH_WORKER',
  'DSH_AUTO_RESEARCH_BRANCH',
  'DSH_AUTO_RESEARCH_CHECKOUT',
  'DSH_AUTO_RESEARCH_SANDBOX_PATH',
] as const

/** A `DSH_*` name a `dsh` shell registry accepts as a contributor key. */
const REGISTRY_KEY = /^DSH_[A-Z][A-Z0-9_]*$/

interface WorkerEnvEntry {
  key: number
  id: string
  checkout: string
  parentSessionId: string | null
  childSessionId: string | null
  env: Record<string, string>
}

/** Live handle for one running branch worker. */
export interface WorkerEnvRegistration {
  readonly id: string
  readonly checkout: string
  /** Bind the worker's real child session id once the provider reports it. */
  setChildSession: (sessionId: string | null) => void
  dispose: () => void
}

/**
 * The branch environments of the workers that are running right now.
 *
 * `dsh` rebuilds the `DSH_*` namespace for every model shell call and asks each
 * registered contributor for the values of the calling execution. The runner
 * registers a worker's branch environment before starting its activation and
 * removes it in `finally`, so a worker's own `bash` calls receive
 * `DSH_AUTO_RESEARCH_*` (and the configured `workerEnv`) in their real process
 * environment, while the coordinator's calls receive nothing.
 */
export class WorkerEnvRegistry {
  private readonly entries = new Map<number, WorkerEnvEntry>()
  private nextKey = 1
  private readonly resolveCwd: ((session: unknown, agent: unknown) => string | null) | null

  constructor(options: {
    /** Resolve the per-session assigned checkout (`ctx.workingDirectory.get`). */
    resolveCwd?: (session: unknown, agent: unknown) => string | null
  } = {}) {
    this.resolveCwd = options.resolveCwd ?? null
  }

  get size(): number {
    return this.entries.size
  }

  /** @returns every checkout that currently has a live worker. */
  checkouts(): string[] {
    return [...this.entries.values()].map(entry => entry.checkout)
  }

  /** Whether `path` is one of the live worker checkouts (or inside it). */
  ownsCheckout(path: string): boolean {
    const target = resolve(path)
    for (const entry of this.entries.values()) {
      if (isContained(resolve(entry.checkout), target)) return true
    }
    return false
  }

  register({
    id,
    checkout,
    parentSessionId = null,
    childSessionId = null,
    env = {},
  }: {
    id: string
    checkout: string
    parentSessionId?: string | null
    childSessionId?: string | null
    env?: Record<string, string>
  }): WorkerEnvRegistration {
    const key = this.nextKey
    this.nextKey += 1
    const entry: WorkerEnvEntry = {
      key,
      id,
      checkout: resolve(checkout),
      parentSessionId,
      childSessionId,
      env: { ...env },
    }
    this.entries.set(key, entry)
    let disposed = false
    return {
      id,
      checkout: entry.checkout,
      setChildSession: sessionId => {
        if (!this.entries.has(key)) return
        entry.childSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        this.entries.delete(key)
      },
    }
  }

  /** The branch environment for one shell tool execution, or `{}`. */
  resolve(execution: unknown): Record<string, string> {
    const entry = this.match(execution)
    if (!entry) return {}
    // The flag is forced last: a configured `workerEnv` must never be able to
    // claim it is outside a worker session.
    return { ...entry.env, DSH_AUTO_RESEARCH_WORKER: '1' }
  }

  /** The registered entry that belongs to `execution`, if any. */
  private match(execution: unknown): WorkerEnvEntry | null {
    if (!execution || typeof execution !== 'object') return null
    const record = execution as { agent?: unknown; session?: unknown; cwd?: unknown }
    const agent = record.agent
    const agentRecord = agent !== null && typeof agent === 'object'
      ? agent as { session?: unknown; cwd?: unknown }
      : null
    // `dsh` copies the *parent* header (and its root cwd) onto a child session
    // and stores the worker's assigned checkout as a working-directory change,
    // so neither `header.cwd` nor `agent.cwd` alone identifies the branch.
    const session = record.session ?? agentRecord?.session
    const sessionRecord = session !== null && typeof session === 'object'
      ? session as { header?: Record<string, unknown>; entries?: unknown }
      : null
    const header = sessionRecord?.header ?? null
    const sessionId = typeof header?.id === 'string' && header.id.length > 0 ? header.id : null
    const parentSession = typeof header?.parentId === 'string' && header.parentId.length > 0
      ? header.parentId
      : typeof header?.parentSession === 'string' && header.parentSession.length > 0
        ? header.parentSession
        : null
    const origin = header?.origin
    const executionCwd = typeof record.cwd === 'string' && record.cwd.length > 0 ? record.cwd : null

    if (sessionId) {
      for (const entry of this.entries.values()) {
        if (entry.childSessionId !== null && entry.childSessionId === sessionId) return entry
      }
    }
    // A grandchild (a peer reviewer started by a branch worker) carries the
    // worker's session as its parent.
    if (parentSession !== null) {
      for (const entry of this.entries.values()) {
        if (entry.childSessionId !== null && entry.childSessionId === parentSession) return entry
      }
    }

    const candidates: string[] = []
    const addCandidate = (value: unknown): void => {
      if (typeof value !== 'string' || value.length === 0) return
      if (!candidates.includes(value)) candidates.push(value)
    }
    addCandidate(executionCwd)
    addCandidate(this.resolveCwd?.(session, agent))
    const entries = Array.isArray(sessionRecord?.entries) ? sessionRecord.entries : []
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry === null || typeof entry !== 'object') continue
      if ((entry as { type?: unknown }).type !== 'working-directory/change') continue
      const change = entry as { cwd?: unknown; data?: { cwd?: unknown } }
      const value = change.cwd ?? change.data?.cwd
      if (typeof value === 'string' && value.length > 0) {
        addCandidate(value)
        break
      }
    }
    addCandidate(agentRecord?.cwd)
    addCandidate(header?.cwd)

    for (const cwd of candidates) {
      const target = resolve(cwd)
      const matches = [...this.entries.values()]
        .filter(entry => !(sessionId !== null && entry.parentSessionId !== null && entry.parentSessionId === sessionId))
        .filter(entry => isContained(entry.checkout, target))
        .sort((left, right) => right.checkout.length - left.checkout.length)
      const exact = matches.find(entry => entry.checkout === target)
      if (exact) return exact
      if (matches.length === 1) return matches[0] as WorkerEnvEntry
      if (matches.length === 0) continue
      // Several workers share this checkout tree (cooperative epochs reuse one
      // branch): a declared child/parent session decides, then the newest entry.
      if (origin === 'subagent' || parentSession !== null || executionCwd !== null) {
        const related = matches.find(entry => parentSession !== null && entry.parentSessionId === parentSession)
        return related ?? (matches.at(-1) as WorkerEnvEntry)
      }
    }
    return null
  }
}

/** The runtime session id of a live agent, when the host exposes one. */
export function sessionIdOf(agent: unknown): string | null {
  const header = (agent as { session?: { header?: { id?: unknown } } } | null | undefined)?.session?.header
  return typeof header?.id === 'string' && header.id.length > 0 ? header.id : null
}

/** Whether `path` sits inside a `.auto-research-methods/runs/` runtime tree. */
export function isInsideRuntimeRuns(path: string): boolean {
  const parts = resolve(path).split(sep)
  const index = parts.lastIndexOf('.auto-research-methods')
  return index >= 0 && parts[index + 1] === 'runs'
}

/** One-line description for each environment key this plugin owns. */
const WORKER_KEY_DESCRIPTIONS: Record<(typeof AUTO_RESEARCH_ENV_KEYS)[number], string> = {
  DSH_AUTO_RESEARCH_WORKER: '1 inside an auto-research branch worker; absent for the coordinator',
  DSH_AUTO_RESEARCH_BRANCH: 'LayerFS branch of this worker checkout (when the workspace backend has one)',
  DSH_AUTO_RESEARCH_CHECKOUT: 'Absolute host checkout this branch worker edits',
  DSH_AUTO_RESEARCH_SANDBOX_PATH: 'Sandbox-internal mount path of this worker checkout (LayerFS only)',
}

/** `dsh`-owned names that a plugin contributor may never claim. */
export const DSH_RESERVED_ENV_KEYS = new Set([
  'DSH_HOME',
  'DSH_SHELL',
  'DSH_SESSION_ID',
  'DSH_PROFILE',
  'DSH_PROFILE_DIR',
])

/** Secret-looking names are filtered from prompts, receipts and registries. */
const SECRET_ENV_KEY = /(token|key|secret|password|credential)/i

/**
 * The `DSH_*` keys the `auto-research` contributor declares.
 *
 * The owned worker keys are always declared; a configured `workerEnv` adds
 * every well-formed `DSH_*` name (except `DSH_LAYERFS_*`, owned by
 * `@dsh-layerfs/host`, and the harness-reserved names). Other names cannot
 * travel through a `dsh` shell registry at all, so they stay in the prompt
 * environment only.
 */
export function declaredWorkerEnvKeys(
  workerEnv?: Record<string, unknown> | null,
): Record<string, { description: string }> {
  const keys: Record<string, { description: string }> = {}
  for (const name of AUTO_RESEARCH_ENV_KEYS) {
    keys[name] = { description: WORKER_KEY_DESCRIPTIONS[name] }
  }
  if (!workerEnv || typeof workerEnv !== 'object' || Array.isArray(workerEnv)) return keys
  for (const [name, value] of Object.entries(workerEnv)) {
    if (typeof value !== 'string') continue
    if (!REGISTRY_KEY.test(name)
      || name.startsWith('DSH_LAYERFS_')
      || DSH_RESERVED_ENV_KEYS.has(name)
      || SECRET_ENV_KEY.test(name)
      || Object.hasOwn(keys, name)) continue
    keys[name] = { description: 'Configured auto-research worker environment value' }
  }
  return keys
}

/** One provider instance, normally created by the Cordis plugin entry. */
export class AutoResearchProvider implements SubagentProvider {
  readonly ctx: PluginContext
  readonly config: ResolvedConfig
  readonly name: string
  readonly capabilities: Record<string, unknown>
  readonly inheritsParentContext: boolean
  /** Branch environments of the workers that are running right now. */
  readonly workerEnvs = new WorkerEnvRegistry({
    resolveCwd: session => this.sessionWorkingDirectory(session),
  })
  /**
   * `DSH_*` keys the shell contributor may return.
   *
   * A `dsh` registry refuses an undeclared key, so the owned keys plus every
   * `DSH_*` name from `config.workerEnv` are declared up front. `DSH_LAYERFS_*`
   * is never declared here: `@dsh-layerfs/host` owns those keys for the same
   * session and a second owner is a hard registration error.
   */
  readonly workerEnvKeys: Readonly<Record<string, { description: string }>>
  /** Batches whose runner is still alive (used to reject recursive delegation). */
  activeBatches = 0
  private disposeShellEnv: (() => void) | null = null

  constructor({ ctx, config = {} }: { ctx: PluginContext; config?: Config }) {
    if (!ctx) throw new Error('AutoResearchProvider requires a plugin context')
    this.ctx = ctx
    this.config = resolveConfig(config)
    this.name = this.config.providerName
    this.capabilities = NO_START_CAPABILITIES
    this.inheritsParentContext = false
    this.workerEnvKeys = declaredWorkerEnvKeys(this.config.workerEnv)
    this.installShellEnvContributor()
  }

  /** Release the shell-env registration (the Cordis fiber normally owns it). */
  dispose(): void {
    this.disposeShellEnv?.()
    this.disposeShellEnv = null
  }

  /** The `ctx.shellEnv` service, read without tripping Cordis's inject guard. */
  private shellEnvService(context: unknown = this.ctx): PluginContext['shellEnv'] {
    const holder = context as { get?: (name: string) => unknown; shellEnv?: unknown } | null | undefined
    if (!holder) return undefined
    if (typeof holder.get === 'function') {
      try {
        const value = holder.get('shellEnv')
        if (value) return value as PluginContext['shellEnv']
      } catch {
        // The service is not injected in this host; try the property fallback.
      }
    }
    try {
      return holder.shellEnv as PluginContext['shellEnv']
    } catch {
      return undefined
    }
  }

  /**
   * Register the branch `shellEnv` contributor once a `dsh` shell registry is
   * available. The registry may be injected after this provider is built, so
   * `ctx.inject` is used when the service is not there yet.
   */
  private installShellEnvContributor(): void {
    const install = (service: PluginContext['shellEnv'] | null | undefined): void => {
      if (!service || typeof service.register !== 'function' || this.disposeShellEnv) return
      try {
        this.disposeShellEnv = service.register(this.workerEnvContributor())
      } catch (error) {
        // A host that refuses the registration still runs; workers then rely on
        // the documented prompt environment only.
        this.ctx.logger?.warn?.(`[auto-research] shellEnv contributor unavailable: ${(error as Error).message}`)
      }
    }
    const existing = this.shellEnvService()
    if (existing) {
      install(existing)
      return
    }
    const inject = (this.ctx as { inject?: unknown }).inject
    if (typeof inject !== 'function') return
    try {
      ;(inject as (names: string[], callback: (child: unknown) => void) => unknown).call(
        this.ctx,
        ['shellEnv'],
        child => install(this.shellEnvService(child)),
      )
    } catch {
      // shellEnv is optional for this plugin.
    }
  }

  /** The contributor handed to `ctx.shellEnv.register`. */
  workerEnvContributor(): {
    name: string
    variables: Record<string, { description: string }>
    resolve: (execution: unknown) => Record<string, string>
  } {
    return {
      name: 'auto-research',
      variables: this.workerEnvKeys,
      resolve: execution => this.workerEnvFor(execution),
    }
  }

  /**
   * The branch environment for one shell execution, filtered to declared keys.
   *
   * `resolve` is only invoked for a worker's own session (see
   * {@link WorkerEnvRegistry.match}); a coordinator's call gets nothing.
   */
  workerEnvFor(execution: unknown): Record<string, string> {
    const resolved = this.workerEnvs.resolve(execution)
    const allowed: Record<string, string> = {}
    for (const [key, value] of Object.entries(resolved)) {
      if (Object.hasOwn(this.workerEnvKeys, key) && typeof value === 'string') allowed[key] = value
    }
    return allowed
  }

  private providerInfo(name: string): { inheritsParentContext?: boolean; name?: string } | null {
    const service = this.ctx.subagents
    const registry = service.providers
    if (registry && typeof registry === 'object') {
      const entry = registry instanceof Map ? registry.get(name) : (registry as Record<string, SubagentProvider>)[name]
      if (entry && typeof entry === 'object') return entry
    }
    for (const method of ['getProvider', 'get', 'describe'] as const) {
      const fn = service[method]
      if (typeof fn === 'function') {
        try {
          const value = fn.call(service, name) as { inheritsParentContext?: boolean; name?: string } | null | undefined
          if (value && typeof value === 'object') return value
        } catch {
          // Fall through to the next introspection hook.
        }
      }
    }
    return null
  }

  private isRecursiveWorker(name: string): boolean {
    return name === this.name || name === 'auto-research'
  }

  /**
   * Refuse `subagent_auto_research` from a branch worker.
   *
   * A worker already owns one branch of a running batch: delegating another
   * batch from inside it would recurse forever, race the runner lock of its own
   * checkout, and corrupt `plan.json`. A delegation whose cwd is a live worker
   * checkout or any `runs/` runtime tree is rejected the same way.
   */
  private assertNotRecursive(request: SubagentStartRequest, cwd: string): void {
    const parent = request.parent as
      | { session?: { header?: { origin?: unknown } } }
      | null
      | undefined
    const origin = parent?.session?.header?.origin
    // The real harness copies the coordinator's header (and cwd) onto a worker
    // session and records the assigned checkout as a working-directory change,
    // so the resolution below is what actually identifies a live worker.
    const resolved = this.workerEnvs.resolve({ agent: request.parent, session: parent?.session, cwd })
    if (resolved.DSH_AUTO_RESEARCH_WORKER === '1'
      || origin === 'subagent'
      || this.workerEnvs.ownsCheckout(cwd)
      || isInsideRuntimeRuns(cwd)) {
      throw new Error('subagent_auto_research cannot be called recursively by a worker subagent')
    }
  }

  /**
   * The assigned checkout of one session, when the host exposes
   * `ctx.workingDirectory.get(session)`.
   */
  private sessionWorkingDirectory(session: unknown): string | null {
    let value: unknown
    const context = this.ctx as (PluginContext & { get?: (name: string) => unknown }) | undefined
    try {
      if (typeof context?.get === 'function') value = context.get('workingDirectory')
    } catch {
      value = undefined
    }
    if (!value) {
      try {
        value = context?.workingDirectory
      } catch {
        value = undefined
      }
    }
    const get = (value as { get?: unknown } | null | undefined)?.get
    if (typeof get !== 'function') return null
    try {
      const cwd = get.call(value, session)
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
    } catch {
      return null
    }
  }

  /**
   * Choose the worker provider. Explicit configuration wins (after validation);
   * otherwise external/non-inheriting providers are preferred over in-process
   * context-inheriting providers such as `fork`.
   */
  workerProviderName(): string {
    const names = typeof this.ctx.subagents?.list === 'function' ? this.ctx.subagents.list() : []
    const configured = this.config.workerProvider
    if (configured !== undefined) {
      if (!names.includes(configured)) {
        throw new Error(`worker provider "${configured}" is not registered (available: ${names.join(', ') || 'none'})`)
      }
      if (this.isRecursiveWorker(configured)) throw new Error('auto-research cannot delegate to itself as a worker')
      return configured
    }
    const candidates = names.filter(name => !this.isRecursiveWorker(name))
    if (candidates.length === 0) throw new Error('auto-research requires at least one other registered subagent provider')
    const external = candidates.filter(name => this.providerInfo(name)?.inheritsParentContext !== true)
    const pool = external.length > 0 ? external : candidates
    for (const preferred of PREFERRED_WORKERS) {
      if (pool.includes(preferred)) return preferred
    }
    return pool[0] as string
  }

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    if (!request || typeof request !== 'object') throw new Error('auto-research requires a start request')
    if (request.signal?.aborted) throw new ResearchStoppedError('auto-research request was aborted before startup')
    const cwd = request.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new Error('auto-research child cwd must be an absolute path: ' + String(cwd))
    }
    this.assertNotRecursive(request, cwd)
    const stat = await fsp.stat(cwd).catch(() => null)
    if (!stat?.isDirectory()) throw new Error('auto-research child cwd is not an accessible directory: ' + cwd)
    if (!request.parent) throw new Error('auto-research requires the exact live parent agent')

    const promptText = extractPromptText(request.prompt)
    const { plan, source } = await resolvePlan({ cwd, config: this.config, promptText })
    if (typeof plan.evaluator !== 'string') throw new Error('Plan requires an evaluator script')
    if (!isAbsolute(plan.evaluator)) plan.evaluator = resolve(cwd, plan.evaluator)
    const evaluatorPath = plan.evaluator
    if (typeof evaluatorPath !== 'string') throw new Error('Plan requires an evaluator script')
    const evaluatorStat = await fsp.stat(evaluatorPath).catch(() => null)
    if (!evaluatorStat?.isFile()) throw new Error('Research plan evaluator does not exist: ' + evaluatorPath)

    const workerProvider = this.workerProviderName()
    const workspaceRoot = await selectPlanWorkspace(cwd, plan as { workspace?: unknown })
    const runtimeRoot = join(workspaceRoot, '.auto-research-methods')
    await assertRuntimeRootContained(workspaceRoot, runtimeRoot)
    await assertRuntimeRootContained(workspaceRoot, join(runtimeRoot, 'runs'))
    const seed = resolve(workspaceRoot) !== resolve(cwd)
    if (seed) {
      await assertRuntimeRootContained(cwd, join(cwd, '.auto-research-methods'))
    }
    const runId = randomUUID()
    const output = join(runtimeRoot, 'runs', runId)
    // Take the checkout lock before creating anything: a concurrent batch on
    // the same checkout must fail without leaving an orphan `runs/<runId>`
    // directory or overwriting `SEED.json`.
    const lock = await acquireRunnerLock(runtimeRoot, runId, { cwd })
    this.activeBatches += 1
    let manager: Awaited<ReturnType<typeof createWorkspaceManager>> | null = null
    let initialState: WorkspaceState | null = null
    let runner: Runner | null = null
    let released = false
    const releaseLock = async (): Promise<void> => {
      if (released) return
      released = true
      this.activeBatches = Math.max(0, this.activeBatches - 1)
      await lock.release()
    }
    try {
      await fsp.mkdir(output, { recursive: true })
      if (seed) {
        // The runner stores artifacts inside the compact seed; leave a pointer at
        // the checkout so the coordinator can discover the active seed runtime.
        await writeJsonAtomic(join(cwd, '.auto-research-methods', 'SEED.json'), {
          seed: workspaceRoot,
          runtime: runtimeRoot,
          latest: join(runtimeRoot, 'LATEST.json'),
        })
      }
      const originalManifest = await inventory(workspaceRoot)
      const selectionFile = join(runtimeRoot, 'LATEST.json')

      const shellEnv = await resolveShellEnvironment(this.ctx, request.parent)
      const env: NodeJS.ProcessEnv & Record<string, unknown> = { ...process.env, ...shellEnv }
      const explicitLayerfs = this.config.layerfs
      const snapshotForced = explicitLayerfs === false || this.config.workspaceBackend === 'snapshot'
      const layerfsConfig = !snapshotForced && explicitLayerfs && typeof explicitLayerfs === 'object' ? explicitLayerfs : null
      const layerfsSettings: LayerFSSettings | null = layerfsConfig?.client
        ? null
        : resolveLayerfsConfig(env, snapshotForced ? false : layerfsConfig ?? undefined)
      // An explicit opt-out also stops the session's LayerFS binding from
      // leaking into worker environments.
      const layerfsEnv = snapshotForced
        ? {}
        : withoutLayerfsTrace(layerfsEnvironment(env, layerfsSettings, explicitLayerfs))
      manager = await createWorkspaceManager({
        output,
        runId,
        config: this.config,
        env,
        ...(layerfsConfig?.client ? { layerfs: layerfsConfig } : {}),
      })

      let sourceWorkspace = workspaceRoot
      if (await pathExists(selectionFile)) {
        let latest = null
        try {
          latest = await readJson(selectionFile) as Record<string, unknown> | null
        } catch {
          throw new Error(`Previous run selection is not valid JSON: ${selectionFile}`)
        }
        if (latest?.original_manifest && !jsonEqual(latest.original_manifest, originalManifest)) {
          throw new Error('Original workspace changed since the last method run. Select/reconcile the intended starting workspace before continuing; all branches preserved.')
        }
        const savedWorkspace = typeof latest?.leader_workspace === 'string' ? latest.leader_workspace : null
        const savedBranch = typeof latest?.leader_branch === 'string' ? latest.leader_branch : null
        let adopted = false
        if (savedWorkspace !== null) {
          const candidate = savedWorkspace
          // Compare resolved paths: `runs` (or the saved workspace) may be a
          // symlink, and a lexical check alone would let either escape.
          const [realRuns, realCandidate] = await Promise.all([
            fsp.realpath(join(runtimeRoot, 'runs')).catch(() => null),
            fsp.realpath(candidate).catch(() => null),
          ])
          if (isAbsolute(candidate)
            && realRuns !== null
            && realCandidate !== null
            && isContained(realRuns, realCandidate)) {
            const candidateStat = await fsp.stat(realCandidate).catch(() => null)
            if (candidateStat?.isDirectory()) {
              sourceWorkspace = candidate
              adopted = true
            }
          }
        }
        if (!adopted && savedBranch !== null) {
          if (manager.kind !== 'layerfs') {
            throw new Error(
              `Previous leader workspace is missing or inaccessible and this checkout has no LayerFS backend to restore branch ${savedBranch}`,
            )
          }
          initialState = await manager.adopt(savedBranch, 'initial')
          sourceWorkspace = initialState.path
          adopted = true
        }
        if (!adopted && (savedWorkspace !== null || savedBranch !== null)) {
          throw new Error(
            `Previous leader workspace is missing or inaccessible (workspace=${savedWorkspace ?? '(none)'}, branch=${savedBranch ?? '(none)'})`,
          )
        }
        if (savedWorkspace === null && savedBranch === null) {
          throw new Error(
            `Previous run selection in ${selectionFile} has no leader_workspace or leader_branch`,
          )
        }
      }
      const evaluator = new FrozenEvaluator({ plan: plan as unknown as import('./evaluator.js').EvaluatorPlan, output, logger: this.ctx.logger ?? null })
      runner = new Runner({
        config: publicConfig(this.config),
        plan,
        workspace: sourceWorkspace,
        output,
        originalManifest,
        selectionFile,
        deps: {
          subagents: this.ctx.subagents,
          workspaceManager: manager,
          evaluator,
          ...(initialState ? { initialState } : {}),
          parent: request.parent,
          ...(sessionIdOf(request.parent) ? { parentSessionId: sessionIdOf(request.parent) as string } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          workerProvider,
          workerEnv: this.config.workerEnv,
          layerfsEnv,
          workerEnvRegistry: this.workerEnvs,
          ...(this.ctx.logger ? { logger: this.ctx.logger } : {}),
          runId,
        },
      })

      this.ctx.logger?.info?.(
        `[auto-research] batch ${runId}: plan=${source} workspace=${sourceWorkspace} run=${output} worker=${workerProvider}`,
      )

      const activeRunner = runner
      const result = (async (): Promise<SubagentResult> => {
        try {
          const batch = await activeRunner.run()
          return { output: textOutput(summaryText(batch, output)), stopReason: 'completed' }
        } catch (error) {
          const stopped = error instanceof ResearchStoppedError || request.signal?.aborted === true
          if (!stopped) {
            const message = error instanceof Error ? error.message : String(error)
            this.ctx.logger?.warn?.(`[auto-research] batch ${runId} failed: ${message}`)
            try {
              await writeJsonAtomic(join(output, 'RESULT.json'), {
                status: 'FAILED',
                error: message,
                artifacts_preserved: true,
              })
            } catch {
              // The run directory may be unwritable after an external failure.
            }
            return {
              output: textOutput(`Auto-research batch FAILED: ${message}\nrun: ${output}`),
              diagnostic: truncateDiagnostic(message),
              stopReason: 'error',
            }
          }
          const pending = activeRunner.pendingWorkspaces()
          try {
            await writeJsonAtomic(join(output, 'RESULT.json'), {
              status: 'STOPPED',
              stop_reason: 'stopped',
              pending_workspaces: pending,
              artifacts_preserved: true,
            })
          } catch {
            // Best effort: cancellation must still settle.
          }
          const pendingLines = pending.map(entry => `pending: ${String(entry.workspace ?? '')}`)
          return {
            output: textOutput([
              'Auto-research batch STOPPED; artifacts retained.',
              `run: ${output}`,
              `pending_workspaces: ${pending.length}`,
              ...pendingLines,
            ].join('\n')),
            diagnostic: truncateDiagnostic('Research stopped; artifacts retained'),
            stopReason: 'aborted',
          }
        } finally {
          await activeRunner.releaseAll().catch(() => {})
          await releaseLock().catch(() => {})
        }
      })()

      let disposal: Promise<void> | null = null
      return {
        id: runId,
        result,
        dispose: () => {
          disposal ??= (async () => {
            activeRunner.stop()
            await result.catch(() => {})
            await activeRunner.releaseAll()
            await releaseLock()
          })()
          return disposal
        },
      }
    } catch (error) {
      if (initialState) {
        // The adopted branch is mounted; a startup failure must not leave it
        // behind when the manager (and its client) closes.
        try {
          await manager?.release(initialState, { discard: false })
        } catch (releaseError) {
          this.ctx.logger?.warn?.(`[auto-research] failed to release the adopted initial state: ${(releaseError as Error).message}`)
        }
      }
      await manager?.close().catch(() => {})
      await releaseLock().catch(() => {})
      throw error
    }
  }
}

/** @returns a provider for the Cordis entry point. */
export function createProvider(options: { ctx: PluginContext; config?: Config }): AutoResearchProvider {
  return new AutoResearchProvider(options)
}
