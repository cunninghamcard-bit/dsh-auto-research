/**
 * Regression coverage for the post-E2E review fixes.
 *
 * Each block names the finding it locks down so a future refactor that
 * reintroduces the leak or race fails here first.
 */
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AutoResearchProvider,
  WorkerEnvRegistry,
  acquireRunnerLock,
  declaredWorkerEnvKeys,
  isInsideRuntimeRuns,
  resolveConfig,
  sessionIdOf,
} from '../lib/provider.js'
import {
  DEFAULT_CLOCK,
  ResearchStoppedError,
  Runner,
  validatePlan,
} from '../lib/runner.js'
import {
  LayerFSBackend,
  createWorkspaceManager,
  inventory,
  jsonDigest,
  layerfsEnvironment,
  loadLayerfs,
  resolveLayerfsConfig,
  resolveShellEnvironment,
  restoreCompletedState,
  retainCompletedState,
  withBusyRetry,
  isTransientLayerfsError,
  withoutLayerfsTrace,
  writeJsonAtomic,
} from '../lib/layerfs-workspace.js'
import { runEvaluatorProcess, scoreValue } from '../lib/evaluator.js'
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
      const readyFile = join(root, 'ready')
      const script = `import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync(${JSON.stringify(readyFile)}, '1'); setInterval(() => {}, 1000)`
      const running = runEvaluatorProcess({
        argv: [process.execPath, '--input-type=module', '-e', script],
        cwd: root,
        env: process.env,
        timeoutMs: 60000,
        signal: controller.signal,
        stdoutPath: join(root, 'stdout.log'),
        stderrPath: join(root, 'stderr.log'),
      })
      while (!existsSync(readyFile)) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 15))
      }
      const begun = Date.now()
      controller.abort()
      const result = await running
      const elapsed = Date.now() - begun
      assert.equal(result.aborted, true)
      assert.equal(result.code, null)
      assert.ok(elapsed >= 1800, `waited for the SIGKILL escalation: ${elapsed}ms`)
      assert.ok(elapsed < 6000, `bounded termination: ${elapsed}ms`)
    })
  })
})

