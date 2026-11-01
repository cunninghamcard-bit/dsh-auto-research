import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ResearchStoppedError,
  Runner,
  normalizeOptions,
  providerOutcome,
  validatePlan,
} from '../lib/runner.js'
import { createWorkspaceManager, inventory } from '../lib/layerfs-workspace.js'
import { fakeClock, fakeSubagents, setState, withTemp, writeStateEvaluator, writeWorkspace } from './helpers.ts'

const sha256 = (data: any) => createHash('sha256').update(data).digest('hex')

function planFor(root: string, extra: any = {}): any {
  return {
    objective: 'Improve the fixture score',
    worker_prompt: 'Run one bounded fixture experiment and save evidence.',
    evaluator: join(root, 'evaluator.mjs'),
    evaluation_seconds: 10,
    direction: 'maximize',
    metrics: [{ name: 'score', definition: 'fixture score' }],
    selection_metrics: [],
    stall_seconds: 3600,
    meaningful_gain: 0.5,
    metric_subset: 1,
    portfolio_size: 2,
    options: {
      rounds: 1,
      branches: 2,
      explorationMinutes: 0.5,
      exploitationMinutes: 0.5,
      rsiTop: false,
      forkAndFlush: false,
      shareContext: false,
      sharingIntervalMinutes: 0.01,
    },
    ...extra,
  }
}

async function setup(root: string, {
  state = { score: 1, metrics: { score: 1 } },
  worker = null,
  extraPlan = {},
  options = {},
  clock = fakeClock(),
  config = {},
}: {
  state?: any
  worker?: any
  extraPlan?: any
  options?: any
  clock?: any
  config?: any
} = {}) {
  const workspace = join(root, 'workspace')
  await writeWorkspace(workspace, state)
  await writeStateEvaluator(join(root, 'evaluator.mjs'))
  const plan = planFor(root, extraPlan)
  Object.assign(plan.options, options)
  const output = join(root, 'out')
  const manager = await createWorkspaceManager({ output, runId: 'run', env: {} })
  const subagents = fakeSubagents(worker ?? (async (spec: any, index: number) => {
    const target = spec.request.cwd
    await setState(target, { score: 2 + index, metrics: { score: 2 + index } })
    return { output: [], stopReason: 'completed' }
  }))
  const runner = new Runner({
    config,
    plan,
    workspace,
    output,
    originalManifest: await inventory(workspace),
    selectionFile: join(root, '.auto-research-methods', 'LATEST.json'),
    deps: {
      subagents,
      workspaceManager: manager,
      parent: { id: 'parent' },
      workerProvider: 'worker',
      clock,
      runId: 'run',
      logger: { info() {}, warn() {} },
    },
  })
  return { runner, subagents, manager, output, workspace, plan, clock }
}

async function writePortfolio(cwd: string, size = 2, parent = 'initial') {
  await writeFile(join(cwd, 'PORTFOLIO.json'), JSON.stringify(Array.from({ length: size }, (_, index) => ({
    bottleneck: 'b' + index,
    mechanism: 'm' + index,
    expected_effect: 'e' + index,
    lineage: parent,
    verbalized_probability: 0.5,
  }))))
}

async function writeCheckpoint(cwd: string, index: number, { review = true }: { review?: boolean } = {}) {
  await writeFile(join(cwd, 'RESEARCH_CHECKPOINT.md'), `# checkpoint ${index}\n`)
  await mkdir(join(cwd, 'RESEARCH_CONTEXT'), { recursive: true })
  await writeFile(join(cwd, 'RESEARCH_CONTEXT', `topic__method__result__verified.md`), '# topic\n')
  await writeFile(join(cwd, 'SHARED_CHECKPOINT.json'), JSON.stringify({
    summary: `epoch ${index}: one scoped result, one failure retained`,
    files: ['RESEARCH_CHECKPOINT.md', 'RESEARCH_CONTEXT/topic__method__result__verified.md'],
  }))
  if (!review) return
  let peers = null
  try {
    const files = await readdir(join(cwd, 'SHARED_CONTEXT'))
    const bundle = files.find(name => name.startsWith('peer-evidence-'))
    if (bundle) {
      const body = await readFile(join(cwd, 'SHARED_CONTEXT', bundle))
      peers = { bundle: body, parsed: JSON.parse(body as any) }
    }
  } catch {
    peers = null
  }
  if (peers) {
    await writeFile(join(cwd, 'PEER-REVIEW.json'), JSON.stringify({
      manifest_sha256: sha256(peers.bundle),
      reviews: peers.parsed.peers.map((peer: any) => ({
        peer_id: peer.id,
        finding: 'observed ' + peer.id,
        action: 'independent check',
      })),
    }))
  }
}

