/**
 * Real end-to-end tests: the installed dsh profile, the real Cordis plugin
 * loader, the real `ctx.subagents` service, and real LayerFS 1.1: a project
 * made by `@layerfs/runtime`'s Init, the home's worker container, and
 * Sandboxes on OrbStack Docker.
 *
 * Nothing here fakes the research seam: the plugin is mounted on a Cordis
 * context exactly as `dsh` mounts it, `ctx.subagents.startActivation` is the
 * real service, and every workspace, branch, commit and adoption is made by
 * the real LayerFS SDK. The only fixture is the worker agent: a
 * deterministic provider that raises `state.json`'s score and writes the
 * cooperative artifacts the protocol requires.
 *
 * The scenario runs two batches: the first is a two-round RSI-top batch with
 * explore + continue phases and context sharing; the second deletes the
 * leader's checkout so `LATEST.json`'s saved leader branch is adopted through
 * LayerFS.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DSH_HOME,
  DSH_ROOT,
  LAYERFS_BUNDLE,
  LAYERFS_DOCKER,
  LAYERFS_ROOT,
  RUNTIME_TAG,
  dshStackAvailable,
  layerfsApiAvailable,
  liveLayerfsAvailable,
} from './e2e-support.ts'

const AUTO_RESEARCH = new URL('../lib/index.js', import.meta.url).href
const LAYERFS_PLUGIN = new URL('../lib/layerfs.js', import.meta.url).href
const SNAPSHOT_PLUGIN = new URL('../lib/snapshot.js', import.meta.url).href
const LOCAL_PLUGIN = new URL('../lib/local.js', import.meta.url).href
const SHELL_ENV = `${DSH_ROOT}/packages/shell/shell-env/lib/index.js`
const WORKER_KEYS = ['DSH_AUTO_RESEARCH_WORKER', 'DSH_AUTO_RESEARCH_BRANCH', 'DSH_AUTO_RESEARCH_CHECKOUT', 'DSH_AUTO_RESEARCH_SANDBOX_PATH']

const EVALUATOR_SOURCE = `import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const state = JSON.parse(readFileSync(join(process.argv[2], 'state.json'), 'utf8'))
const score = Number(state.score ?? 0)
if (!Number.isFinite(score)) {
  process.stdout.write(JSON.stringify({ valid: false, reason: 'state.score is not finite' }) + '\\n')
} else {
  process.stdout.write(JSON.stringify({
    valid: state.valid !== false,
    ...(state.valid === false ? { reason: state.reason ?? 'rejected by fixture' } : {}),
    score,
    metrics: { score, trials: Number(state.trials ?? 0) },
    evidence: ['state.json', 'RESEARCH_CHECKPOINT.md'],
  }) + '\\n')
}
`

/** Unused direct dsh imports are resolved lazily so a missing checkout skips. */
async function dshModules() {
  const cordis = await import(pathToFileURL(`${DSH_ROOT}/vendor/cordis/lib/index.js`).href)
  const testkit = await import(pathToFileURL(`${DSH_ROOT}/packages/test-support/agent-loop-testkit/lib/index.js`).href)
  const subagent = await import(pathToFileURL(`${DSH_ROOT}/packages/subagent/subagent/lib/index.js`).href)
  const skill = await import(pathToFileURL(`${DSH_ROOT}/packages/skill/skill/lib/index.js`).href)
  return { Context: cordis.Context, testkit, SubagentRuntime: subagent.default, SkillRegistry: skill.default }
}

function digest(text: string | Buffer) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * A deterministic worker provider: one activation raises `state.json`'s score,
 * and writes the cooperative artifacts (checkpoint, RSI portfolio, peer
 * review) the runner validates.
 *
 * `probe(cwd, childId)` is called once per activation after the run handle is
 * created, so the scenario can ask the real `ctx.shellEnv` registry what a
 * worker's own bash call would receive.
 */