describe('P1-6: a failed release keeps the state retryable', () => {
  it('retains the row handle until releaseAll succeeds and only then closes', async () => {
    await withTemp(async root => {
      // Deterministic per branch: activation order is not guaranteed, so the
      // score comes from the checkout, making round-1-explore-2 the leader and
      // round-1-explore-1 the first (failing) release.
      const worker = async spec => {
        const score = String(spec.request.cwd).includes('explore-1') ? 2 : 3
        await setState(spec.request.cwd, { score, metrics: { score } })
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

/* ------------------------------------------------------------------------- *
 * Repair round: one block per item of the complete repair specification.
 * ------------------------------------------------------------------------- */

function digestText(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * The artifacts a cooperative epoch's worker must leave: the evaluated state,
 * a shared checkpoint, and — from the second epoch on — a peer review of the
 * snapshot this branch actually received.
 */
async function writeCooperationArtifacts(cwd, score) {
  await setState(cwd, { score, metrics: { score } })
  await writeFile(join(cwd, 'SHARED_CHECKPOINT.json'), JSON.stringify({
    summary: `verified ${score}`,
    files: ['state.json'],
  }, null, 2) + '\n')
  const dir = join(cwd, 'SHARED_CONTEXT')
  if (!existsSync(dir)) return
  // A resumed branch keeps every earlier epoch's snapshot in the same folder;
  // the most recently published one belongs to this epoch.
  const entries = await Promise.all((await readdir(dir))
    .filter(name => name.startsWith('peer-evidence-'))
    .map(async name => ({ name, at: (await stat(join(dir, name))).mtimeMs })))
  const newest = entries.sort((left, right) => right.at - left.at)[0]
  if (!newest) return
  const text = await readFile(join(dir, newest.name), 'utf8')
  const bundle = JSON.parse(text)
  await writeFile(join(cwd, 'PEER-REVIEW.json'), JSON.stringify({
    manifest_sha256: digestText(text),
    reviews: (bundle.peers ?? []).map(peer => ({
      peer_id: peer.id,
      finding: 'peer evidence observed',
      action: 'independent check',
    })),
  }, null, 2) + '\n')
}

/** A client whose Sandbox mount is only visible inside its Sandbox. */
function sandboxClientWith(actions, overrides = {}) {
  const client = sandboxClient(actions)
  Object.assign(client.fs, overrides.fs ?? {})
  Object.assign(client.workspace, overrides.workspace ?? {})
  return client
}

describe('R1/R4: repository hygiene', () => {
  it('derives every E2E path from the repository or the home directory', async () => {
    const support = await import('./e2e-support.mjs')
    const testsDir = dirname(fileURLToPath(import.meta.url))
    assert.equal(
      support.DSH_ROOT,
      process.env.DSH_HARNESS_ROOT ?? resolve(testsDir, '../../deepseek-harness'),
    )
    assert.equal(
      support.LAYERFS_ROOT,
      process.env.LAYERFS_ROOT ?? resolve(testsDir, '../../layerfs'),
    )
    assert.ok(support.LAYERFS_BUNDLE.startsWith(process.env.LAYERFS_BUNDLE ? '' : homedir()))
    assert.ok(
      support.LAYERFS_DOCKER.startsWith(homedir()) || support.LAYERFS_DOCKER === '/var/run/docker.sock',
      support.LAYERFS_DOCKER,
    )
    assert.ok(support.DSH_HOME.startsWith(process.env.DSH_HOME ? '' : homedir()), support.DSH_HOME)
  })

  it('reports Live as unavailable when the socket exists but no daemon answers', async () => {
    await withTemp(async root => {
      const socket = join(root, 'docker.sock')
      const bundle = join(root, 'bundle')
      await writeFile(socket, '')
      await mkdir(bundle, { recursive: true })
      await writeFile(join(bundle, 'layerfs-daemon'), '#!/bin/sh\n')
      const saved = {
        LAYERFS_DOCKER: process.env.LAYERFS_DOCKER,
        LAYERFS_BUNDLE: process.env.LAYERFS_BUNDLE,
      }
      process.env.LAYERFS_DOCKER = socket
      process.env.LAYERFS_BUNDLE = bundle
      try {
        const fresh = await import(`./e2e-support.mjs?probe=${process.pid}-${Date.now()}`)
        assert.equal(fresh.LAYERFS_DOCKER, socket)
        assert.equal(fresh.LAYERFS_BUNDLE, bundle)
        // The bundle and daemon files exist, so a file-existence probe would
        // claim Live is available; the daemon must answer `docker version`.
        assert.equal(fresh.liveLayerfsAvailable(), false)
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    })
  })
})

describe('R5: worker shell environment injection', () => {
  it('declares only the DSH_* keys this plugin may own', () => {
    const keys = declaredWorkerEnvKeys({
      DSH_MY_FLAG: '1',
      DSH_LAYERFS_PROJECT: 'p',
      'not-dsh': 'x',
      dsh_lower: 'x',
    })
    for (const owned of [
      'DSH_AUTO_RESEARCH_WORKER',
      'DSH_AUTO_RESEARCH_BRANCH',
      'DSH_AUTO_RESEARCH_CHECKOUT',
      'DSH_AUTO_RESEARCH_SANDBOX_PATH',
      'DSH_MY_FLAG',
    ]) {
      assert.equal(Object.hasOwn(keys, owned), true, owned)
    }
    // `@dsh-layerfs/host` owns DSH_LAYERFS_* and a registry rejects a second
    // owner, so it must never be declared here.
    assert.equal(Object.hasOwn(keys, 'DSH_LAYERFS_PROJECT'), false)
    assert.equal(Object.hasOwn(keys, 'not-dsh'), false)
    assert.equal(Object.hasOwn(keys, 'dsh_lower'), false)
  })

  it('resolves a branch environment only for the worker that owns the checkout', () => {
    const registry = new WorkerEnvRegistry()
    const entry = registry.register({
      id: 'branch-1',
      checkout: '/tmp/ar/branch-1/workspace',
      parentSessionId: 'parent-1',
      env: {
        DSH_AUTO_RESEARCH_CHECKOUT: '/tmp/ar/branch-1/workspace',
        DSH_AUTO_RESEARCH_BRANCH: 'ar-run-1-branch-1',
        DSH_MY_FLAG: 'yes',
      },
    })
    assert.deepEqual(registry.resolve({
      agent: { session: { header: { id: 'child-9', cwd: '/tmp/ar/branch-1/workspace' } } },
    }), {
      DSH_AUTO_RESEARCH_WORKER: '1',
      DSH_AUTO_RESEARCH_CHECKOUT: '/tmp/ar/branch-1/workspace',
      DSH_AUTO_RESEARCH_BRANCH: 'ar-run-1-branch-1',
      DSH_MY_FLAG: 'yes',
    })
    // The child id reported by the provider is bound after activation starts.
    entry.setChildSession('child-9')
    assert.equal(
      registry.resolve({ agent: { session: { header: { id: 'child-9' } } } }).DSH_AUTO_RESEARCH_WORKER,
      '1',
    )
    // A nested path inside the checkout still belongs to the branch worker.
    assert.equal(
      registry.resolve({
        agent: { session: { header: { id: 'x', cwd: '/tmp/ar/branch-1/workspace/src' } } },
      }).DSH_AUTO_RESEARCH_WORKER,
      '1',
    )
    // The coordinator working at the parent checkout gets nothing.
    assert.deepEqual(registry.resolve({ agent: { session: { header: { id: 'parent-1', cwd: '/tmp/ar' } } } }), {})
    assert.deepEqual(registry.resolve(null), {})
    entry.dispose()
    assert.equal(registry.size, 0)
    assert.deepEqual(registry.resolve({
      agent: { session: { header: { id: 'child-9', cwd: '/tmp/ar/branch-1/workspace' } } },
    }), {})
  })

  it('filters undeclared keys out of the contributor result', () => {
    const provider = new AutoResearchProvider({
      ctx: {
        subagents: fakeSubagents(async () => ({ output: [], stopReason: 'completed' })),
        logger: {},
      },
      config: { workerProvider: 'worker' },
    })
    const contributor = provider.workerEnvContributor()
    assert.equal(contributor.name, 'auto-research')
    provider.workerEnvs.register({
      id: 'b',
      checkout: '/tmp/ar/b',
      env: {
        DSH_AUTO_RESEARCH_CHECKOUT: '/tmp/ar/b',
        DSH_LAYERFS_TRACE: '/tmp/trace.jsonl',
        SOMETHING: 'else',
      },
    })
    const resolved = contributor.resolve({
      agent: { session: { header: { id: 'child', cwd: '/tmp/ar/b' } } },
    })
    assert.deepEqual(resolved, {
      DSH_AUTO_RESEARCH_WORKER: '1',
      DSH_AUTO_RESEARCH_CHECKOUT: '/tmp/ar/b',
    })
    for (const key of Object.keys(resolved)) {
      assert.equal(Object.hasOwn(contributor.variables, key), true, `${key} must be declared`)
    }
  })

  it('registers its contributor on the real ctx.shellEnv service shape', () => {
    let registered = null
    let disposedWith = null
    const provider = new AutoResearchProvider({
      ctx: {
        subagents: fakeSubagents(async () => ({ output: [], stopReason: 'completed' })),
        logger: {},
        shellEnv: {
          register(contributor) {
            registered = contributor
            return () => { disposedWith = contributor }
          },
        },
      },
      config: { workerProvider: 'worker' },
    })
    assert.ok(registered, 'the constructor registers the contributor')
    assert.equal(registered.name, 'auto-research')
    assert.equal(typeof registered.resolve, 'function')
    provider.dispose()
    assert.equal(disposedWith, registered)
  })

  it('hands a live branch environment to the worker bash call during a batch', async () => {
    await withTemp(async root => {
      const cwd = join(root, 'repo')
      await writeWorkspace(cwd, { score: 1, metrics: { score: 1 } })
      await writeStateEvaluator(join(cwd, 'evaluator.mjs'))
      const plan = planFor(cwd)
      let contributor = null
      const workerEnvs = []
      const coordinatorEnvs = []
      const subagents = fakeSubagents(async spec => {
        const header = { id: 'child-1', cwd: spec.request.cwd, origin: 'subagent' }
        workerEnvs.push(contributor.resolve({ agent: { session: { header } }, callId: 'bash-1', rootCallId: 'bash-1' }))
        coordinatorEnvs.push(contributor.resolve({
          agent: { session: { header: { id: 'parent-1', cwd } } },
          callId: 'bash-2',
          rootCallId: 'bash-2',
        }))
        await setState(spec.request.cwd, { score: 2, metrics: { score: 2 } })
        return { output: [], stopReason: 'completed' }
      })
      const provider = new AutoResearchProvider({
        ctx: {
          subagents,
          logger: { info() {}, warn() {} },
          shellEnv: { register(value) { contributor = value; return () => {} } },
        },
        config: {
          workerProvider: 'worker',
          branches: 2,
          explorationMinutes: 0.5,
          exploitationMinutes: 0.5,
          plan,
        },
      })
      const handle = await provider.start({
        cwd,
        prompt: [],
        parent: { id: 'p', session: { header: { id: 'parent-1' } } },
        signal: new AbortController().signal,
      })
      const result = await handle.result
      assert.equal(result.stopReason, 'completed', String(result.diagnostic ?? ''))
      assert.ok(workerEnvs.length >= 1)
      for (const env of workerEnvs) {
        assert.equal(env.DSH_AUTO_RESEARCH_WORKER, '1')
        assert.ok(String(env.DSH_AUTO_RESEARCH_CHECKOUT).includes('.auto-research-methods'), env.DSH_AUTO_RESEARCH_CHECKOUT)
      }
      for (const env of coordinatorEnvs) assert.equal(env.DSH_AUTO_RESEARCH_WORKER, undefined)
      assert.equal(provider.workerEnvs.size, 0, 'the registration is removed when the activation ends')
      await handle.dispose()
    })
  })
})

describe('R6: ShellEnvRegistry.collect contract and trace hygiene', () => {
  it('passes a complete tool execution to collect()', async () => {
    const seen = []
    const merged = await resolveShellEnvironment({
      shellEnv: {
        collect(execution) {
          seen.push(execution)
          return {
            DSH_LAYERFS_TRACE_STEP: String(execution.rootCallId ?? execution.callId),
            DSH_LAYERFS_PROJECT: 'p',
          }
        },
      },
    }, { session: { header: { id: 'parent-1' } } })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].callId, 'auto-research-env')
    assert.equal(seen[0].rootCallId, 'auto-research-env')
    assert.equal(merged.DSH_LAYERFS_TRACE_STEP, 'auto-research-env')
    assert.notEqual(merged.DSH_LAYERFS_TRACE_STEP, 'undefined')
  })

  it('still merges resolve(), snapshot(), env and contributors', async () => {
    const service = {
      env: { A: '1' },
      async resolve(execution) { return { B: execution.callId === 'auto-research-env' ? '2' : 'wrong' } },
      snapshot() { return { C: '3' } },
      contributors: [{ env: { D: '4' } }],
    }
    assert.deepEqual(await resolveShellEnvironment({ shellEnv: service }), { A: '1', B: '2', C: '3', D: '4' })
  })

  it('strips transient SDK trace keys from a copied session environment', () => {
    const environment = layerfsEnvironment({
      DSH_LAYERFS_PROJECT: 'p',
      DSH_LAYERFS_SDK: '/sdk.js',
      DSH_LAYERFS_TRACE: '/trace.jsonl',
      DSH_LAYERFS_TRACE_STEP: 'parent-step',
      DSH_LAYERFS_TRACE_START: '1',
    })
    assert.equal(environment.DSH_LAYERFS_TRACE_STEP, 'parent-step', 'the raw copy keeps what the SDK needs')
    const stripped = withoutLayerfsTrace(environment)
    for (const key of ['DSH_LAYERFS_TRACE', 'DSH_LAYERFS_TRACE_STEP', 'DSH_LAYERFS_TRACE_START']) {
      assert.equal(Object.hasOwn(stripped, key), false, key)
    }
    assert.equal(stripped.DSH_LAYERFS_PROJECT, 'p')
  })

  it('never forwards the parent trace step into a worker launch', async () => {
    const keys = ['DSH_LAYERFS_TRACE', 'DSH_LAYERFS_TRACE_STEP', 'DSH_LAYERFS_TRACE_START']
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
    try {
      await withTemp(async root => {
        const { provider, cwd } = await providerFixture(root, {
          shellEnv: {
            async resolve() {
              return {
                DSH_LAYERFS_TRACE: '/tmp/parent-trace.jsonl',
                DSH_LAYERFS_TRACE_STEP: 'parent-step',
                DSH_LAYERFS_TRACE_START: '1',
              }
            },
          },
        })
        const handle = await provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal })
        await handle.result
        const runs = await readdir(join(cwd, '.auto-research-methods', 'runs'))
        const launch = JSON.parse(await readFile(
          join(cwd, '.auto-research-methods', 'runs', runs[0], 'round-1-continue-1', 'LAUNCH.json'),
          'utf8',
        ))
        for (const key of keys) assert.equal(launch.environment.includes(key), false, key)
        await handle.dispose()
      })
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  })
})

describe('R7: multi-epoch cooperative cohorts keep every epoch and its ownership', () => {
  it('records both epochs once and transfers the resumed branch ownership', async () => {
    await withTemp(async root => {
      const worker = async spec => {
        await writeCooperationArtifacts(spec.request.cwd, 2)
        return { output: [], stopReason: 'completed' }
      }
      const { runner, manager, output } = await setupRunner(root, {
        worker,
        options: {
          shareContext: true,
          forkAndFlush: true,
          // 5 s explore budget shared in 2.5 s epochs with a 1 s evaluation
          // reserve: with the fake clock exactly two epochs run.
          explorationMinutes: 5 / 60,
          sharingIntervalMinutes: 2.5 / 60,
          exploitationMinutes: 0.001,
        },
        extraPlan: { evaluation_seconds: 1 },
      })
      const commits = []
      const releases = []
      const commit = manager.commit.bind(manager)
      const release = manager.release.bind(manager)
      manager.commit = async (state, options) => { commits.push(options?.message ?? ''); return commit(state, options) }
      manager.release = async (state, options) => { releases.push(state); return release(state, options) }

      const result = await runner.run()
      assert.equal(result.status, 'COMPLETED')

      const explore = runner.rows.filter(row => row.id.startsWith('round-1-explore'))
      const epoch1 = explore.filter(row => row.id.includes('epoch-1'))
      const epoch2 = explore.filter(row => row.id.includes('epoch-2'))
      assert.equal(epoch1.length, 2, 'epoch 1 trajectories are kept')
      assert.equal(epoch2.length, 2, 'epoch 2 trajectories are kept')
      assert.equal(runner.rows.length, 5, 'initial + 2 + 2, with no duplicates')
      assert.equal(new Set(runner.rows.map(row => row.id)).size, runner.rows.length)
      const dashboard = JSON.parse(await readFile(join(output, 'DASHBOARD.json'), 'utf8'))
      assert.equal(dashboard.trajectories.length, 5)
      assert.equal(new Set(dashboard.trajectories.map(row => row.id)).size, 5)

      // Epoch 0 owns the forked state; epoch 1 resumes that same state. Only the
      // returned rows may own it so `recycle` can commit/unmount them.
      assert.ok(epoch1.every(row => row._ownsState === false), 'earlier-epoch parents no longer own the state')
      assert.ok(epoch2.every(row => row._state === null || row._ownsState === true))
      const leader = runner.rows.find(row => row.id === result.leader.id)
      assert.ok(leader?._state, 'the final leader stays mounted')
      assert.ok(commits.some(message => /^auto-research: verified /.test(message)), 'the leader was committed')
      assert.ok(releases.length >= 2, 'the baseline and the defeated branch were released')
      assert.equal(new Set(releases).size, releases.length, 'no state is released twice')
    })
  })
})

describe('R8: the runner lock precedes every artifact write', () => {
  it('rejects a concurrent batch without creating a run directory or rewriting SEED.json', async () => {
    await withTemp(async root => {
      const cwd = join(root, 'repo')
      const seed = join(cwd, 'SEED')
      await writeWorkspace(cwd, { score: 1, metrics: { score: 1 } })
      await writeWorkspace(seed, { score: 1, metrics: { score: 1 } })
      await writeStateEvaluator(join(seed, 'evaluator.mjs'))
      await mkdir(join(cwd, '.auto-research-methods'), { recursive: true })
      const gate = Promise.withResolvers()
      const subagents = fakeSubagents(async spec => {
        await gate.promise
        await setState(spec.request.cwd, { score: 2, metrics: { score: 2 } })
        return { output: [], stopReason: 'completed' }
      })
      const provider = new AutoResearchProvider({
        ctx: { subagents, logger: { info() {}, warn() {} } },
        config: {
          workerProvider: 'worker',
          branches: 2,
          explorationMinutes: 0.5,
          exploitationMinutes: 0.5,
          plan: planFor(seed, { workspace: 'SEED' }),
        },
      })
      const parent = { id: 'p' }
      const first = await provider.start({ cwd, prompt: [], parent, signal: new AbortController().signal })
      const runtime = join(seed, '.auto-research-methods')
      const seedPointer = join(cwd, '.auto-research-methods', 'SEED.json')
      const before = await readFile(seedPointer, 'utf8')
      const runsBefore = await readdir(join(runtime, 'runs'))
      await assert.rejects(
        provider.start({ cwd, prompt: [], parent, signal: new AbortController().signal }),
        /already (running|starting)/,
      )
      assert.deepEqual(await readdir(join(runtime, 'runs')), runsBefore, 'no orphan run directory was created')
      assert.equal(await readFile(seedPointer, 'utf8'), before, 'SEED.json was not rewritten')
      gate.resolve()
      await first.result
      await first.dispose()
      assert.equal(existsSync(join(runtime, 'runner.lock')), false)
    })
  })
})

describe('R9: recursive delegation is refused', () => {
  it('rejects a call whose parent is already a subagent', async () => {
    await withTemp(async root => {
      const { cwd, provider } = await providerFixture(root)
      await assert.rejects(
        provider.start({
          cwd,
          prompt: [],
          parent: { id: 'p', session: { header: { id: 'child', origin: 'subagent' } } },
          signal: new AbortController().signal,
        }),
        /cannot be called recursively by a worker subagent/,
      )
    })
  })

  it('rejects a call from inside a live worker checkout or a runs/ tree', async () => {
    await withTemp(async root => {
      const { cwd, provider } = await providerFixture(root)
      const registration = provider.workerEnvs.register({ id: 'w', checkout: cwd, env: {} })
      await assert.rejects(
        provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }),
        /cannot be called recursively by a worker subagent/,
      )
      registration.dispose()
      const runtime = join(cwd, '.auto-research-methods', 'runs', 'abc', 'round-1', 'workspace')
      await assert.rejects(
        provider.start({ cwd: runtime, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }),
        /cannot be called recursively by a worker subagent/,
      )
      assert.equal(isInsideRuntimeRuns(runtime), true)
      assert.equal(isInsideRuntimeRuns(cwd), false)
    })
  })

  it('tells branch workers not to delegate or edit the plan', async () => {
    const { DSH_COORDINATOR_ADDENDUM, buildWorkerPrompt } = await import('../lib/policies.js')
    assert.match(DSH_COORDINATOR_ADDENDUM, /DSH_AUTO_RESEARCH_WORKER=1/)
    assert.match(DSH_COORDINATOR_ADDENDUM, /never call `subagent_auto_research`/)
    assert.match(DSH_COORDINATOR_ADDENDUM, /\.auto-research-methods\/plan\.json/)
    const prompt = buildWorkerPrompt({
      plan: { worker_prompt: 'Do work.', objective: 'o' },
      checkout: '/tmp/ar/branch-1',
      phase: 'continue',
    })
    assert.match(prompt, /Work only in this branch: \/tmp\/ar\/branch-1/)
    assert.match(prompt, /You are a branch worker/)
    assert.match(prompt, /Never call subagent_auto_research/)
    assert.match(prompt, /never modify \.auto-research-methods\/plan\.json/)
  })
})

describe('R10: transient LayerFS startup failures and stale mounts', () => {
  it('retries connection refusals with the default six-attempt budget', async () => {
    for (const error of [
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7070'), { code: 'ECONNREFUSED' }),
      new Error('Connection refused'),
      new Error('socket hang up'),
      new Error('failed to connect to daemon'),
      new Error('the Store container layerfs-store worker did not answer'),
      new Error('the Store container layerfs-store has not started'),
    ]) {
      assert.equal(isTransientLayerfsError(error), true, String(error.message))
    }
    assert.equal(
      isTransientLayerfsError(Object.assign(new Error('wrapped'), { cause: new Error('socket hang up') })),
      true,
    )
    assert.equal(isTransientLayerfsError(new Error('InvalidInput')), false)
    let attempts = 0
    await assert.rejects(withBusyRetry(async () => {
      attempts += 1
      throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }, { baseDelayMs: 0, delay: async () => {} }), /ECONNREFUSED/)
    assert.equal(attempts, 7, 'one attempt plus the six default retries')
    let recovered = 0
    assert.equal(await withBusyRetry(async () => {
      recovered += 1
      if (recovered < 3) throw new Error('the Store container store worker did not answer')
      return 'installed'
    }, { baseDelayMs: 0, delay: async () => {} }), 'installed')
  })

  it('tolerates a stale mount commit after fs.apply published the bytes', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const client = sandboxClientWith(actions, {
        workspace: {
          async commit(handle, message) {
            actions.push(['commit', message])
            throw Object.assign(new Error('branch head moved since mount'), { code: 'headMovedSinceMount' })
          },
        },
      })
      const backend = new LayerFSBackend({ client, output: join(root, 'out'), runId: 'run-r10', retryBaseDelayMs: 1 })
      const state = await backend.baseline(source, 'initial')
      assert.equal(state.staging, true)
      await writeFile(join(state.path, 'extra.txt'), 'new\n')
      await backend.commit(state, { message: 'auto-research: verified initial' })
      assert.ok(actions.some(action => action[0] === 'apply'), 'the bytes were published through fs.apply')
      assert.ok(actions.some(action => action[0] === 'commit'), 'the mount commit was still attempted')
      await backend.release(state)
    })
  })

  it('falls back to a discarding unmount for a stale staged overlay', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const client = sandboxClientWith(actions, {
        workspace: {
          async unmount(handle, discard) {
            actions.push(['unmount', discard])
            if (!discard) throw Object.assign(new Error('head moved since mount'), { code: 'headMovedSinceMount' })
          },
        },
      })
      const backend = new LayerFSBackend({ client, output: join(root, 'out'), runId: 'run-r10b', retryBaseDelayMs: 1 })
      const state = await backend.baseline(source, 'initial')
      await backend.release(state)
      assert.deepEqual(actions.filter(action => action[0] === 'unmount'), [
        ['unmount', false],
        ['unmount', true],
      ])
    })
  })

  it('still propagates a non-stale unmount refusal', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const client = sandboxClientWith(actions, {
        workspace: {
          async unmount(handle, discard) {
            actions.push(['unmount', discard])
            throw new Error('permission denied')
          },
        },
      })
      const backend = new LayerFSBackend({ client, output: join(root, 'out'), runId: 'run-r10c', retryBaseDelayMs: 1 })
      const state = await backend.baseline(source, 'initial')
      await assert.rejects(backend.release(state), /permission denied/)
    })
  })
})