describe('normalizeOptions / validatePlan', () => {
  it('merges plan options over config and validates budgets', () => {
    const options = normalizeOptions({ rounds: 1, branches: 4 }, { options: { branches: 2, rsiTop: true } })
    assert.equal(options.branches, 2)
    assert.equal(options.rsiTop, true)
    const plan = planFor(process.cwd(), { options: { ...options } })
    assert.equal(validatePlan(plan, options).evaluation_seconds, 10)
  })

  it('rejects bad plans before any worker starts', () => {
    const options = normalizeOptions({}, {})
    const base = { objective: 'o', worker_prompt: 'w', evaluator: '/e', evaluation_seconds: 1, direction: 'maximize', metrics: [{ name: 'a' }] }
    assert.throws(() => validatePlan({ ...base, objective: '' }, { ...options, branches: 2 }), /objective/)
    assert.throws(() => validatePlan({ ...base, worker_prompt: '' }, { ...options, branches: 2 }), /worker_prompt/)
    assert.throws(() => validatePlan({ ...base, evaluator: '' }, { ...options, branches: 2 }), /evaluator/)
    assert.throws(() => validatePlan({ ...base, evaluation_seconds: 0 }, { ...options, branches: 2 }), /evaluator configuration/)
    assert.throws(() => validatePlan({ ...base, direction: 'sideways' }, { ...options, branches: 2 }), /evaluator configuration/)
    assert.throws(() => validatePlan({ ...base, metrics: [{ name: 'a' }, { name: 'a' }] }, { ...options, branches: 2 }), /metric definitions/)
    assert.throws(() => validatePlan({ ...base, selection_metrics: [{ name: 'missing', direction: 'maximize' }] }, { ...options, branches: 2 }), /Selection metrics/)
    assert.throws(() => validatePlan(base, { ...options, branches: 1 }), /branch\/round/)
    assert.throws(() => validatePlan(base, { ...options, branches: 2, rounds: 0 }), /branch\/round/)
    assert.throws(() => validatePlan(base, { ...options, branches: 2, explorationMinutes: 0 }), /time budget/)
    assert.throws(() => validatePlan(base, { ...options, branches: 2, shareContext: true, sharingIntervalMinutes: 0 }), /sharing interval/)
    assert.throws(() => validatePlan({ ...base, metric_subset: 2 }, { ...options, branches: 2, rsiTop: true }), /metric definitions/)
    assert.throws(() => validatePlan({ ...base, stall_seconds: 0 }, { ...options, branches: 2, rsiTop: true, metric_subset: 1, portfolio_size: 2, meaningful_gain: 0 } as any), /RSI/)
    assert.throws(() => validatePlan({ ...base, meaningful_gain: -1 }, { ...options, branches: 2, rsiTop: true, metric_subset: 1, portfolio_size: 2, stall_seconds: 1 } as any), /meaningful_gain must be non-negative/)
    assert.throws(() => validatePlan({ ...base, portfolio_size: 1 }, { ...options, branches: 2, rsiTop: true, metric_subset: 1, stall_seconds: 1, meaningful_gain: 0 } as any), /RSI/)
  })

  it('ports provider_outcome diagnostics', () => {
    assert.deepEqual(providerOutcome([{ type: 'thread.started', thread_id: 't' }, { type: 'turn.completed' }], 0, false), {
      completed: true,
      provider_session: 't',
      terminal: 'completed',
      diagnostic_count: 0,
    })
    assert.equal(providerOutcome([{ type: 'turn.failed' }], 0, false).completed, false)
    assert.equal(providerOutcome([{ type: 'result', subtype: 'success' }], 0, false).completed, true)
    assert.equal(providerOutcome([{ type: 'result', subtype: 'success', is_error: true }], 0, false).completed, false)
    assert.equal(providerOutcome([{ type: 'error' }], 1, false).diagnostic_count, 1)
  })
})

