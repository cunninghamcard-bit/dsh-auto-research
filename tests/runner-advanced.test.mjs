import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ResearchStoppedError,
  Runner,
} from '../lib/runner.js'
import { LayerFSBackend, WorkspaceManager, createWorkspaceManager, inventory } from '../lib/layerfs-workspace.js'
import { SHARED_CONTEXT_POLICY } from '../lib/policies.js'
import { fakeClock, fakeSubagents, setState, withTemp, writeStateEvaluator, writeWorkspace } from './helpers.mjs'

const sha256 = data => createHash('sha256').update(data).digest('hex')

function planFor(root, extra = {}) {
  return {
    objective: 'Improve the fixture score',
    worker_prompt: 'Run one bounded fixture experiment and save evidence.',
    evaluator: join(root, 'evaluator.mjs'),
    evaluation_seconds: 10,
    direction: 'maximize',
    metrics: [{ name: 'score', definition: 'fixture score' }, { name: 'progress', definition: 'fixture progress' }],
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

async function setup(root, {
  state = { score: 1, metrics: { score: 1, progress: 0 } },
  worker,
  extraPlan = {},
  options = {},
  manager = null,
  subagents = null,
  clock = fakeClock(),
} = {}) {
  const workspace = join(root, 'workspace')
  await writeWorkspace(workspace, state)
  await writeStateEvaluator(join(root, 'evaluator.mjs'))
  const plan = planFor(root, extraPlan)
  Object.assign(plan.options, options)
  const output = join(root, 'out')
  const workspaceManager = manager ?? await createWorkspaceManager({ output, runId: 'run', env: {} })
  const service = subagents ?? fakeSubagents(worker)
  const runner = new Runner({
    config: {},
    plan,
    workspace,
    output,
    originalManifest: await inventory(workspace),
    selectionFile: join(root, '.auto-research-methods', 'LATEST.json'),
    deps: {
      subagents: service,
      workspaceManager,
      parent: { id: 'parent' },
      workerProvider: 'worker',
      clock,
      runId: 'run',
      logger: { info() {}, warn() {} },
    },
  })
  return { runner, subagents: service, manager: workspaceManager, output, workspace, plan, clock }
}

async function writePortfolio(cwd, size = 2, parent = 'initial') {
  await writeFile(join(cwd, 'PORTFOLIO.json'), JSON.stringify(Array.from({ length: size }, (_, index) => ({
    bottleneck: 'b' + index,
    mechanism: 'm' + index,
    expected_effect: 'e' + index,
    lineage: parent,
    verbalized_probability: 0.5,
  }))))
}

async function writeCheckpoint(cwd, index) {
  await writeFile(join(cwd, 'RESEARCH_CHECKPOINT.md'), `# checkpoint ${index}\n`)
  await mkdir(join(cwd, 'RESEARCH_CONTEXT'), { recursive: true })
  await writeFile(join(cwd, 'RESEARCH_CONTEXT', `topic${index}__method__result__verified.md`), '# topic\n')
  await writeFile(join(cwd, 'RESEARCH_HANDOFF.md'), `# handoff ${index}\n`)
  await writeFile(join(cwd, 'SHARED_CHECKPOINT.json'), JSON.stringify({
    summary: `epoch ${index}: one scoped result, one failure retained`,
    files: ['RESEARCH_CHECKPOINT.md', `RESEARCH_CONTEXT/topic${index}__method__result__verified.md`],
  }))
  const files = await readdir(join(cwd, 'SHARED_CONTEXT')).catch(() => [])
  const bundle = files.find(name => name.startsWith('peer-evidence-'))
  if (!bundle) return
  const body = await readFile(join(cwd, 'SHARED_CONTEXT', bundle))
  const parsed = JSON.parse(body)
  await writeFile(join(cwd, 'PEER-REVIEW.json'), JSON.stringify({
    manifest_sha256: sha256(body),
    reviews: parsed.peers.map(peer => ({
      peer_id: peer.id,
      finding: 'observed ' + peer.id,
      action: 'independent check',
    })),
  }))
}

function hostLayerfs(root, actions) {
  const mounts = join(root, 'mounts')
  return {
    branch: {
      async fork(name, from) {
        actions.push(['fork', name, from])
        await mkdir(join(mounts, name), { recursive: true })
      },
    },
    workspace: {
      async mount(name) {
        actions.push(['mount', name])
        const path = join(mounts, name)
        await mkdir(path, { recursive: true })
        return { sandbox: name, path }
      },
      async commit(handle, message) {
        actions.push(['commit', handle.sandbox, message])
      },
      async unmount(handle, discard) {
        actions.push(['unmount', handle.sandbox, discard])
      },
    },
    async close() {
      actions.push(['close'])
    },
  }
}

describe('P0: full RSI view, provider archival, and continuation handoff', () => {
  it('serializes the complete view in prompt/LAUNCH, archives provider.jsonl, and hands off output', async () => {
    await withTemp(async root => {
      const worker = async (spec, index) => {
        const text = spec.request.prompt[0].text
        await setState(spec.request.cwd, { score: 2 + index, metrics: { score: 2 + index, progress: 2 + index } })
        if (text.includes('RSI-top dashboard view')) await writePortfolio(spec.request.cwd, 2)
        return { output: [{ type: 'text', text: `assistant output ${index}` }], stopReason: 'completed' }
      }
      const { runner, subagents } = await setup(root, {
        worker,
        options: { forkAndFlush: true, rsiTop: true },
      })
      const result = await runner.run()
      assert.equal(subagents.calls.length, 3)

      const launch = JSON.parse(await readFile(join(runner.output, 'round-1-explore-1', 'LAUNCH.json'), 'utf8'))
      assert.deepEqual(Object.keys(launch.metric_view).sort(), ['definitions', 'diagnostics', 'rows'])
      assert.equal(launch.metric_view.definitions.length, 1)
      assert.ok(Array.isArray(launch.metric_view.diagnostics))
      assert.ok(Array.isArray(launch.metric_view.rows))
      const exploreCall = subagents.calls.find(call => call.label.includes('explore'))
      assert.ok(exploreCall)
      const line = exploreCall.request.prompt[0].text.split('\n').find(value => value.startsWith('RSI-top dashboard view'))
      assert.ok(line)
      const promptView = JSON.parse(line.slice(line.indexOf(':') + 2))
      assert.deepEqual(Object.keys(promptView).sort(), ['definitions', 'diagnostics', 'rows'])
      assert.equal(promptView.definitions.length, 1)
      assert.ok(Array.isArray(promptView.rows))

      const continueCall = subagents.calls.find(call => call.label.includes('continue'))
      assert.ok(continueCall)
      const continuePrompt = continueCall.request.prompt[0].text
      const continueLaunch = JSON.parse(await readFile(join(runner.output, 'round-1-continue-1', 'LAUNCH.json'), 'utf8'))
      const parentId = continueLaunch.parent
      assert.equal(continueLaunch.fresh_context, false)
      assert.equal(typeof continueLaunch.provider_session, 'string')
      assert.equal(continueLaunch.handoff_from, parentId)
      assert.match(continuePrompt, new RegExp(`Previous turn handoff \\(from parent ${parentId}\\):`))
      assert.match(continuePrompt, new RegExp(`assistant output [01]`))
      const handoff = await readFile(join(runner.output, 'round-1-continue-1', 'workspace', '.auto-research-methods-handoff.md'), 'utf8')
      assert.match(handoff, /assistant output [01]/)

      const transcript = (await readFile(join(runner.output, 'round-1-continue-1', 'provider.jsonl'), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line))
      assert.deepEqual(transcript.map(event => event.type), ['prompt', 'assistant', 'result'])
      assert.match(transcript[1].text, /assistant output 2/)
      assert.equal(transcript[2].stop_reason, 'completed')
      assert.ok(transcript[2].duration_ms >= 0)
      assert.match(transcript[0].text, /Objective: Improve the fixture score/)

      const dashboard = JSON.parse(await readFile(join(runner.output, 'DASHBOARD.json'), 'utf8'))
      for (const row of dashboard.trajectories.filter(row => row.phase)) {
        assert.equal(typeof row.last_output, 'string')
      }
      assert.equal(result.leader.id, 'round-1-continue-1')
      await runner.releaseAll()
    })
  })
})

describe('P0/P1: rejected branch preservation and cooperative fidelity', () => {
  it('commits completed rejected branches and never discards them', async () => {
    await withTemp(async root => {
      const actions = []
      const workspace = join(root, 'workspace')
      await writeWorkspace(workspace)
      await writeStateEvaluator(join(root, 'evaluator.mjs'))
      const output = join(root, 'out')
      const manager = new WorkspaceManager(
        new LayerFSBackend({ client: hostLayerfs(root, actions), output, runId: 'run' }),
        { output },
      )
      const worker = async (spec, index) => {
        if (index === 0) {
          await setState(spec.request.cwd, { valid: false, score: 0, reason: 'scientifically rejected' })
        } else {
          await setState(spec.request.cwd, { score: 5, metrics: { score: 5, progress: 1 } })
        }
        return { output: [{ type: 'text', text: `done ${index}` }], stopReason: 'completed' }
      }
      const { runner } = await setup(root, {
        worker,
        manager,
        options: { forkAndFlush: true, rsiTop: false },
      })
      await runner.run()
      const commits = actions.filter(action => action[0] === 'commit').map(action => action[2])
      assert.ok(commits.some(message => /^auto-research: rejected round-1-explore-[12]$/.test(message)), commits.join('\n'))
      assert.ok(commits.some(message => /^auto-research: verified round-1-explore-[12]$/.test(message)), commits.join('\n'))
      assert.ok(!actions.some(action => action[0] === 'unmount' && action[2] === true))
      const dashboard = JSON.parse(await readFile(join(runner.output, 'DASHBOARD.json'), 'utf8'))
      const rejected = dashboard.trajectories.filter(row => row.phase === 'explore' && row.evaluation.valid === false)
      assert.equal(rejected.length, 1)
      await runner.releaseAll()
    })
  })

  it('publishes policy, peer paths, and copies shared-context.md into later branches', async () => {
    await withTemp(async root => {
      const prompts = []
      const worker = async (spec, index) => {
        const text = spec.request.prompt[0].text
        prompts.push({ index, text, cwd: spec.request.cwd })
        await setState(spec.request.cwd, { score: 2 + index, metrics: { score: 2 + index, progress: 2 + index } })
        await writeCheckpoint(spec.request.cwd, index)
        return { output: [{ type: 'text', text: `coop ${index}` }], stopReason: 'completed' }
      }
      const { runner } = await setup(root, {
        worker,
        options: {
          shareContext: true,
          forkAndFlush: true,
          rsiTop: false,
          explorationMinutes: 0.1,
          exploitationMinutes: 0.1,
          sharingIntervalMinutes: 0.02,
        },
        extraPlan: { evaluation_seconds: 0.5 },
      })
      const result = await runner.run()
      assert.equal(result.status, 'COMPLETED')
      const collaboration = JSON.parse(await readFile(join(runner.output, 'round-1-explore-COLLABORATION.json'), 'utf8'))
      assert.ok(collaboration.epochs.length >= 2)
      const publication = join(runner.output, 'round-1-explore-epoch-1-shared', 'shared-context.md')
      const shared = await readFile(publication, 'utf8')
      assert.ok(shared.startsWith(SHARED_CONTEXT_POLICY))
      assert.match(shared, /Checkout: .*workspace/)
      assert.match(shared, /Saved transcript: .*provider\.jsonl/)
      assert.match(shared, /Saved notes: .*RESEARCH_HANDOFF\.md/)
      assert.match(shared, /RESEARCH_CONTEXT\/topic0__method__result__verified\.md/)
      assert.match(shared, /topic0 \/ method \/ result \/ verified/)

      const later = prompts.find(entry => entry.text.includes('Read the published cooperative context at'))
      assert.ok(later)
      const expected = join(later.cwd, 'SHARED_CONTEXT', 'shared-context.md')
      assert.ok(later.text.includes(expected))
      const copied = await readFile(expected, 'utf8')
      assert.ok(copied.startsWith(SHARED_CONTEXT_POLICY))
      assert.match(copied, /Checkout: .*workspace/)
      const publications = (await readdir(runner.output)).filter(name => name.endsWith('-shared'))
      const publishedContexts = await Promise.all(publications.map(name => readFile(join(runner.output, name, 'shared-context.md'), 'utf8')))
      assert.ok(publishedContexts.includes(copied), 'the branch copy must come from a published shared-context.md')
      const copiedMode = (await stat(expected)).mode % 512
      assert.ok(copiedMode === 384 || copiedMode === 292, copiedMode.toString(8))
      await runner.releaseAll()
    })
  })
})

describe('P1: sibling aborts, disposal, dedupe, cancellation artifacts', () => {
  it('aborts siblings and always disposes activations when one result rejects', async () => {
    await withTemp(async root => {
      const calls = []
      let disposed = 0
      let siblingAborted = false
      const subagents = {
        list: () => ['worker'],
        async startActivation(spec) {
          const index = calls.length
          calls.push(spec)
          if (index === 0) {
            return {
              childId: 'child-0',
              result: Promise.reject(new Error('worker exploded')),
              dispose: async () => { disposed += 1 },
            }
          }
          return {
            childId: 'child-1',
            result: new Promise(resolve => {
              const finish = () => {
                siblingAborted = true
                resolve({ output: [], stopReason: 'aborted' })
              }
              if (spec.signal?.aborted) finish()
              else spec.signal?.addEventListener('abort', finish, { once: true })
            }),
            dispose: async () => { disposed += 1 },
          }
        },
      }
      const { runner, manager } = await setup(root, {
        subagents,
        options: { forkAndFlush: true, rsiTop: false },
      })
      let commits = 0
      let releases = 0
      const commit = manager.commit.bind(manager)
      const release = manager.release.bind(manager)
      manager.commit = async (...args) => { commits += 1; return commit(...args) }
      manager.release = async (...args) => { releases += 1; return release(...args) }
      await assert.rejects(runner.run(), /worker exploded/)
      assert.equal(siblingAborted, true)
      assert.equal(disposed, 2)
      await runner.releaseAll()
      assert.ok(commits <= releases)
      assert.equal(releases, 3)
    })
  })

  it('releases a shared cooperative-resume state exactly once', async () => {
    await withTemp(async root => {
      const { runner, manager } = await setup(root, { worker: async () => ({ output: [], stopReason: 'completed' }) })
      const state = { id: 'shared', backend: 'snapshot', path: join(root, 'workspace'), branch: null }
      runner.rows.push(
        { id: 'a', parent: 'initial', workspace: state.path, evaluation: { valid: true, score: 1 }, _state: state, _ownsState: true },
        { id: 'b', parent: 'initial', workspace: state.path, evaluation: { valid: true, score: 1 }, _state: state, _ownsState: true },
      )
      let commits = 0
      let releases = 0
      const commit = manager.commit.bind(manager)
      const release = manager.release.bind(manager)
      manager.commit = async (...args) => { commits += 1; return commit(...args) }
      manager.release = async (...args) => { releases += 1; return release(...args) }
      await runner.releaseAll()
      assert.equal(commits, 1)
      assert.equal(releases, 1)
    })
  })

  it('writes a STOPPED RESULT.json with pending workspaces and preserves the branch', async () => {
    await withTemp(async root => {
      const actions = []
      const workspace = join(root, 'workspace')
      await writeWorkspace(workspace)
      await writeStateEvaluator(join(root, 'evaluator.mjs'))
      const output = join(root, 'out')
      const manager = new WorkspaceManager(
        new LayerFSBackend({ client: hostLayerfs(root, actions), output, runId: 'run' }),
        { output },
      )
      let startedResolve
      const started = new Promise(resolve => { startedResolve = resolve })
      let release
      const gate = new Promise(resolve => { release = resolve })
      const worker = async spec => {
        startedResolve()
        await gate
        return { output: [], stopReason: spec.signal?.aborted ? 'aborted' : 'completed' }
      }
      const { runner } = await setup(root, { worker, manager, options: { rsiTop: false } })
      const running = runner.run()
      await started
      runner.stop()
      release()
      await assert.rejects(running, error => error instanceof ResearchStoppedError)
      const stopped = JSON.parse(await readFile(join(output, 'RESULT.json'), 'utf8'))
      assert.equal(stopped.status, 'STOPPED')
      assert.equal(stopped.stop_reason, 'stopped')
      assert.equal(stopped.artifacts_preserved, true)
      assert.equal(stopped.pending_workspaces.length, 1)
      assert.match(stopped.pending_workspaces[0].workspace, /round-1-continue-1/)
      assert.ok(actions.some(action => action[0] === 'commit' && action[2].startsWith('auto-research: unverified')))
      assert.ok(!actions.some(action => action[0] === 'unmount' && action[2] === true))
      await runner.releaseAll()
    })
  })
})