describe('R11: a superseded leader is released in recycle', () => {
  it('commits and unmounts the defeated leader instead of holding it', async () => {
    await withTemp(async root => {
      const worker = async (spec, index) => {
        await setState(spec.request.cwd, { score: 2 + index, metrics: { score: 2 + index } })
        return { output: [], stopReason: 'completed' }
      }
      const { runner } = await setupRunner(root, {
        worker,
        options: { rounds: 2, forkAndFlush: false },
      })
      const result = await runner.run()
      assert.equal(result.leader.id, 'round-2-continue-1')
      const initial = runner.rows[0]
      const round1 = runner.rows.find(row => row.id === 'round-1-continue-1')
      assert.ok(initial, 'the baseline is recorded')
      assert.equal(initial._state, null, 'the baseline was released during recycle')
      assert.equal(initial._released, true)
      assert.ok(round1, 'round 1 recorded its leader')
      assert.equal(round1._state, null, 'round 1 leader was released once round 2 defeated it')
      // Only the final leader is still mounted; releaseAll finishes the batch.
      assert.equal(runner.pendingWorkspaces().length, 1)
      await runner.releaseAll()
      assert.equal(runner.pendingWorkspaces().length, 0)
    })
  })
})

describe('R12: paginated branch reads and listing cursors', () => {
  it('reads a multi-page branch file to the end', async () => {
    await withTemp(async root => {
      const actions = []
      const client = sandboxClient(actions)
      const pages = []
      client.fs.list = async (branch, path) => (path === '/'
        ? { items: [{ name: 'big.txt', type: 'file' }], hasMore: false }
        : { items: [], hasMore: false })
      client.fs.read = async (branch, path, startLine) => {
        pages.push(startLine)
        if (startLine === undefined) return { text: 'aaa\n', nextLine: 2000 }
        if (startLine === 2000) return { text: 'bbb\n', nextLine: 4000 }
        return { text: 'ccc\n' }
      }
      const backend = new LayerFSBackend({ client, output: join(root, 'out'), runId: 'run-r12', retryBaseDelayMs: 1 })
      const state = await backend.adopt('ar-run-r12-leader', 'initial')
      assert.deepEqual(pages, [undefined, 2000, 4000])
      assert.equal(await readFile(join(state.path, 'big.txt'), 'utf8'), 'aaa\nbbb\nccc\n')
    })
  })

  it('stops when the read cursor does not advance', async () => {
    await withTemp(async root => {
      const client = sandboxClient([])
      let reads = 0
      client.fs.list = async (branch, path) => (path === '/'
        ? { items: [{ name: 'stuck.txt', type: 'file' }], hasMore: false }
        : { items: [], hasMore: false })
      client.fs.read = async (branch, path, startLine) => {
        reads += 1
        return { text: 'x', nextLine: 5 }
      }
      const backend = new LayerFSBackend({ client, output: join(root, 'out'), runId: 'run-r12b', retryBaseDelayMs: 1 })
      const state = await backend.adopt('ar-run-r12-leader', 'initial')
      assert.equal(reads, 2, 'one call plus one non-advancing follow-up')
      assert.equal(await readFile(join(state.path, 'stuck.txt'), 'utf8'), 'xx')
    })
  })

  it('follows nextPagePos and never re-reads a page', async () => {
    await withTemp(async root => {
      const positions = []
      const client = sandboxClient([])
      client.fs.list = async (branch, path, pageSize, pagePos) => {
        positions.push([path, pagePos])
        if (path !== '/') return { items: [], hasMore: false }
        if (pagePos === 0) return { items: [{ name: 'a.txt', type: 'file' }], hasMore: true, nextPagePos: 5000 }
        if (pagePos === 5000) return { items: [{ name: 'b.txt', type: 'file' }], hasMore: false }
        throw new Error('unexpected cursor ' + pagePos)
      }
      client.fs.read = async (branch, path) => `content of ${path}\n`
      const backend = new LayerFSBackend({ client, output: join(root, 'out'), runId: 'run-r12c', retryBaseDelayMs: 1 })
      const state = await backend.adopt('ar-run-r12-leader', 'initial')
      assert.deepEqual(positions.filter(([path]) => path === '/').map(([, pos]) => pos), [0, 5000])
      assert.equal(await readFile(join(state.path, 'a.txt'), 'utf8'), 'content of /a.txt\n')
      assert.equal(await readFile(join(state.path, 'b.txt'), 'utf8'), 'content of /b.txt\n')
    })
  })
})