describe('Runner batches', () => {
  it('evaluates the baseline and completes one continue branch', async () => {
    await withTemp(async root => {
      const { runner, subagents, output } = await setup(root)
      const result = await runner.run()
      assert.equal(result.status, 'COMPLETED')
      assert.equal(result.leader.id, 'round-1-continue-1')
      assert.equal(result.leader.evaluation.score, 2)
      assert.equal(result.trajectories, 2)
      assert.equal(subagents.calls.length, 1)
      assert.equal(subagents.calls[0].provider, 'worker')
      assert.equal(subagents.calls[0].delivery, 'caller')
      assert.match(subagents.calls[0].request.prompt[0].text, /Objective: Improve the fixture score/)
      assert.match(subagents.calls[0].request.prompt[0].text, /Do not spawn agents/)
      assert.equal(JSON.parse(await readFile(join(output, 'RESULT.json'), 'utf8')).leader.id, 'round-1-continue-1')
      assert.equal(JSON.parse(await readFile(join(output, 'LEADER.json'), 'utf8')).id, 'round-1-continue-1')
      assert.equal(JSON.parse(await readFile(join(output, 'SELECTIONS.json'), 'utf8')).length, 1)
      assert.equal((await stat(join(output, 'DASHBOARD.json'))).isFile(), true)
      assert.equal(JSON.parse(await readFile(join(root, '.auto-research-methods', 'LATEST.json'), 'utf8')).leader_workspace, result.leader.workspace)
      await runner.releaseAll()
    })
  })

  it('runs fork-and-flush explore then a single continue branch', async () => {
    await withTemp(async root => {
      const { runner, subagents } = await setup(root, { options: { forkAndFlush: true } })
      const result = await runner.run()
      assert.equal(subagents.calls.length, 3)
      const phases = subagents.calls.map(call => call.label.includes('explore') ? 'explore' : 'continue')
      assert.deepEqual(phases, ['explore', 'explore', 'continue'])
      assert.equal(result.leader.id, 'round-1-continue-1')
      assert.equal(result.leader.evaluation.score, 4)
      assert.equal(JSON.parse(await readFile(join(runner.output, 'SELECTIONS.json'), 'utf8')).length, 2)
      await runner.releaseAll()
    })
  })

  it('triggers an RSI-top explore cohort on a stall and enforces portfolios', async () => {
    await withTemp(async root => {
      let tick = 1000
      const clock = { now: () => { tick += 25; return tick }, sleep: async (ms: number) => { tick += ms } }
      const worker = async (spec: any, index: number) => {
        const text = spec.request.prompt[0].text
        await setState(spec.request.cwd, { score: 2 + index, metrics: { score: 2 + index, progress: 2 + index } })
        if (text.includes('RSI-top dashboard view')) await writePortfolio(spec.request.cwd, 2)
        return { output: [], stopReason: 'completed' }
      }
      const { runner, subagents } = await setup(root, {
        clock,
        worker,
        state: { score: 1, metrics: { score: 1, progress: 0 } },
        options: { rsiTop: true, forkAndFlush: false },
        extraPlan: { stall_seconds: 0.001, metrics: [{ name: 'score' }, { name: 'progress', definition: 'p' }], metric_subset: 1 },
      })
      const result = await runner.run()
      assert.equal(subagents.calls.length, 3)
      assert.match(subagents.calls[0].request.prompt[0].text, /RSI-top dashboard view/)
      const dashboard = JSON.parse(await readFile(join(runner.output, 'DASHBOARD.json'), 'utf8'))
      const exploreRows = dashboard.trajectories.filter((row: any) => row.phase === 'explore')
      assert.equal(exploreRows.length, 2)
      for (const row of exploreRows) assert.match(row.portfolio_sha256, /^[0-9a-f]{64}$/)
      assert.equal(result.leader.id, 'round-1-continue-1')
      await runner.releaseAll()
    })
  })

  it('rejects an invalid explore portfolio without promoting it', async () => {
    await withTemp(async root => {
      const worker = async (spec: any, index: number) => {
        const text = spec.request.prompt[0].text
        await setState(spec.request.cwd, { score: 2 + index, metrics: { score: 2 + index, progress: 2 + index } })
        if (text.includes('RSI-top dashboard view')) {
          await writeFile(join(spec.request.cwd, 'PORTFOLIO.json'), '[]')
        }
        return { output: [], stopReason: 'completed' }
      }
      const { runner } = await setup(root, {
        worker,
        options: { rsiTop: true, forkAndFlush: true },
        extraPlan: { metrics: [{ name: 'score' }], portfolio_size: 2 },
      })
      const result = await runner.run()
      const dashboard = JSON.parse(await readFile(join(runner.output, 'DASHBOARD.json'), 'utf8'))
      const explore = dashboard.trajectories.filter((row: any) => row.phase === 'explore')
      assert.equal(explore.length, 2)
      for (const row of explore) assert.match(row.evaluation.reason, /RSI portfolio protocol/)
      assert.equal(result.leader.id, 'round-1-continue-1')
      await runner.releaseAll()
    })
  })

  it('aborts before any worker when the baseline fails evaluation', async () => {
    await withTemp(async root => {
      const { runner, subagents } = await setup(root, { state: { valid: false, score: 0, reason: 'fixture rejects baseline' } })
      await assert.rejects(runner.run(), /Initial candidate failed frozen evaluation/)
      assert.equal(subagents.calls.length, 0)
      assert.equal(JSON.parse(await readFile(join(runner.output, 'RESULT.json'), 'utf8')).status, 'FAILED')
      await runner.releaseAll()
    })
  })

  it('distinguishes provider failure from a hard resource boundary', async () => {
    await withTemp(async root => {
      const failed = await setup(root, {
        worker: async () => ({ output: [], stopReason: 'error', diagnostic: 'provider exploded' }),
      })
      await assert.rejects(failed.runner.run(), /No provider branch completed/)
      await failed.runner.releaseAll()
    })
    await withTemp(async root => {
      const timedOut = await setup(root, {
        worker: async () => ({ output: [], stopReason: 'aborted' }),
      })
      const result = await timedOut.runner.run()
      assert.equal(result.status, 'COMPLETED')
      assert.equal(result.stop_reason, 'phase_budget_reached')
      assert.equal(result.pending_workspaces.length, 1)
      assert.equal(result.pending_workspaces[0]!.status, 'requires_independent_review')
      await timedOut.runner.releaseAll()
    })
  })

  it('selects by primary score, verified progress, and retained research state', () => {
    const make = (id: any, score: any, progress: any, time = 0) => ({
      id,
      time,
      evaluation: { valid: true, score, metrics: { score, progress } },
    })
    // A constructed runner is not needed for choose(); borrow its prototype.
    const fake = Object.create(Runner.prototype)
    fake.plan = { direction: 'maximize', selection_metrics: [{ name: 'progress', direction: 'maximize' }] }
    const incumbent = make('initial', 5, 0, 1)
    const tied = make('branch', 5, 2, 2)
    assert.equal(fake.choose(incumbent, [tied]).id, 'branch')
    const better = make('better', 6, 0, 3)
    assert.equal(fake.choose(incumbent, [tied, better]).id, 'better')
    fake.plan.direction = 'minimize'
    const low = make('low', 1, 0, 1)
    const high = make('high', 9, 0, 2)
    assert.equal(fake.choose(high, [low]).id, 'low')
    assert.throws(() => fake.choose({ id: 'x', evaluation: { valid: false } }, []), /No valid evaluated/)
  })

  it('stops a running batch through stop()', async () => {
    await withTemp(async root => {
      let release: any
      let startedResolve: any
      const gate = new Promise(resolve => { release = resolve })
      const started = new Promise(resolve => { startedResolve = resolve })
      const signalAborted = (signal: any) => signal?.aborted === true
      const worker = async (spec: any) => {
        startedResolve()
        await gate
        return { output: [], stopReason: signalAborted(spec.signal) ? 'aborted' : 'completed' }
      }
      const { runner } = await setup(root, { worker })
      const running = runner.run()
      await started
      runner.stop()
      release()
      await assert.rejects(running, error => error instanceof ResearchStoppedError)
      await runner.releaseAll()
    })
  })
})