function workerProvider(probe: any = null) {
  const starts: any[] = []
  const provider = {
    name: 'e2e-worker',
    capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
    inheritsParentContext: false,
    starts,
    async start(request: any) {
      starts.push({ cwd: request.cwd })
      const stateFile = join(request.cwd, 'state.json')
      const state = JSON.parse(readFileSync(stateFile, 'utf8'))
      const next = { ...state, score: Number(state.score ?? 0) + 1, trials: Number(state.trials ?? 0) + 1 }
      writeFileSync(stateFile, JSON.stringify(next, null, 2) + '\n')
      writeFileSync(join(request.cwd, 'RESEARCH_CHECKPOINT.md'), `# Checkpoint\n\nscore=${next.score} trials=${next.trials}\n`)
      writeFileSync(join(request.cwd, 'SHARED_CHECKPOINT.json'), JSON.stringify({
        summary: `Verified score ${next.score} with ${next.trials} trials; state.json is the evidence.`,
        files: ['state.json', 'RESEARCH_CHECKPOINT.md'],
      }, null, 2) + '\n')
      writeFileSync(join(request.cwd, 'PORTFOLIO.json'), JSON.stringify([
        {
          bottleneck: 'single scoring path',
          mechanism: 'increment the fixture score',
          expected_effect: 'score rises by one',
          lineage: `e2e-${next.trials}`,
          verbalized_probability: 0.7,
        },
        {
          bottleneck: 'no second measurement',
          mechanism: 'record a trial counter',
          expected_effect: 'trials rise by one',
          lineage: `e2e-${next.trials}-b`,
          verbalized_probability: 0.3,
        },
      ], null, 2) + '\n')
      writePeerReview(request.cwd)
      // `dsh` derives the child session id from the returned run's `id`.
      const childId = `worker-${starts.length}`
      await probe?.(request.cwd, childId)
      return {
        id: childId,
        result: Promise.resolve({
          output: [{ type: 'text', text: `raised score to ${next.score}` }],
          stopReason: 'completed',
        }),
        async dispose() {},
      }
    },
  }
  return provider
}