describe('R13: meaningful_gain is validated unconditionally', () => {
  const base = {
    objective: 'o',
    worker_prompt: 'w',
    evaluator: '/e',
    evaluation_seconds: 1,
    direction: 'maximize',
    metrics: [{ name: 'a' }],
  }
  const options = {
    rounds: 1,
    branches: 2,
    explorationMinutes: 1,
    exploitationMinutes: 1,
    rsiTop: false,
    forkAndFlush: false,
    shareContext: false,
    sharingIntervalMinutes: 1,
  }

  it('rejects a negative gain even without RSI', () => {
    assert.throws(() => validatePlan({ ...base, meaningful_gain: -0.1 }, options), /meaningful_gain must be non-negative/)
    assert.throws(() => validatePlan({ ...base, meaningful_gain: '-3' }, options), /meaningful_gain must be non-negative/)
  })

  it('rejects a non-numeric gain instead of ignoring it', () => {
    assert.throws(() => validatePlan({ ...base, meaningful_gain: 'lots' }, options), /must be finite/)
    assert.throws(() => validatePlan({ ...base, meaningful_gain: true }, options), /not a score/)
  })

  it('requires a positive gain when RSI-top or require_meaningful_gain asks for one', () => {
    assert.throws(
      () => validatePlan({ ...base, stall_seconds: 1, metric_subset: 1, portfolio_size: 2 }, { ...options, rsiTop: true }),
      /RSI-top requires a positive meaningful_gain/,
    )
    assert.throws(
      () => validatePlan({ ...base, require_meaningful_gain: true }, options),
      /RSI-top requires a positive meaningful_gain/,
    )
    assert.equal(validatePlan({ ...base, meaningful_gain: 0.5 }, options).meaningful_gain, 0.5)
    assert.equal(validatePlan(base, options).meaningful_gain, 0)
  })
})