describe('cooperative cohorts', () => {
  it('shares checkpoints and peer reviews across epochs', async () => {
    await withTemp(async root => {
      const worker = async (spec: any, index: number) => {
        await setState(spec.request.cwd, { score: 2 + index, metrics: { score: 2 + index } })
        await writeCheckpoint(spec.request.cwd, index)
        return { output: [], stopReason: 'completed' }
      }
      const { runner } = await setup(root, {
        worker,
        options: {
          shareContext: true,
          forkAndFlush: true,
          rsiTop: false,
          exploitationMinutes: 0.1,
          sharingIntervalMinutes: 0.02,
        },
        extraPlan: { evaluation_seconds: 0.5 },
      })
      const result = await runner.run()
      assert.equal(result.status, 'COMPLETED')
      const collaboration = JSON.parse(await readFile(join(runner.output, 'round-1-explore-COLLABORATION.json'), 'utf8'))
      assert.ok(collaboration.epochs.length >= 2)
      assert.equal(collaboration.epochs[0].rows.length, 2)
      const shared = collaboration.epochs.at(-1).peer_bundle
      assert.match(await readFile(shared, 'utf8'), /PEER-EVIDENCE|peers|objective/)
      assert.equal((await stat(join(shared, '..', 'shared-context.md'))).isFile(), true)
      const reviewed = collaboration.epochs.slice(1).flatMap((epoch: any) => epoch.rows)
      assert.ok(reviewed.some((row: any) => row.peer_review_sha256))
      assert.ok(collaboration.epochs[0].rows.every((row: any) => !row.peer_review_sha256))
      await runner.releaseAll()
    })
  })

  it('restores the last verified completed state when a later epoch fails', async () => {
    await withTemp(async root => {
      const worker = async (spec: any, index: number) => {
        const cwd = spec.request.cwd
        if (index === 2) {
          await writeFile(join(cwd, 'state.json'), '{"score":0}')
          return { output: [], stopReason: 'error', diagnostic: 'interrupted in epoch two' }
        }
        await setState(cwd, { score: 2 + index, metrics: { score: 2 + index } })
        await writeCheckpoint(cwd, index)
        return { output: [], stopReason: 'completed' }
      }
      const { runner } = await setup(root, {
        worker,
        options: {
          shareContext: true,
          forkAndFlush: true,
          exploitationMinutes: 0.1,
          explorationMinutes: 0.1,
          sharingIntervalMinutes: 0.02,
        },
        extraPlan: { evaluation_seconds: 0.5 },
      })
      const result = await runner.run()
      assert.equal(result.status, 'COMPLETED')
      const dashboard = JSON.parse(await readFile(join(runner.output, 'DASHBOARD.json'), 'utf8'))
      const restored = dashboard.trajectories.find((row: any) => row.retained_completed_id)
      assert.ok(restored)
      assert.match(restored.incomplete_successor, /^round-1-explore-epoch-2-branch-[12]$/)
      assert.match(restored.retained_completed_id, /^round-1-explore-epoch-1-branch-[12]$/)
      assert.match(restored.workspace, /-last-completed/)
      assert.equal((await stat(restored.workspace)).isDirectory(), true)
      assert.ok([2, 3].includes(JSON.parse(await readFile(join(restored.workspace, 'state.json'), 'utf8')).score))
      await runner.releaseAll()
    })
  })

  it('rejects a candidate that omits the peer review', async () => {
    await withTemp(async root => {
      const worker = async (spec: any, index: number) => {
        await setState(spec.request.cwd, { score: 2 + index, metrics: { score: 2 + index } })
        await writeCheckpoint(spec.request.cwd, index, { review: index < 2 })
        return { output: [], stopReason: 'completed' }
      }
      const { runner } = await setup(root, {
        worker,
        options: {
          shareContext: true,
          forkAndFlush: true,
          exploitationMinutes: 0.1,
          explorationMinutes: 0.1,
          sharingIntervalMinutes: 0.02,
        },
        extraPlan: { evaluation_seconds: 0.5 },
      })
      await assert.rejects(runner.run(), /Peer checkpoint\/review protocol failed/)
      await runner.releaseAll()
    })
  })
})