/** Write the worker's peer review when the branch received a peer snapshot. */
function writePeerReview(cwd: string) {
  const dir = join(cwd, 'SHARED_CONTEXT')
  if (!existsSync(dir)) return
  // A resumed branch keeps earlier epochs' snapshots in the same folder; the
  // newest one is this epoch's published peer evidence.
  const entries = readdirSync(dir)
    .filter(name => name.startsWith('peer-evidence-'))
    .map(name => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  if (entries.length === 0) return
  const text = readFileSync(join(dir, entries[0]!.name), 'utf8')
  const bundle = JSON.parse(text)
  const peers = Array.isArray(bundle.peers) ? bundle.peers : []
  writeFileSync(join(cwd, 'PEER-REVIEW.json'), JSON.stringify({
    manifest_sha256: digest(Buffer.from(text)),
    reviews: peers.map((peer: any) => ({
      peer_id: peer.id,
      finding: `peer ${peer.id} reported a verified score`,
      action: 'independent check of its stated evidence',
    })),
  }, null, 2) + '\n')
}

/** The dsh subagent service plus one ready parent agent, as dsh builds them. */
async function mountDshContext(modules: any) {
  const ctx = new modules.Context()
  await modules.testkit.mountAgentLoopTestDependencies(ctx, {
    workingDirectory: true,
    systemPrompt: { personaPrefix: 'You are an end-to-end test parent agent.' },
  })
  const harness = await modules.testkit.mountAgentLoopTestHarness(ctx)
  const agent = await harness.create('e2e-parent', { provider: 'e2e', model: 'e2e' }, { cwd: tmpdir() })
  await ctx.plugin(modules.SubagentRuntime)
  await ctx.plugin(modules.SkillRegistry)
  return { ctx, agent, harness }
}

/**
 * A faithful stand-in for `@deepseek-ai/dsh-shell-env`'s `ShellEnvRegistry`
 * for a harness build that does not ship the real one: `register()` keeps
 * declarations, and `collect(execution)` enforces them exactly like the
 * production registry.
 */
function fallbackShellEnvRegistry() {
  const contributors = new Map()
  return {
    register(contributor: any) {
      if (contributors.has(contributor.name)) throw new Error(`bash env contributor "${contributor.name}" is already registered`)
      contributors.set(contributor.name, contributor)
      return () => contributors.delete(contributor.name)
    },
    collect(execution: any) {
      const values: Record<string, string> = {}
      for (const contributor of [...contributors.values()].sort((left, right) => left.name.localeCompare(right.name))) {
        for (const [key, value] of Object.entries(contributor.resolve(execution))) {
          if (!Object.hasOwn(contributor.variables, key)) throw new Error(`undeclared bash env key "${key}"`)
          if (typeof value !== 'string') throw new Error(`non-string bash env value for "${key}"`)
          values[key] = value
        }
      }
      return Object.freeze(values)
    },
    list() {
      return [...contributors.values()].flatMap(contributor => Object.keys(contributor.variables))
    },
  }
}

/**
 * Publish the LayerFS binding the way `@dsh-layerfs/host` does: through the
 * real `ctx.shellEnv` registry, whose contract is `register(contributor)` plus
 * `collect(execution)`.
 */
async function mountShellEnv(ctx: any, env: any) {
  const variables = Object.fromEntries(Object.keys(env).map(key => [key, { description: `e2e LayerFS fact ${key}` }]))
  const contributor = {
    name: 'layerfs',
    variables,
    resolve(execution: any) {
      assert.ok(execution.callId, 'collect() receives a complete tool execution with a callId')
      assert.ok(execution.rootCallId, 'collect() receives a complete tool execution with a rootCallId')
      return { ...env }
    },
  }
  if (existsSync(SHELL_ENV)) {
    const shellEnv = await import(pathToFileURL(SHELL_ENV).href)
    await ctx.plugin(shellEnv, { dshHome: join(tmpdir(), 'dsh-e2e-home') })
    ctx.shellEnv.register(contributor)
    return
  }
  ctx.provide('shellEnv', fallbackShellEnvRegistry())
  ctx.shellEnv.register(contributor)
}

/** The shell environment a worker's own bash call resolves through `ctx.shellEnv`. */
function collectFor(ctx: any, agent: any, callId = 'bash-1') {
  return ctx.shellEnv.collect({
    agent,
    callId,
    rootCallId: callId,
    name: 'bash',
    arguments: { command: 'true' },
    signal: new AbortController().signal,
  })
}

/** Mount the worker backend and the real plugin, and start one batch. */
async function runBatch({ ctx, agent, workspace, pluginConfig }: any) {
  const activation = await ctx.subagents.startActivation({
    provider: 'auto-research',
    label: 'e2e-batch',
    request: {
      cwd: workspace,
      prompt: [{ type: 'text', text: 'Run one auto-research batch on this checkout.' }],
      parent: agent,
    },
    delivery: 'caller',
    signal: new AbortController().signal,
  })
  try {
    return await activation.result
  } finally {
    await activation.dispose().catch(() => {})
  }
}

/** A fixture checkout with state, checkpoint, evaluator and plan. */
function makeWorkspace(root: string) {
  const workspace = join(root, 'repo')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'state.json'), JSON.stringify({ score: 1, trials: 0 }, null, 2) + '\n')
  writeFileSync(join(workspace, 'RESEARCH_CHECKPOINT.md'), '# Checkpoint\n\nBaseline fixture.\n')
  writeFileSync(join(workspace, 'evaluator.mjs'), EVALUATOR_SOURCE)
  mkdirSync(join(workspace, '.auto-research-methods'), { recursive: true })
  writeFileSync(join(workspace, '.auto-research-methods', 'plan.json'), JSON.stringify({
    objective: 'Maximize the fixture score with reproducible experiments',
    worker_prompt: 'Read state.json, raise its score by one, record a checkpoint, and stop.',
    evaluator: join(workspace, 'evaluator.mjs'),
    evaluation_seconds: 1,
    direction: 'maximize',
    metrics: [{ name: 'score', definition: 'score field of state.json' }],
    selection_metrics: [],
    stall_seconds: 0.001,
    meaningful_gain: 0.01,
    metric_subset: 1,
    portfolio_size: 2,
  }, null, 2) + '\n')
  return workspace
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Run two batches on a real LayerFS project and assert the full batch + adoption contract. */
async function scenario() {
  const modules = await dshModules()
  const root = mkdtempSync(join(tmpdir(), 'dsh-ar-e2e-live-'))
  const workspace = makeWorkspace(root)
  const live = await setUpLive(root, workspace)
  const env = live.env
  let ctx: any = null
  let harness: any = null
  /** What each worker's own bash call would receive from `ctx.shellEnv`. */
  const workerEnvironments: any[] = []
  const worker = workerProvider(async (cwd: string, childId: string) => {
    // A real dsh session whose working directory is the branch checkout: the
    // provider matches it through `ctx.workingDirectory`.
    const probe = await harness.create(`probe-${childId}`, { provider: 'e2e', model: 'e2e' }, { cwd })
    workerEnvironments.push({
      cwd,
      collected: collectFor(ctx, probe),
      skills: ctx.skills.list({ cwd }),
    })
  })
  const mounted = await mountDshContext(modules)
  ctx = mounted.ctx
  harness = mounted.harness
  const agent = mounted.agent
  try {
    await mountShellEnv(ctx, env)
    await ctx.plugin({
      name: 'e2e-worker-backend',
      inject: ['subagents'],
      apply(context: any) { context.subagents.registerProvider(worker) },
    })
    // The backend plugins load before the core: Cordis holds them until the
    // core provides `researchWorkspace`.
    await ctx.plugin(await import(LAYERFS_PLUGIN))
    const snapshotFiber = await ctx.plugin(await import(SNAPSHOT_PLUGIN))
    await ctx.plugin(await import(LOCAL_PLUGIN))
    const plugin = await import(AUTO_RESEARCH)
    await ctx.plugin(plugin, {
      providerName: 'auto-research',
      workerProvider: 'e2e-worker',
      rounds: 2,
      branches: 2,
      // Exactly two cooperative epochs: with a 4.8 s explore budget and a
      // 2.5 s sharing interval the second epoch still has a ~1.3 s provider
      // window (plus the evaluation's own second), and no third epoch starts.
      // A shorter interval would start a third epoch with almost no window and
      // abort the batch on a loaded machine.
      explorationMinutes: 0.08,
      exploitationMinutes: 0.04,
      rsiTop: true,
      forkAndFlush: true,
      shareContext: true,
      sharingIntervalMinutes: 0.042,
    })
    assert.deepEqual(ctx.subagents.list().filter((name: string) => name === 'auto-research'), ['auto-research'])

    // One batch: two rounds, each explore (cohort, 2 branches) + continue.
    const first = await runBatch({ ctx, agent, workspace })
    assert.equal(first.stopReason, 'completed', String(first.diagnostic ?? ''))
    assert.match(first.output.map((block: any) => block.text ?? '').join('\n'), /Auto-research batch COMPLETED/)

    // The provider registered a `shellEnv` contributor that resolves each
    // running worker's branch environment for its own bash calls, while the
    // coordinator's calls stay clean.
    assert.ok(workerEnvironments.length > 0, 'workers were probed')
    for (const entry of workerEnvironments) {
      const { collected } = entry
      assert.equal(collected.DSH_AUTO_RESEARCH_WORKER, '1', 'a worker bash call receives DSH_AUTO_RESEARCH_WORKER')
      assert.match(String(collected.DSH_AUTO_RESEARCH_BRANCH), /^ar-[a-z0-9-]+$/)
      assert.equal(collected.DSH_AUTO_RESEARCH_CHECKOUT, entry.cwd)
      // The session's LayerFS facts are still contributed to the same call.
      assert.ok(collected.DSH_LAYERFS_PROJECT, 'the LayerFS contributor still publishes the project')
      // The real skill registry shows a running worker its own skill only.
      assert.deepEqual((await entry.skills).map((skill: any) => skill.name).filter((name: string) => name.startsWith('auto-research')), ['auto-research-worker'])
    }
    assert.deepEqual((await ctx.skills.list({ cwd: workspace })).map((skill: any) => skill.name).filter((name: string) => name.startsWith('auto-research')), ['auto-research'])
    const coordinatorEnv = collectFor(ctx, agent)
    assert.equal(coordinatorEnv.DSH_AUTO_RESEARCH_WORKER, undefined, 'the coordinator gets no worker flag')
    assert.ok(coordinatorEnv.DSH_LAYERFS_PROJECT, 'the coordinator still receives the LayerFS facts')

    const runtime = join(workspace, '.auto-research-methods')
    const latest = readJson(join(runtime, 'LATEST.json'))
    assert.match(latest.leader_branch, /^ar-[a-z0-9-]+$/)
    const leaderWorkspace = latest.leader_workspace
    assert.ok(existsSync(leaderWorkspace), `leader workspace exists: ${leaderWorkspace}`)
    const leaderState = readJson(join(leaderWorkspace, 'state.json'))
    assert.ok(leaderState.score > 1, `leader improved the baseline score: ${leaderState.score}`)

    const runDir = latest.run
    const selections = readJson(join(runDir, 'SELECTIONS.json'))
    assert.deepEqual(selections.map((entry: any) => entry.phase), ['explore', 'continue', 'explore', 'continue'])
    const collaboration = readJson(join(runDir, 'round-1-explore-COLLABORATION.json'))
    assert.ok(collaboration.epochs.length >= 2, 'the cooperative cohort shared at least once')
    assert.ok(collaboration.epochs.some((epoch: any) => epoch.peer_bundle), 'a later epoch received peer evidence')
    const dashboard = readJson(join(runDir, 'DASHBOARD.json'))
    assert.ok(dashboard, 'dashboard written')

    // Second batch: delete the leader checkout so LATEST.json's branch is adopted.
    rmSync(leaderWorkspace, { recursive: true, force: true })
    const second = await runBatch({ ctx, agent, workspace })
    assert.equal(second.stopReason, 'completed', String(second.diagnostic ?? ''))
    const latest2 = readJson(join(runtime, 'LATEST.json'))
    assert.notEqual(latest2.run, latest.run, 'the second batch is a new run')
    const secondInitial = readJson(join(latest2.run, 'initial', 'INPUT-MANIFEST.json'))
    assert.ok(Object.keys(secondInitial).length > 0, 'the adopted branch materialized files')
    const secondDashboard = readJson(join(latest2.run, 'DASHBOARD.json'))
    const adopted = secondDashboard.trajectories.find((row: any) => row.id === 'initial')
    assert.ok(adopted, 'the second batch evaluated an initial candidate')
    assert.ok(adopted.evaluation.score >= leaderState.score,
      `the adopted branch carried the leader score (${adopted.evaluation.score} >= ${leaderState.score})`)
    assert.equal(adopted.workspace.includes(leaderWorkspace), false, 'the deleted checkout was replaced by the adopted branch')
    const secondResult = readJson(join(latest2.run, 'RESULT.json'))
    assert.equal(secondResult.status, 'COMPLETED')

    assert.deepEqual(ctx.researchExecutor.list().map((factory: any) => factory.name), ['local'])

    // Unloading a backend plugin removes its factory.
    assert.deepEqual(ctx.researchWorkspace.list().map((factory: any) => factory.name), ['layerfs', 'snapshot'])
    await snapshotFiber.dispose()
    assert.deepEqual(ctx.researchWorkspace.list().map((factory: any) => factory.name), ['layerfs'])
    return { root, latest, latest2, worker }
  } finally {
    await ctx.fiber?.dispose?.()
    await live.cleanup()
    if (process.env.E2E_KEEP) console.error('[e2e] kept', root)
    else rmSync(root, { recursive: true, force: true })
  }
}

