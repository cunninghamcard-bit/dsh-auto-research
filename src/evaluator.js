/**
 * Frozen evaluator execution.
 *
 * The evaluator script is copied out of the candidate workspace before any
 * branch runs, and its SHA-256 is checked before and after every evaluation.
 * The evaluated workspace inventory is likewise compared across the process:
 * a checker that mutates the candidate, or a script that changes underneath a
 * run, rejects the observation instead of ranking it.
 */

import { spawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import {
  digestFile,
  inventory,
  isContained,
  jsonDigest,
  jsonEqual,
} from './layerfs-workspace.js'

const SECRET_LINE = /(access_token|refresh_token|api_key|apiKey|client_secret|BEGIN [A-Z ]*PRIVATE KEY)/

/**
 * Parse a finite numeric score. Booleans are not scores; neither is an empty
 * string, a non-finite number, or a value that only coerces to one.
 * @param {unknown} value
 * @param {string} [label]
 * @returns {number}
 */
export function scoreValue(value, label = 'score') {
  if (typeof value === 'boolean') throw new Error(`${label} is not a score`)
  if (typeof value === 'string' && value.trim() === '') throw new Error(`${label} must be finite`)
  if (value === null || value === undefined || typeof value === 'object') {
    throw new Error(`${label} must be finite`)
  }
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) throw new Error(`${label} must be finite`)
  return number
}

function terminate(child, signal) {
  if (!child || child.pid === undefined) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // The process may already have exited.
  }
}

/**
 * Run one evaluator process, capturing stdout/stderr and enforcing a timeout.
 * @returns {Promise<{code:number|null, timedOut:boolean, aborted:boolean, stdout:string, stderr:string, error?:Error}>}
 */