describe('R14: strict decimal score parsing', () => {
  it('accepts decimal literals only', () => {
    assert.equal(scoreValue('+1.5e3'), 1500)
    assert.equal(scoreValue('.5'), 0.5)
    assert.equal(scoreValue(' -2 '), -2)
    assert.equal(scoreValue('3.'), 3)
  })

  it('rejects hex, binary, octal and named infinity strings', () => {
    for (const value of ['0x10', '0b11', '0o7', 'Infinity', '-Infinity', 'NaN', '1e', '1,000']) {
      assert.throws(() => scoreValue(value), /must be finite/, value)
    }
  })
})

describe('R15: canonical distinct metric values', () => {
  it('treats key order as the same value', async () => {
    await withTemp(async root => {
      const { runner } = await setupRunner(root, {
        worker: async () => ({ output: [], stopReason: 'completed' }),
        extraPlan: { metrics: [{ name: 'shape', definition: 'object metric' }] },
      })
      runner.rows.push({
        id: 'a',
        parent: 'initial',
        workspace: join(root, 'a'),
        evaluation: { valid: true, score: 1, metrics: { shape: { x: 1, y: 2 } } },
      })
      runner.rows.push({
        id: 'b',
        parent: 'initial',
        workspace: join(root, 'b'),
        evaluation: { valid: true, score: 2, metrics: { shape: { y: 2, x: 1 } } },
      })
      const [diagnostic] = runner.metricDiagnostics()
      assert.equal(diagnostic.observations, 2)
      assert.equal(diagnostic.distinct_values, 1)
      assert.equal(diagnostic.constant_in_observed_checkpoints, true)
    })
  })

  it('counts genuinely different objects separately', async () => {
    await withTemp(async root => {
      const { runner } = await setupRunner(root, {
        worker: async () => ({ output: [], stopReason: 'completed' }),
        extraPlan: { metrics: [{ name: 'shape' }] },
      })
      runner.rows.push({
        id: 'a',
        parent: 'initial',
        workspace: join(root, 'a'),
        evaluation: { valid: true, score: 1, metrics: { shape: { x: 1, y: 2 } } },
      })
      runner.rows.push({
        id: 'b',
        parent: 'initial',
        workspace: join(root, 'b'),
        evaluation: { valid: true, score: 2, metrics: { shape: { x: 1, y: 3 } } },
      })
      assert.equal(runner.metricDiagnostics()[0].distinct_values, 2)
    })
  })
})

