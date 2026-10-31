/**
 * Regression coverage for the post-E2E review fixes.
 *
 * Each block names the finding it locks down so a future refactor that
 * reintroduces the leak or race fails here first.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AutoResearchProvider,
  acquireRunnerLock,
} from '../lib/provider.js'
import {
  ResearchStoppedError,
  Runner,
} from '../lib/runner.js'
import {
  LayerFSBackend,
  WorkspaceManager,
  createWorkspaceManager,
  inventory,
  layerfsEnvironment,
  resolveLayerfsConfig,
} from '../lib/layerfs-workspace.js'
import { runEvaluatorProcess } from '../lib/evaluator.js'
import { fakeClock, fakeSubagents, setState, withTemp, writeStateEvaluator, writeWorkspace } from './helpers.mjs'

const SANDBOX_PATH = `/workspaces/regression-${process.pid}`

function planFor(root, extra = {}) {
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

async function setupRunner(root, {
  worker,
  options = {},
  extraPlan = {},
  manager = null,
  subagents = null,
  deps = {},
} = {}) {
  const workspace = join(root, 'workspace')
  await writeWorkspace(workspace, { score: 1, metrics: { score: 1 } })
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
      clock: fakeClock(),
      runId: 'run',
      logger: { info() {}, warn() {} },
      ...deps,
    },
  })
  return { runner, subagents: service, manager: workspaceManager, output, workspace, plan }
}

function hostClient(root, actions, { unmount } = {}) {
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
        if (unmount) await unmount(handle, discard)
      },
    },
    async close() {
      actions.push(['close'])
    },
  }
}

function sandboxClient(actions) {
  const client = {
    branch: {
      async fork(name, from) {
        actions.push(['fork', name, from])
      },
    },
    workspace: {
      async mount(name) {
        actions.push(['mount', name])
        return { sandbox: 'sandbox-1', path: SANDBOX_PATH }
      },
      async commit(handle, message) {
        actions.push(['commit', handle.sandbox, message])
      },
      async unmount(handle, discard) {
        actions.push(['unmount', handle.sandbox, discard])
      },
    },
    fs: {
      async apply(branch, changes, message) {
        actions.push([
          'apply',
          branch,
          changes.map(change => ({
            op: change.op,
            path: change.path,
            content: change.content === undefined ? undefined : Buffer.from(change.content).toString('utf8'),
          })),
          message,
        ])
      },
    },
    async close() {
      actions.push(['close'])
    },
  }
  return client
}

async function providerFixture(root, { config = {}, shellEnv = null, plan: planOverride = null } = {}) {
  const cwd = join(root, 'repo')
  await writeWorkspace(cwd, { score: 1, metrics: { score: 1 } })
  await writeStateEvaluator(join(cwd, 'evaluator.mjs'))
  const plan = planOverride ?? planFor(cwd)
  const subagents = fakeSubagents(async spec => {
    await setState(spec.request.cwd, { score: 2, metrics: { score: 2 } })
    return { output: [{ type: 'text', text: 'worker done' }], stopReason: 'completed' }
  })
  const ctx = { subagents, logger: { info() {}, warn() {} } }
  if (shellEnv) ctx.shellEnv = shellEnv
  const provider = new AutoResearchProvider({
    ctx,
    config: {
      workerProvider: 'worker',
      rounds: 1,
      branches: 2,
      explorationMinutes: 0.5,
      exploitationMinutes: 0.5,
      plan,
      ...config,
    },
  })
  return { cwd, provider, subagents, plan }
}


describe('P1-1: explicit config.layerfs:false', () => {
  it('keeps SnapshotBackend and CONFIG.json layerfs:false despite DSH_LAYERFS_*', async () => {
    const keys = ['DSH_LAYERFS_PROJECT', 'DSH_LAYERFS_SDK', 'DSH_LAYERFS_STORE_PATH']
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
    try {
      await withTemp(async root => {
        const sdk = join(root, 'sdk.mjs')
        await writeFile(sdk, `
export class LayerFS {
  constructor() { this.branch = { fork: async () => {} }; this.workspace = { mount: async () => { throw new Error('must not mount') } } }
}
`)
        const { cwd, provider, subagents } = await providerFixture(root, {
          config: { layerfs: false },
          shellEnv: {
            async resolve() {
              return {
                DSH_LAYERFS_PROJECT: 'ambient-project',
                DSH_LAYERFS_SDK: sdk,
                DSH_LAYERFS_STORE_PATH: '/store',
              }
            },
          },
        })
        const handle = await provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal })
        const result = await handle.result
        assert.equal(result.stopReason, 'completed', String(result.diagnostic ?? ''))
        const runs = await readdir(join(cwd, '.auto-research-methods', 'runs'))
        const config = JSON.parse(await readFile(join(cwd, '.auto-research-methods', 'runs', runs[0], 'CONFIG.json'), 'utf8'))
        assert.equal(config.layerfs, false)
        assert.doesNotMatch(subagents.calls[0].request.prompt[0].text, /DSH_LAYERFS_PROJECT/)
        const latest = JSON.parse(await readFile(join(cwd, '.auto-research-methods', 'LATEST.json'), 'utf8'))
        assert.equal(latest.leader_branch, null, 'the snapshot backend has no LayerFS branch')
        await handle.dispose()
      })
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  })

  it('createWorkspaceManager prefers the false opt-out over a bound environment', async () => {
    await withTemp(async root => {
      const manager = await createWorkspaceManager({
        output: join(root, 'out'),
        runId: 'r',
        config: { layerfs: false },
        env: { DSH_LAYERFS_PROJECT: 'p', DSH_LAYERFS_SDK: 'file:///sdk.js' },
      })
      assert.equal(manager.kind, 'snapshot')
    })
  })
})

describe('P1-2: atomic runner lock and runtime containment', () => {
  it('never publishes a partially written lock and cleans its temp sibling', async () => {
    await withTemp(async root => {
      const lock = await acquireRunnerLock(root, 'run-1', { pid: 111 })
      const names = await readdir(root)
      assert.deepEqual(names, ['runner.lock'])
      const saved = JSON.parse(await readFile(join(root, 'runner.lock'), 'utf8'))
      assert.equal(saved.pid, 111)
      assert.equal(saved.runId, 'run-1')
      await lock.release()
      assert.deepEqual(await readdir(root), [])
    })
  })

  it('treats a fresh unparsable lock as live and only reclaims an old one', async () => {
    await withTemp(async root => {
      const path = join(root, 'runner.lock')
      await writeFile(path, '')
      await assert.rejects(
        acquireRunnerLock(root, 'run-2', { pid: 222, alive: () => false, writeGraceMs: 2000 }),
        /starting for this checkout/,
      )
      assert.equal(existsSync(path), true, 'the live-looking lock was not unlinked')
      const old = new Date(Date.now() - 10000)
      await utimes(path, old, old)
      const lock = await acquireRunnerLock(root, 'run-3', { pid: 333, alive: () => false })
      assert.equal(JSON.parse(await readFile(path, 'utf8')).runId, 'run-3')
      await lock.release()
    })
  })

  it('refuses a runtime root symlink that escapes the workspace', async () => {
    await withTemp(async root => {
      const cwd = join(root, 'repo')
      await writeWorkspace(cwd, { score: 1, metrics: { score: 1 } })
      await writeStateEvaluator(join(cwd, 'evaluator.mjs'))
      const outside = join(root, 'outside')
      await mkdir(outside, { recursive: true })
      await symlink(outside, join(cwd, '.auto-research-methods'))
      const { provider } = await providerFixture(root)
      await assert.rejects(
        provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }),
        /runtime root is a symlink escaping the workspace/,
      )
      assert.deepEqual(await readdir(outside), [], 'nothing was written through the symlink')
    })
  })

  it('releases an adopted initial state when Runner construction fails', async () => {
    await withTemp(async root => {
      const actions = []
      const client = hostClient(root, actions)
      const { cwd, provider, plan } = await providerFixture(root, {
        config: { layerfs: { project: 'p', client } },
      })
      const first = await provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal })
      await first.result
      await first.dispose()
      const latest = JSON.parse(await readFile(join(cwd, '.auto-research-methods', 'LATEST.json'), 'utf8'))
      await rm(latest.leader_workspace, { recursive: true, force: true })

      const before = actions.length
      const broken = await providerFixture(root, {
        config: { layerfs: { project: 'p', client } },
        plan: { ...plan, worker_prompt: '' },
      })
      await assert.rejects(
        broken.provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }),
        /Plan requires a worker_prompt/,
      )
      const adopted = actions.slice(before)
      assert.ok(
        adopted.some(action => action[0] === 'unmount' && action[2] === false),
        'the adopted branch was unmounted before the manager closed',
      )
      assert.equal(existsSync(join(cwd, '.auto-research-methods', 'runner.lock')), false)
    })
  })
})

describe('P1-3/P1-8: no branch state leaks on sibling or cohort failure', () => {
  it('records fulfilled siblings when another branch rejects and releases them later', async () => {
    await withTemp(async root => {
      let rejectFirst = null
      let failingReady
      const failingStarted = new Promise(resolve => { failingReady = resolve })
      const subagents = {
        list: () => ['worker'],
        async startActivation(spec) {
          // Branch start order is not guaranteed; identify the sibling by its
          // checkout so the fulfilled one is always round-1-explore-2.
          if (String(spec.request.cwd).includes('round-1-explore-2')) {
            return {
              childId: 'child-1',
              result: Promise.resolve({ output: [], stopReason: 'completed' }),
              dispose: async () => {},
            }
          }
          return {
            childId: 'child-0',
            result: new Promise((_, rejectPromise) => {
              rejectFirst = rejectPromise
              failingReady()
            }),
            dispose: async () => {},
          }
        },
      }
      const released = []
      const { runner, manager } = await setupRunner(root, {
        subagents,
        options: { forkAndFlush: true },
      })
      let siblingEvaluatedResolve
      const siblingEvaluated = new Promise(resolve => { siblingEvaluatedResolve = resolve })
      const evaluate = runner.evaluator.evaluate.bind(runner.evaluator)
      runner.evaluator.evaluate = async (workspace, folder, options) => {
        const value = await evaluate(workspace, folder, options)
        if (folder.endsWith('round-1-explore-2')) siblingEvaluatedResolve()
        return value
      }
      const release = manager.release.bind(manager)
      manager.release = async (state, options) => {
        released.push(state)
        return release(state, options)
      }
      const running = runner.run()
      await siblingEvaluated
      await failingStarted
      rejectFirst(new Error('worker exploded'))
      await assert.rejects(running, /worker exploded/)
      const sibling = runner.abandoned.find(row => row.id === 'round-1-explore-2')
      const siblingState = sibling?._state
      assert.ok(siblingState, 'the fulfilled sibling is recorded with its state')
      assert.ok(runner.pendingWorkspaces().some(entry => entry.workspace.includes('round-1-explore-2')))
      await runner.releaseAll()
      assert.ok(released.includes(siblingState), 'releaseAll released the fulfilled sibling state')
      assert.equal(runner.pendingWorkspaces().length, 0)
    })
  })

  it('releases every cohort state when retainCompletedState throws', async () => {
    await withTemp(async root => {
      const worker = async (spec, index) => {
        await setState(spec.request.cwd, { score: 2 + index, metrics: { score: 2 + index } })
        await writeFile(join(spec.request.cwd, 'SHARED_CHECKPOINT.json'), JSON.stringify({
          summary: `verified ${index}`,
          files: ['state.json'],
        }, null, 2))
        return { output: [], stopReason: 'completed' }
      }
      const { runner, manager } = await setupRunner(root, {
        worker,
        options: {
          shareContext: true,
          forkAndFlush: true,
          explorationMinutes: 0.1,
          sharingIntervalMinutes: 0.02,
        },
        extraPlan: { evaluation_seconds: 0.5 },
      })
      manager.retainCompletedState = async () => { throw new Error('retain exploded') }
      const released = []
      const release = manager.release.bind(manager)
      manager.release = async (state, options) => {
        released.push(state)
        return release(state, options)
      }
      await assert.rejects(runner.run(), /retain exploded/)
      const tracked = runner.trackedStates.size
      assert.ok(tracked >= 3, `the baseline and both epoch branches were tracked: ${tracked}`)
      await runner.releaseAll()
      assert.equal(new Set(released).size, tracked, 'releaseAll released every tracked state')
      assert.equal(runner.pendingWorkspaces().length, 0)
    })
  })
})

describe('P1-4: bounded worker termination', () => {
  it('disposes an activation that ignores abort and stops waiting after the grace', async () => {
    await withTemp(async root => {
      let started
      const startedPromise = new Promise(resolve => { started = resolve })
      let disposed = 0
      const subagents = {
        list: () => ['worker'],
        async startActivation() {
          started()
          return {
            childId: 'child',
            result: new Promise(() => {}),
            dispose: async () => { disposed += 1 },
          }
        },
      }
      const controller = new AbortController()
      const { runner } = await setupRunner(root, {
        subagents,
        deps: { signal: controller.signal, workerGraceMs: 30 },
      })
      const running = runner.run()
      await startedPromise
      const begun = Date.now()
      controller.abort()
      await assert.rejects(running, error => error instanceof ResearchStoppedError)
      assert.equal(disposed, 1)
      assert.ok(Date.now() - begun < 1000, 'the grace timer bounded the wait')
    })
  })
})

describe('P1-5: evaluator abort escalation', () => {
  it('SIGKILLs an evaluator process that ignores SIGTERM', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX signal semantics')
    await withTemp(async root => {
      const controller = new AbortController()
      const script = "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"
      const begun = Date.now()
      const running = runEvaluatorProcess({
        argv: [process.execPath, '-e', script],
        cwd: root,
        env: process.env,
        timeoutMs: 60000,
        signal: controller.signal,
        stdoutPath: join(root, 'stdout.log'),
        stderrPath: join(root, 'stderr.log'),
      })
      setTimeout(() => controller.abort(), 100)
      const result = await running
      const elapsed = Date.now() - begun
      assert.equal(result.aborted, true)
      assert.equal(result.code, null)
      assert.ok(elapsed >= 1900, `waited for the SIGKILL escalation: ${elapsed}ms`)
      assert.ok(elapsed < 5000, `bounded termination: ${elapsed}ms`)
    })
  })
})

describe('P1-6: a failed release keeps the state retryable', () => {
  it('retains the row handle until releaseAll succeeds and only then closes', async () => {
    await withTemp(async root => {
      const worker = async (spec, index) => {
        await setState(spec.request.cwd, { score: 2 + index, metrics: { score: 2 + index } })
        return { output: [], stopReason: 'completed' }
      }
      const { runner, manager } = await setupRunner(root, {
        worker,
        options: { forkAndFlush: true },
      })
      let releaseCalls = 0
      let closes = 0
      const release = manager.release.bind(manager)
      manager.release = async (state, options) => {
        releaseCalls += 1
        if (releaseCalls === 1) throw new Error('release unavailable')
        return release(state, options)
      }
      manager.close = async () => { closes += 1 }
      await runner.run()
      const failed = runner.rows.find(row => row.id === 'round-1-explore-1')
      assert.ok(failed?._state, 'the handle is retained after the failed release')
      assert.notEqual(failed._released, true)
      assert.ok(runner.pendingWorkspaces().some(entry => entry.workspace.includes('round-1-explore-1')))
      assert.equal(closes, 0, 'the manager stays open while a state is mounted')
      await runner.releaseAll()
      assert.equal(failed._state, null)
      assert.equal(failed._released, true)
      assert.equal(runner.pendingWorkspaces().length, 0)
      assert.equal(closes, 1)
    })
  })
})

describe('P1-7: LayerFS post-mount cleanup and staging forks', () => {
  it('unmounts with discard and removes staging when baseline publishing fails', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const client = sandboxClient(actions)
      client.fs.apply = async () => { throw new Error('apply exploded') }
      const backend = new LayerFSBackend({ client, output: join(root, 'out'), runId: 'run-1', retryBaseDelayMs: 1 })
      await assert.rejects(backend.baseline(source, 'initial'), /apply exploded/)
      assert.ok(actions.some(action => action[0] === 'unmount' && action[2] === true))
      assert.equal(existsSync(join(root, 'out', 'initial', 'workspace')), false)
    })
  })

  it('unmounts with discard and removes staging when adopt materialization fails', async () => {
    await withTemp(async root => {
      const actions = []
      const client = sandboxClient(actions)
      client.fs.read = async () => ({ text: '' })
      client.fs.list = async () => { throw new Error('list exploded') }
      const backend = new LayerFSBackend({ client, output: join(root, 'out'), runId: 'run-2', retryBaseDelayMs: 1 })
      await assert.rejects(backend.adopt('ar-run-1-leader', 'initial'), /list exploded/)
      assert.ok(actions.some(action => action[0] === 'unmount' && action[2] === true))
      assert.equal(existsSync(join(root, 'out', 'initial', 'workspace')), false)
    })
  })

  it('publishes a staged parent before forking a cooperative child branch', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const backend = new LayerFSBackend({
        client: sandboxClient(actions),
        output: join(root, 'out'),
        runId: 'run-3',
        retryBaseDelayMs: 1,
      })
      const parent = await backend.baseline(source, 'initial')
      await writeFile(join(parent.path, 'uncommitted.txt'), 'epoch work\n')
      actions.length = 0
      const child = await backend.fork(parent, 'child')
      const applyIndex = actions.findIndex(action => action[0] === 'apply' && action[1] === parent.branch)
      const forkIndex = actions.findIndex(action => action[0] === 'fork')
      assert.ok(applyIndex >= 0, 'the staged parent was published')
      assert.ok(forkIndex > applyIndex, 'the child branch was forked after the publish')
      const published = actions[applyIndex][2].map(change => change.path)
      assert.ok(published.includes('/uncommitted.txt'))
      assert.equal(child.staging, true)
    })
  })
})

describe('P1-9: explicit LayerFS fields and precedence', () => {
  it('supports every deployment field and lets config win over ambient env', () => {
    const fields = {
      project: 'explicit-project',
      sdk: '/explicit/sdk.js',
      docker: '/explicit/docker.sock',
      image: 'explicit-image',
      volume: 'explicit-volume',
      daemon: '/explicit/daemon',
      containerPrefix: 'explicit-prefix-',
      daemonHost: 'explicit-host',
      storeContainer: 'explicit-store',
      bundle: '/explicit/bundle',
      wslEndpoint: '/explicit/endpoint',
      traceStart: '1',
    }
    const ambient = {
      DSH_LAYERFS_PROJECT: 'env-project',
      DSH_LAYERFS_SDK: '/env/sdk.js',
      DSH_LAYERFS_DOCKER: '/env/docker.sock',
      DSH_LAYERFS_IMAGE: 'env-image',
      DSH_LAYERFS_VOLUME: 'env-volume',
      DSH_LAYERFS_DAEMON: '/env/daemon',
      DSH_LAYERFS_CONTAINER_PREFIX: 'env-prefix-',
      DSH_LAYERFS_DAEMON_HOST: 'env-host',
      DSH_LAYERFS_STORE_CONTAINER: 'env-store',
      DSH_LAYERFS_BUNDLE: '/env/bundle',
      DSH_LAYERFS_WSL_ENDPOINT: '/env/endpoint',
      DSH_LAYERFS_TRACE_START: '0',
    }
    const settings = resolveLayerfsConfig(ambient, fields)
    for (const [key, value] of Object.entries(fields)) assert.equal(settings[key], value, key)
    const environment = layerfsEnvironment(ambient, settings)
    assert.equal(environment.DSH_LAYERFS_DOCKER, '/explicit/docker.sock')
    assert.equal(environment.DSH_LAYERFS_IMAGE, 'explicit-image')
    assert.equal(environment.DSH_LAYERFS_STORE_CONTAINER, 'explicit-store')
    assert.equal(environment.DSH_LAYERFS_BUNDLE, '/explicit/bundle')
    assert.equal(environment.DSH_LAYERFS_WSL_ENDPOINT, '/explicit/endpoint')
    assert.equal(environment.DSH_LAYERFS_TRACE_START, '1')
    const cleared = layerfsEnvironment(ambient, settings, { image: null })
    assert.equal('DSH_LAYERFS_IMAGE' in cleared, false, 'explicit null suppresses an ambient value')
  })
})

describe('P2-1: an empty peer epoch still writes collaboration state', () => {
  it('returns null from publishPeers and records the epoch', async () => {
    await withTemp(async root => {
      const worker = async (spec, index) => {
        await setState(spec.request.cwd, { score: 2 + index, metrics: { score: 2 + index } })
        return { output: [], stopReason: 'completed' }
      }
      const { runner, output } = await setupRunner(root, {
        worker,
        options: {
          shareContext: true,
          forkAndFlush: true,
          explorationMinutes: 0.1,
          sharingIntervalMinutes: 0.02,
        },
        extraPlan: { evaluation_seconds: 0.5 },
      })
      assert.equal(await runner.publishPeers([], join(root, 'empty-peers')), null)
      await assert.rejects(runner.run(), /Peer checkpoint\/review protocol failed/)
      const collaboration = JSON.parse(await readFile(join(output, 'round-1-explore-COLLABORATION.json'), 'utf8'))
      assert.equal(collaboration.epochs.length, 1)
      assert.equal(collaboration.epochs[0].peer_bundle, null)
      assert.equal(collaboration.epochs[0].shared_context, null)
    })
  })
})