export function runEvaluatorProcess(parts) {
  const { argv, cwd, env, timeoutMs, signal, stdoutPath, stderrPath } = parts
  const spawnImpl = parts.spawn ?? spawn
  return new Promise(resolvePromise => {
    let child
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let timer
    try {
      child = spawnImpl(argv[0], argv.slice(1), {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolvePromise({ code: null, timedOut, aborted, stdout, stderr, error })
      return
    }
    const settle = async (code, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      await fsp.mkdir(dirname(stdoutPath), { recursive: true })
      await fsp.writeFile(stdoutPath, stdout)
      await fsp.writeFile(stderrPath, stderr)
      resolvePromise({ code, timedOut, aborted, stdout, stderr, ...(error ? { error } : {}) })
    }
    child.stdout?.on('data', chunk => {
      if (stdout.length < 32 * 1024 * 1024) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', chunk => {
      if (stderr.length < 4 * 1024 * 1024) stderr += chunk.toString('utf8')
    })
    timer = setTimeout(() => {
      timedOut = true
      terminate(child, 'SIGTERM')
      const hard = setTimeout(() => terminate(child, 'SIGKILL'), 2000)
      hard.unref?.()
    }, Math.max(1, timeoutMs))
    timer.unref?.()
    const onAbort = () => {
      aborted = true
      terminate(child, 'SIGTERM')
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', error => { void settle(null, error) })
    child.on('close', code => { void settle(code, undefined) })
  })
}

function safeReason(value) {
  if (value === undefined || value === null) return ''
  const text = String(value)
  return SECRET_LINE.test(text) ? 'Evaluator rejected candidate' : `Evaluator rejected candidate: ${text}`
}

/** A frozen evaluator bound to one run directory. */
export class FrozenEvaluator {
  constructor({ plan, output, logger = null, spawn: spawnImpl = undefined }) {
    if (!plan || typeof plan.evaluator !== 'string' || plan.evaluator.length === 0) {
      throw new Error('Plan requires an evaluator script')
    }
    this.plan = plan
    this.output = output
    this.logger = logger
    this.spawn = spawnImpl
    this.hash = null
    this.script = null
  }

  /** Copy the evaluator outside every candidate workspace and hash it. */
  async freeze() {
    const source = resolve(this.plan.evaluator)
    const extension = extname(source) || '.js'
    const target = join(this.output, `evaluator${extension}`)
    await fsp.mkdir(this.output, { recursive: true })
    await fsp.copyFile(source, target)
    this.script = target
    this.hash = await digestFile(target)
    return this.hash
  }

  argv(workspace) {
    const configured = this.plan.evaluator_interpreter
    if (Array.isArray(configured) && configured.length > 0) {
      return [...configured.map(String), this.script, workspace]
    }
    if (typeof configured === 'string' && configured.trim()) {
      return [...configured.trim().split(/\s+/), this.script, workspace]
    }
    const extension = extname(this.script).toLowerCase()
    if (extension === '.py') {
      return [process.env.DSH_PYTHON ?? 'python3', '-I', '-B', this.script, workspace]
    }
    if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
      return [process.execPath, this.script, workspace]
    }
    return [this.script, workspace]
  }

  async validateCandidate(value, before, workspace) {
    if (value === null || typeof value !== 'object') throw new Error('Evaluator output must be a JSON object')
    if (value.valid !== true) throw new Error(safeReason(value.reason))
    const score = scoreValue(value.score)
    const metrics = value.metrics ?? {}
    if (metrics === null || typeof metrics !== 'object' || Array.isArray(metrics)) {
      throw new Error('Evaluator metrics must be an object')
    }
    for (const spec of this.plan.metrics ?? []) {
      if (spec.optional === true && !(spec.name in metrics)) continue
      scoreValue(metrics[spec.name], `metric ${spec.name}`)
    }
    for (const spec of this.plan.selection_metrics ?? []) {
      scoreValue(metrics[spec.name], `selection metric ${spec.name}`)
    }
    const evidence = value.evidence
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new Error('No evaluation evidence')
    }
    const receipts = {}
    for (const relative of evidence) {
      if (typeof relative !== 'string' || relative.length === 0 || isAbsolute(relative)) {
        throw new Error('Evidence must exist within the evaluated workspace')
      }
      const path = resolve(workspace, relative)
      if (!isContained(workspace, path)) {
        throw new Error('Evidence must exist within the evaluated workspace')
      }
      const stat = await fsp.lstat(path).catch(() => null)
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('Evidence must exist within the evaluated workspace')
      }
      receipts[relative] = await digestFile(path)
    }
    return {
      valid: true,
      score,
      metrics,
      evidence: receipts,
      workspace_manifest_sha256: jsonDigest(before),
    }
  }

  /**
   * Evaluate one candidate workspace.
   * @param {string} workspace
   * @param {string} folder receives evaluation.log / evaluation.err.log
   * @param {{deadline?:number, signal?:AbortSignal, now?:() => number}} [options]
   */
  async evaluate(workspace, folder, options = {}) {
    if (!this.hash) throw new Error('Evaluator must be frozen before use')
    if (await digestFile(this.script) !== this.hash) {
      throw new Error('Evaluator or evaluated workspace changed; result rejected')
    }
    const before = await inventory(workspace)
    const now = options.now ?? (() => performance.now())
    const budget = Number(this.plan.evaluation_seconds)
    let seconds = budget
    if (options.deadline !== undefined) {
      seconds = Math.min(budget, (options.deadline - now()) / 1000)
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return { valid: false, reason: 'Phase budget exhausted before evaluation' }
    }
    await fsp.mkdir(folder, { recursive: true })
    const stdoutPath = join(folder, 'evaluation.log')
    const stderrPath = join(folder, 'evaluation.err.log')
    const temp = join(folder, '.method-evaluation', 'tmp')
    await fsp.mkdir(temp, { recursive: true })
    const env = { ...process.env }
    delete env.CLAUDECODE
    delete env.CODEX_THREAD_ID
    env.PYTHONDONTWRITEBYTECODE = '1'
    env.TMPDIR = temp
    env.XDG_CACHE_HOME = join(temp, 'cache')
    const run = await runEvaluatorProcess({
      argv: this.argv(workspace),
      cwd: this.output,
      env,
      timeoutMs: seconds * 1000,
      signal: options.signal,
      stdoutPath,
      stderrPath,
      ...(this.spawn ? { spawn: this.spawn } : {}),
    })
    if (await digestFile(this.script) !== this.hash) {
      throw new Error('Evaluator or evaluated workspace changed; result rejected')
    }
    const after = await inventory(workspace)
    if (!jsonEqual(before, after)) {
      throw new Error('Evaluator or evaluated workspace changed; result rejected')
    }
    if (run.aborted) return { valid: false, reason: 'Evaluation aborted' }
    if (run.error) return { valid: false, reason: `Evaluator failed to start: ${run.error.message}` }
    if (run.code !== 0 || run.timedOut) {
      return {
        valid: false,
        reason: 'Evaluator failed or exceeded its budget',
        exit_code: run.code ?? null,
      }
    }
    let value
    try {
      value = JSON.parse(run.stdout.trim())
    } catch {
      const tail = run.stderr.trim().slice(0, 400)
      return {
        valid: false,
        reason: 'Evaluator output is not a single JSON object' + (tail ? `: ${tail}` : ''),
      }
    }
    try {
      return await this.validateCandidate(value, before, workspace)
    } catch (error) {
      return { valid: false, reason: error.message }
    }
  }
}

/** @returns the frozen evaluator for a plan. */
export function createFrozenEvaluator(options) {
  return new FrozenEvaluator(options)
}