describe('R16: the disk check runs for both backends', () => {
  it('rejects an impossible cohort on a layerfs manager too', async () => {
    await withTemp(async root => {
      const workspace = join(root, 'workspace')
      await writeWorkspace(workspace)
      const manager = {
        kind: 'layerfs',
        baseline: async () => ({ id: 'initial', backend: 'layerfs', path: workspace, branch: null }),
        fork: async () => ({ id: 'x', backend: 'layerfs', path: workspace, branch: null }),
        commit: async () => {},
        release: async () => {},
        retainCompletedState: async () => { throw new Error('unused') },
        restoreCompletedState: async () => { throw new Error('unused') },
      }
      const runner = new Runner({
        config: {},
        plan: planFor(root),
        workspace,
        output: join(root, 'out'),
        deps: {
          subagents: fakeSubagents(async () => ({ output: [], stopReason: 'completed' })),
          workspaceManager: manager,
          workerProvider: 'worker',
          clock: fakeClock(),
          logger: {},
        },
      })
      await runner.checkDisk(workspace, 1)
      await assert.rejects(runner.checkDisk(workspace, Number.MAX_SAFE_INTEGER), /Insufficient space/)
    })
  })
})

describe('R17: an unexpected branch error preserves its workspace', () => {
  it('commits the unverified branch and releases it without discarding', async () => {
    await withTemp(async root => {
      const subagents = {
        list: () => ['worker'],
        async startActivation() {
          throw new Error('worker exploded')
        },
      }
      const { runner, manager } = await setupRunner(root, { subagents })
      const commits = []
      const releases = []
      const commit = manager.commit.bind(manager)
      const release = manager.release.bind(manager)
      manager.commit = async (state, options) => { commits.push(options?.message ?? ''); return commit(state, options) }
      manager.release = async (state, options) => { releases.push(options ?? {}); return release(state, options) }
      await assert.rejects(runner.run(), /worker exploded/)
      assert.ok(commits.some(message => /^auto-research: unverified /.test(message)), commits.join('\n'))
      assert.ok(releases.length >= 1)
      assert.ok(releases.every(options => options.discard === false), 'failed evidence is never discarded')
      assert.equal(runner.pendingWorkspaces().length, 0)
      const orphan = runner.abandoned.find(row => row.id === 'round-1-continue-1')
      assert.ok(orphan, 'the failed branch is recorded for review')
    })
  })
})

