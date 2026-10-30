/**
 * `SubagentProvider` named `auto-research`.
 *
 * One activation runs one complete research Batch. Setup failures reject
 * `start()` before publication; after the handle is returned, every terminal
 * outcome settles through `result` (never a rejection), as the seam requires.
 */

import * as fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import {
  createWorkspaceManager,
  inventory,
  isContained,
  jsonEqual,
  resolveLayerfsConfig,
  selectPlanWorkspace,
} from './layerfs-workspace.js'
import { FrozenEvaluator } from './evaluator.js'
import { ResearchStoppedError, Runner } from './runner.js'

/** Out-of-process capability advertisement: no parent-enforced start features. */
export const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

const MAX_DIAGNOSTIC_BYTES = 4096
const DIAGNOSTIC_SUFFIX = '\n[diagnostic truncated]'

/** Normalize plugin config (also used by the Cordis standard schema below). */
export function resolveConfig(input = {}) {
  const config = input && typeof input === 'object' ? input : {}
  return {
    providerName: config.providerName ?? 'auto-research',
    ...(config.workerProvider ? { workerProvider: config.workerProvider } : {}),
    planPath: config.planPath ?? '.auto-research-methods/plan.json',
    rounds: config.rounds ?? 1,
    branches: config.branches ?? 4,
    explorationMinutes: config.explorationMinutes ?? 30,
    exploitationMinutes: config.exploitationMinutes ?? 30,
    rsiTop: config.rsiTop ?? false,
    forkAndFlush: config.forkAndFlush ?? false,
    shareContext: config.shareContext ?? false,
    sharingIntervalMinutes: config.sharingIntervalMinutes ?? 10,
    ...(config.layerfs !== undefined ? { layerfs: config.layerfs } : {}),
    workerEnv: config.workerEnv ?? {},
    ...(config.plan !== undefined ? { plan: config.plan } : {}),
  }
}