/**
 * A LayerFS home, its worker and one project Init made from `workspace`, the
 * way `@dsh-layerfs/host` makes them, plus the `DSH_LAYERFS_*` binding the
 * Host would publish for a session on that project.
 */
async function setUpLive(root: string, workspace: string) {
  const docker = (...args: any[]) => execFileSync('docker', ['-H', `unix://${LAYERFS_DOCKER}`, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()
  const { LayerFSRuntime } = await import(pathToFileURL(`${LAYERFS_ROOT}/api/runtime/src/index.js`).href)
  const id = Date.now().toString(36)
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const project = `dshare2e${id}`
  const prefix = `dsh-ar-e2e-${id}-`
  const image = docker('image', 'inspect', '--format', '{{.Id}}', RUNTIME_TAG)
  const runtime = await LayerFSRuntime.open({ home, image, bundle: LAYERFS_BUNDLE, docker: LAYERFS_DOCKER, containerPrefix: prefix, sweep: false })
  const cleanup = async () => {
    try {
      await runtime.project.remove(project, { confirm: project, stopSandboxes: true })
    } catch {}
    await runtime.close()
    // The worker and every Sandbox of this run carry the run's prefix.
    try {
      const left = docker('ps', '-aq', '--filter', `name=${prefix}`).split('\n').filter(Boolean)
      if (left.length) docker('rm', '-f', ...left)
    } catch {}
  }
  try {
    let job = await runtime.project.start_init(project, workspace)
    while (!job.ended) {
      await new Promise(resolve => setTimeout(resolve, 300))
      job = await runtime.project.get_init(job.id)
    }
    assert.equal(job.step, 'done', `LayerFS Init: ${JSON.stringify(job.error)}`)
    const volume = job.project.volume
    return {
      env: {
        DSH_LAYERFS_PROJECT: project,
        DSH_LAYERFS_SDK: pathToFileURL(`${LAYERFS_ROOT}/api/agent/src/index.js`).href,
        DSH_LAYERFS_HOME: home,
        DSH_LAYERFS_DOCKER: LAYERFS_DOCKER,
        DSH_LAYERFS_IMAGE: image,
        DSH_LAYERFS_VOLUME: volume,
        DSH_LAYERFS_DAEMON: join(LAYERFS_BUNDLE, 'layerfs-daemon'),
        DSH_LAYERFS_STORE_PATH: `/var/lib/docker/volumes/${volume}/_data/global/store.sqlite`,
        DSH_LAYERFS_CONTAINER_PREFIX: prefix,
        DSH_LAYERFS_WORKER_ENDPOINT: join(home, 'worker', 'endpoint.json'),
      },
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

describe('real end-to-end', () => {
  it('loads dsh-layerfs and dsh-auto-research in the installed dsh profile', async (t) => {
    const dsh = join(DSH_ROOT, 'apps/cli/lib/bin.js')
    if (!existsSync(dsh) || !existsSync(join(DSH_HOME, 'profiles/web/package.json'))) {
      return t.skip('installed dsh profile is not available')
    }
    const tree = execFileSync(process.execPath, [dsh, '--profile', 'web', '--dump-config'], {
      cwd: DSH_ROOT,
      env: { ...process.env, DSH_HOME },
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
    assert.match(tree, /# == dsh-layerfs/)
    assert.match(tree, /# == dsh-auto-research/)
    // A user patch may replace the plugin config; the tool binding names the provider either way.
    assert.match(tree, /provider: auto-research/)
    assert.match(tree, /toolName: subagent_auto_research/)
    const profile = readJson(join(DSH_HOME, 'profiles/web/package.json'))
    assert.ok(profile.dsh.profile.bundles.includes('dsh-layerfs'))
    assert.ok(profile.dsh.profile.bundles.includes('dsh-auto-research'))
    const patch = readFileSync(join(DSH_HOME, 'profiles/web/cordis.patch.yml'), 'utf8')
    assert.match(patch, /image: "sha256:[0-9a-f]{64}"/)
    assert.match(patch, /docker:\s+\S+docker\.sock/)
  })

  it('runs two real batches against OrbStack Docker LayerFS and adopts the leader branch', async (t) => {
    if (!dshStackAvailable()) return t.skip('deepseek-harness build is not available')
    if (!layerfsApiAvailable()) return t.skip('the LayerFS checkout\'s api packages are not linked')
    if (!liveLayerfsAvailable()) return t.skip('OrbStack Docker or the sealed LayerFS bundle is not available')
    try {
      execFileSync('docker', ['-H', `unix://${LAYERFS_DOCKER}`, 'image', 'inspect', '--format', '{{.Id}}', RUNTIME_TAG], { encoding: 'utf8' })
    } catch {
      return t.skip(`runtime image ${RUNTIME_TAG} is not built`)
    }
    const result = await scenario()
    assert.ok(result.worker.starts.length >= 12, `worker activations: ${result.worker.starts.length}`)
  })
})