describe('R18: prototype-safe staging and retained-state edges', () => {
  it('publishes and removes files named after prototype members', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const backend = new LayerFSBackend({
        client: sandboxClient(actions),
        output: join(root, 'out'),
        runId: 'run-r18',
        retryBaseDelayMs: 1,
      })
      const state = await backend.baseline(source, 'initial')
      await writeFile(join(state.path, 'constructor'), 'ctor\n')
      await writeFile(join(state.path, 'toString'), 'str\n')
      actions.length = 0
      await backend.commit(state, { message: 'add' })
      const written = actions.find(action => action[0] === 'apply')[2].map(change => change.path)
      assert.ok(written.includes('/constructor'), written.join(','))
      assert.ok(written.includes('/toString'))
      await rm(join(state.path, 'constructor'))
      actions.length = 0
      await backend.commit(state, { message: 'remove' })
      const removed = actions.find(action => action[0] === 'apply')[2]
        .filter(change => change.op === 'rm')
        .map(change => change.path)
      assert.deepEqual(removed, ['/constructor'])
    })
  })

  it('creates parent directories in the fs.write fallback', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const client = {
        branch: { async fork(name) { actions.push(['fork', name]) } },
        workspace: {
          async mount() { return { sandbox: '1', path: SANDBOX_PATH } },
          async commit() { actions.push(['commit']) },
          async unmount() {},
        },
        fs: {
          async mkdir(branch, path) { actions.push(['mkdir', path]) },
          async write(branch, path) { actions.push(['write', path]) },
          async rm(branch, path) { actions.push(['rm', path]) },
        },
      }
      const backend = new LayerFSBackend({ client, output: join(root, 'out'), runId: 'run-r18b', retryBaseDelayMs: 1 })
      const state = await backend.baseline(source, 'initial')
      await mkdir(join(state.path, 'nested'), { recursive: true })
      await writeFile(join(state.path, 'nested', 'file.txt'), 'x\n')
      actions.length = 0
      await backend.commit(state, { message: 'nested' })
      const mkdirIndex = actions.findIndex(action => action[0] === 'mkdir' && action[1] === '/nested')
      const writeIndex = actions.findIndex(action => action[0] === 'write' && action[1] === '/nested/file.txt')
      assert.ok(mkdirIndex >= 0, 'the parent directory was created on the branch first')
      assert.ok(writeIndex > mkdirIndex)
    })
  })

  it('starts the staged baseline from the branch inventory so deletions are published', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const client = sandboxClient(actions)
      client.fs.list = async (branch, path) => (path === '/'
        ? { items: [{ name: 'stale.txt', type: 'file' }], hasMore: false }
        : { items: [], hasMore: false })
      const backend = new LayerFSBackend({ client, output: join(root, 'out'), runId: 'run-r18c', retryBaseDelayMs: 1 })
      await backend.baseline(source, 'initial')
      const apply = actions.find(action => action[0] === 'apply')
      const removed = apply[2].filter(change => change.op === 'rm').map(change => change.path)
      assert.deepEqual(removed, ['/stale.txt'])
    })
  })

  it('syncs a restored branchless parent even when baseline syncing is off', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const client = hostClient(root, actions)
      const backend = new LayerFSBackend({
        client,
        output: join(root, 'out'),
        runId: 'run-r18d',
        syncBaseline: false,
        retryBaseDelayMs: 1,
      })
      const parent = { id: 'restored', backend: 'snapshot', path: source, branch: null }
      const child = await backend.fork(parent, 'child')
      assert.equal(existsSync(join(child.path, 'state.json')), true)
      assert.equal(existsSync(join(child.path, 'notes.md')), true)
      assert.ok(child.branch, 'the child still gets its own branch')
    })
  })

  it('empties a retained completed workspace before restoring into it', async () => {
    await withTemp(async root => {
      const workspace = join(root, 'ws')
      await writeWorkspace(workspace)
      const output = join(root, 'out')
      const files = await inventory(workspace)
      const row = {
        id: 'branch-1',
        parent: 'initial',
        workspace,
        evaluation: { valid: true, score: 1, evidence: {}, workspace_manifest_sha256: jsonDigest(files) },
      }
      const checkpoint = await retainCompletedState(output, row)
      const stale = join(output, 'branch-2-last-completed', 'workspace', 'stale.txt')
      await mkdir(dirname(stale), { recursive: true })
      await writeFile(stale, 'left over\n')
      const restored = await restoreCompletedState(output, checkpoint, { ...row, id: 'branch-2' })
      assert.equal(existsSync(stale), false)
      assert.equal(existsSync(join(restored.workspace, 'state.json')), true)
    })
  })
})