/** Extract the standalone user text from a `ContentBlock[]` or string. */
export function extractPromptText(prompt) {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  return prompt
    .map(block => {
      if (typeof block === 'string') return block
      if (block?.type === 'text' && typeof block.text === 'string') return block.text
      if (typeof block?.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function looksLikePlan(value) {
  return value && typeof value === 'object' && typeof value.objective === 'string' && typeof value.evaluator === 'string'
}

/**
 * Find a plan object embedded in a delegation prompt: a fenced JSON block, a
 * `PLAN_JSON:` line, or a prompt that is itself the JSON object.
 */
export function parsePlanFromPrompt(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi
  for (const match of text.matchAll(fenced)) {
    try {
      const value = JSON.parse(match[1])
      if (looksLikePlan(value)) return value
    } catch {
      // Try the next block.
    }
  }
  const marker = /PLAN_JSON:\s*(\{[\s\S]*\})\s*$/m.exec(text)
  if (marker) {
    try {
      const value = JSON.parse(marker[1])
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

async function readJson(path) {
  return JSON.parse(await fsp.readFile(path, 'utf8'))
}

async function pathExists(path) {
  try {
    await fsp.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the plan from config, the plan file, or the delegation prompt.
 * @returns {Promise<{plan:object, source:string}>}
 */
export async function resolvePlan({ cwd, config, promptText }) {
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

function truncateDiagnostic(text) {
  const value = String(text ?? '')
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= MAX_DIAGNOSTIC_BYTES) return value
  const suffix = Buffer.from(DIAGNOSTIC_SUFFIX, 'utf8')
  let end = MAX_DIAGNOSTIC_BYTES - suffix.length
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1
  return bytes.subarray(0, end).toString('utf8') + DIAGNOSTIC_SUFFIX
}

function textOutput(text) {
  return [{ type: 'text', text }]
}

/** Strip live handles and obvious secret values before config is serialized. */
function publicConfig(config) {
  const { plan, layerfs, workerEnv, ...rest } = config
  const safeEnv = {}
  const secret = /(token|key|secret|password|credential)/i
  for (const [key, value] of Object.entries(workerEnv ?? {})) {
    if (!secret.test(key)) safeEnv[key] = value
  }
  const safeLayerfs = layerfs && typeof layerfs === 'object'
    ? layerfs.client
      ? { project: layerfs.project ?? null }
      : layerfs
    : undefined
  return {
    ...rest,
    workerEnv: safeEnv,
    ...(safeLayerfs ? { layerfs: safeLayerfs } : {}),
  }
}

function summaryText(result, output) {
  const leader = result.leader ?? {}
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
    `pending_workspaces: ${(result.pending_workspaces ?? []).length}`,
    'scope: ' + result.scope,
  ]
  return lines.join('\n')
}

/** One provider instance, normally created by the Cordis plugin entry. */
export class AutoResearchProvider {
  constructor({ ctx, config = {} }) {
    if (!ctx) throw new Error('AutoResearchProvider requires a plugin context')
    this.ctx = ctx
    this.config = resolveConfig(config)
    this.name = this.config.providerName
    this.capabilities = NO_START_CAPABILITIES
    this.inheritsParentContext = false
  }

  workerProviderName() {
    const names = typeof this.ctx.subagents?.list === 'function' ? this.ctx.subagents.list() : []
    const configured = this.config.workerProvider
    if (configured !== undefined) {
      if (!names.includes(configured)) {
        throw new Error(`worker provider "${configured}" is not registered (available: ${names.join(', ') || 'none'})`)
      }
      if (configured === this.name) throw new Error('auto-research cannot delegate to itself as a worker')
      return configured
    }
    const candidate = names.find(name => name !== this.name)
    if (!candidate) throw new Error('auto-research requires at least one other registered subagent provider')
    return candidate
  }

  async start(request) {
    if (!request || typeof request !== 'object') throw new Error('auto-research requires a start request')
    if (request.signal?.aborted) throw new ResearchStoppedError('auto-research request was aborted before startup')
    const cwd = request.cwd
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
      throw new Error('auto-research child cwd must be an absolute path: ' + String(cwd))
    }
    const stat = await fsp.stat(cwd).catch(() => null)
    if (!stat?.isDirectory()) throw new Error('auto-research child cwd is not an accessible directory: ' + cwd)
    if (!request.parent) throw new Error('auto-research requires the exact live parent agent')

    const promptText = extractPromptText(request.prompt)
    const { plan, source } = await resolvePlan({ cwd, config: this.config, promptText })
    if (!isAbsolute(plan.evaluator)) plan.evaluator = resolve(cwd, plan.evaluator)
    const evaluatorStat = await fsp.stat(plan.evaluator).catch(() => null)
    if (!evaluatorStat?.isFile()) throw new Error('Research plan evaluator does not exist: ' + plan.evaluator)

    const workerProvider = this.workerProviderName()
    const workspaceRoot = await selectPlanWorkspace(cwd, plan)
    const runtimeRoot = join(cwd, '.auto-research-methods')
    const runId = randomUUID()
    const output = join(runtimeRoot, 'runs', runId)
    await fsp.mkdir(output, { recursive: true })

    const originalManifest = await inventory(workspaceRoot)
    const selectionFile = join(runtimeRoot, 'LATEST.json')
    let sourceWorkspace = workspaceRoot
    if (await pathExists(selectionFile)) {
      let latest = null
      try {
        latest = await readJson(selectionFile)
      } catch {
        throw new Error(`Previous run selection is not valid JSON: ${selectionFile}`)
      }
      if (latest?.original_manifest && !jsonEqual(latest.original_manifest, originalManifest)) {
        throw new Error('Original workspace changed since the last method run. Select/reconcile the intended starting workspace before continuing; all branches preserved.')
      }
      if (typeof latest?.leader_workspace === 'string') {
        const candidate = latest.leader_workspace
        if (isAbsolute(candidate)
          && isContained(join(runtimeRoot, 'runs'), candidate)
          && await pathExists(candidate)) {
          const candidateStat = await fsp.stat(candidate).catch(() => null)
          if (candidateStat?.isDirectory()) sourceWorkspace = candidate
        }
      }
    }

    const layerfsConfig = this.config.layerfs
    const layerfsSettings = layerfsConfig?.client ? null : resolveLayerfsConfig(process.env, layerfsConfig)
    const layerfsEnv = layerfsSettings
      ? Object.fromEntries(Object.entries({
        DSH_LAYERFS_PROJECT: layerfsSettings.project,
        DSH_LAYERFS_STORE_PATH: layerfsSettings.storePath,
        DSH_LAYERFS_HOME: layerfsSettings.home,
      }).filter(([, value]) => value))
      : {}

    const manager = await createWorkspaceManager({
      output,
      runId,
      config: this.config,
      env: process.env,
      ...(layerfsConfig ? { layerfs: layerfsConfig } : {}),
    })
    const evaluator = new FrozenEvaluator({ plan, output, logger: this.ctx.logger ?? null })
    let runner
    try {
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
          parent: request.parent,
          signal: request.signal,
          workerProvider,
          workerEnv: this.config.workerEnv,
          layerfsEnv,
          logger: this.ctx.logger ?? null,
          runId,
        },
      })
    } catch (error) {
      await manager.close().catch(() => {})
      throw error
    }

    this.ctx.logger?.info?.(
      `[auto-research] batch ${runId}: plan=${source} workspace=${sourceWorkspace} run=${output}`,
    )

    let disposal = null
    const result = (async () => {
      try {
        const batch = await runner.run()
        return { output: textOutput(summaryText(batch, output)), stopReason: 'completed' }
      } catch (error) {
        const stopped = error instanceof ResearchStoppedError || request.signal?.aborted === true
        if (!stopped) {
          const message = error instanceof Error ? error.message : String(error)
          this.ctx.logger?.warn?.(`[auto-research] batch ${runId} failed: ${message}`)
          try {
            await fsp.writeFile(join(output, 'RESULT.json'), JSON.stringify({
              status: 'FAILED',
              error: message,
              artifacts_preserved: true,
            }, null, 2) + '\n')
          } catch {
            // The run directory may be unwritable after an external failure.
          }
          return {
            output: textOutput(`Auto-research batch FAILED: ${message}\nrun: ${output}`),
            diagnostic: truncateDiagnostic(message),
            stopReason: 'error',
          }
        }
        return {
          output: textOutput(`Auto-research batch STOPPED; artifacts retained.\nrun: ${output}`),
          diagnostic: truncateDiagnostic('Research stopped; artifacts retained'),
          stopReason: 'aborted',
        }
      }
    })()

    const handle = {
      id: runId,
      result,
      dispose: () => {
        disposal ??= (async () => {
          runner.stop()
          await result.catch(() => {})
          await runner.releaseAll()
        })()
        return disposal
      },
    }
    return handle
  }
}

/** @returns a provider for the Cordis entry point. */
export function createProvider(options) {
  return new AutoResearchProvider(options)
}