describe('R19: LATEST.json resolution and empty selections', () => {
  it('fails loud on a selection with neither leader_workspace nor leader_branch', async () => {
    await withTemp(async root => {
      const { cwd, provider } = await providerFixture(root)
      await mkdir(join(cwd, '.auto-research-methods'), { recursive: true })
      await writeFile(join(cwd, '.auto-research-methods', 'LATEST.json'), '{}\n')
      await assert.rejects(
        provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }),
        /has no leader_workspace or leader_branch/,
      )
      assert.equal(existsSync(join(cwd, '.auto-research-methods', 'runner.lock')), false, 'the lock was released')
    })
  })

  it('refuses a saved workspace that resolves outside the run tree', async () => {
    await withTemp(async root => {
      const { cwd, provider } = await providerFixture(root)
      const runtime = join(cwd, '.auto-research-methods')
      const runs = join(runtime, 'runs')
      const outside = join(root, 'outside')
      await mkdir(runs, { recursive: true })
      await writeWorkspace(outside, { score: 9, metrics: { score: 9 } })
      await symlink(outside, join(runs, 'escape'))
      await writeFile(join(runtime, 'LATEST.json'), JSON.stringify({
        leader_workspace: join(runs, 'escape'),
        leader_branch: null,
      }, null, 2) + '\n')
      await assert.rejects(
        provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }),
        /Previous leader workspace is missing or inaccessible/,
      )
      assert.equal(existsSync(join(runtime, 'runner.lock')), false, 'the rejected start released its lock')
      // The run directory is created (after the lock) but no leader was adopted:
      // the run tree still holds only the planted link.
      const runsAfter = await readdir(runs)
      assert.equal(runsAfter.includes('escape'), true)
      assert.equal(runsAfter.length, 2, 'one run directory plus the planted link')
    })
  })
})

describe('R20: unique atomic JSON temporary files', () => {
  it('lets concurrent writers finish without leaving temporary files', async () => {
    await withTemp(async root => {
      const path = join(root, 'artifacts', 'DASHBOARD.json')
      await Promise.all(Array.from({ length: 32 }, (_, index) => writeJsonAtomic(path, { index })))
      const saved = JSON.parse(await readFile(path, 'utf8'))
      assert.ok(Number.isInteger(saved.index))
      assert.deepEqual(await readdir(join(root, 'artifacts')), ['DASHBOARD.json'])
      await writeJsonAtomic(path, { final: true })
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { final: true })
      assert.deepEqual(await readdir(join(root, 'artifacts')), ['DASHBOARD.json'])
    })
  })

  it('ignores a leftover fixed-name temp file from an older build', async () => {
    await withTemp(async root => {
      const path = join(root, 'value.json')
      await writeFile(path + '.new', 'stale')
      await writeJsonAtomic(path, { ok: 1 })
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { ok: 1 })
      assert.equal(await readFile(path + '.new', 'utf8'), 'stale', 'an unrelated temp file is untouched')
    })
  })
})

describe('R21: resource leaks and configuration validation', () => {
  it('closes the SDK client when loading its operator fails', async () => {
    await withTemp(async root => {
      const marker = join(root, 'closed.txt')
      const sdk = join(root, 'sdk.mjs')
      await writeFile(sdk, `
import { writeFileSync } from 'node:fs'
export class LayerFS {
  constructor() {
    this.branch = { fork: async () => {} }
    this.workspace = { mount: async () => ({ sandbox: '1', path: '/workspaces/1' }) }
  }
  async close() { writeFileSync(${JSON.stringify(marker)}, 'closed\\n') }
}
`)
      const operator = join(root, 'operator.mjs')
      await writeFile(operator, "throw new Error('operator unavailable')\n")
      const settings = resolveLayerfsConfig({
        DSH_LAYERFS_PROJECT: 'p',
        DSH_LAYERFS_SDK: sdk,
        DSH_LAYERFS_OPERATOR: operator,
      })
      await assert.rejects(loadLayerfs(settings), /operator unavailable/)
      assert.equal(existsSync(marker), true, 'the constructed client was closed')
    })
  })

  it('removes the abort listener when a sleep resolves normally', async () => {
    const controller = new AbortController()
    for (let index = 0; index < 12; index += 1) {
      await DEFAULT_CLOCK.sleep(1, controller.signal)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
    }
    const aborted = new AbortController()
    const sleeping = DEFAULT_CLOCK.sleep(60_000, aborted.signal)
    aborted.abort()
    await assert.rejects(sleeping, error => error instanceof ResearchStoppedError)
  })

  it('validates plugin configuration types and ranges', () => {
    for (const [config, pattern] of [
      [{ rounds: 0 }, /rounds must be a positive integer/],
      [{ rounds: 1.5 }, /rounds must be a positive integer/],
      [{ branches: 0 }, /branches must be a positive integer/],
      [{ branches: '4' }, /branches must be a positive integer/],
      [{ explorationMinutes: 0 }, /explorationMinutes must be a positive finite number/],
      [{ exploitationMinutes: Number.POSITIVE_INFINITY }, /exploitationMinutes must be a positive finite number/],
      [{ sharingIntervalMinutes: -1 }, /sharingIntervalMinutes must be a positive finite number/],
      [{ rsiTop: 'yes' }, /rsiTop must be a boolean/],
      [{ forkAndFlush: 1 }, /forkAndFlush must be a boolean/],
      [{ shareContext: 'true' }, /shareContext must be a boolean/],
      [{ workspaceBackend: 'nfs' }, /workspaceBackend must be/],
      [{ providerName: '' }, /providerName must be a non-empty string/],
      [{ planPath: '   ' }, /planPath must be a non-empty string/],
      [{ workerProvider: 7 }, /workerProvider must be a non-empty string/],
    ]) {
      assert.throws(() => resolveConfig(config), pattern, JSON.stringify(config))
    }
    assert.equal(resolveConfig({}).rounds, 1)
    assert.equal(resolveConfig({ rounds: 2, workspaceBackend: 'snapshot' }).workspaceBackend, 'snapshot')
    assert.equal(resolveConfig({ workerEnv: { A: '1' } }).workerEnv.A, '1')
  })

  it('surfaces configuration errors as standard-schema issues', async () => {
    const { Config } = await import('../lib/index.js')
    const bad = Config['~standard'].validate({ branches: 0 })
    assert.ok(Array.isArray(bad.issues))
    assert.match(bad.issues[0].message, /branches must be a positive integer/)
    const good = Config['~standard'].validate({ rounds: 2 })
    assert.equal(good.value.rounds, 2)
  })

  it('reports the coordinator session id and runtime-run containment helpers', () => {
    assert.equal(sessionIdOf({ session: { header: { id: 's-1' } } }), 's-1')
    assert.equal(sessionIdOf({ session: { header: {} } }), null)
    assert.equal(sessionIdOf(null), null)
    assert.equal(isInsideRuntimeRuns(join('/tmp', 'repo', '.auto-research-methods', 'runs', 'id')), true)
    assert.equal(isInsideRuntimeRuns(join('/tmp', 'repo', '.auto-research-methods', 'plan.json')), false)
  })
})
