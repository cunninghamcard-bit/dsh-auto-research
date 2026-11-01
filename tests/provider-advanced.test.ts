import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AutoResearchProvider,
  acquireRunnerLock,
} from '../lib/provider.js'
import { fakeSubagents, setState, withTemp, writeStateEvaluator, writeWorkspace } from './helpers.ts'

function planObject(root: string, extra: Record<string, any> = {}): any {
  return {
    objective: 'Fixture objective',
    worker_prompt: 'Do one experiment and save evidence.',
    evaluator: join(root, 'evaluator.mjs'),
    evaluation_seconds: 10,
    direction: 'maximize',
    metrics: [{ name: 'score' }],
    selection_metrics: [],
    stall_seconds: 3600,
    meaningful_gain: 0.1,
    metric_subset: 1,
    portfolio_size: 2,
    ...extra,
  }
}

async function fixture(root: string, {
  config = {},
  worker = null,
  shellEnv = null,
  planExtra = {},
  writePlan = true,
}: {
  config?: any
  worker?: any
  shellEnv?: any
  planExtra?: any
  writePlan?: boolean
} = {}) {
  const cwd = join(root, 'repo')
  await writeWorkspace(cwd, { score: 1, metrics: { score: 1 } })
  await writeStateEvaluator(join(cwd, 'evaluator.mjs'))
  const plan = planObject(cwd, planExtra)
  await mkdir(join(cwd, '.auto-research-methods'), { recursive: true })
  if (writePlan) await writeFile(join(cwd, '.auto-research-methods', 'plan.json'), JSON.stringify(plan))
  const subagents = fakeSubagents(worker ?? (async (spec: any) => {
    await setState(spec.request.cwd, { score: 2, metrics: { score: 2 } })
    return { output: [{ type: 'text', text: 'worker output' }], stopReason: 'completed' }
  }))
  const ctx: any = { subagents, logger: { info() {}, warn() {} } }
  if (shellEnv) ctx.shellEnv = shellEnv
  const provider = new AutoResearchProvider({
    ctx,
    config: {
      workerProvider: 'worker',
      rounds: 1,
      branches: 2,
      explorationMinutes: 0.5,
      exploitationMinutes: 0.5,
      ...config,
    },
  })
  return { cwd, provider, subagents, plan }
}

function abortableWorker(gates: any) {
  return async (spec: any) => {
    gates.resolveStarted()
    await Promise.race([
      gates.promise,
      new Promise<void>(resolve => {
        if (spec.signal?.aborted) resolve()
        else spec.signal?.addEventListener('abort', () => resolve(), { once: true })
      }),
    ])
    return { output: [], stopReason: spec.signal?.aborted ? 'aborted' : 'completed' }
  }
}

function gatePair() {
  let release: () => void = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  let resolveStarted: () => void = () => {}
  const started = new Promise<void>(resolve => { resolveStarted = resolve })
  return { promise, release, started, resolveStarted }
}

function sdkModule(path: string): string {
  return `import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
const mounts = ${JSON.stringify(path)}
export class LayerFS {
  constructor(project, options) {
    this.projectName = project
    this.options = options
    this.branch = { fork: async (name, from) => { this.lastFork = [name, from] } }
    this.workspace = {
      mount: async name => { await mkdir(join(mounts, name), { recursive: true }); return { sandbox: name, path: join(mounts, name) } },
      commit: async () => {},
      unmount: async () => {},
    }
    this.fs = {}
  }
  async close() {}
}
`
}

describe('P0: LayerFS environment from ctx.shellEnv', () => {
  it('detects DSH_LAYERFS_* through shellEnv contributors without process.env', async () => {
    const keys = ['DSH_LAYERFS_PROJECT', 'DSH_LAYERFS_SDK', 'DSH_LAYERFS_STORE_PATH', 'DSH_LAYERFS_IMAGE']
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
    try {
      await withTemp(async root => {
        const mounts = join(root, 'mounts')
        const sdk = join(root, 'sdk.mjs')
        await writeFile(sdk, sdkModule(mounts))
        const shellEnv = {
          async resolve() {
            return {
              DSH_LAYERFS_PROJECT: 'shell-project',
              DSH_LAYERFS_SDK: sdk,
              DSH_LAYERFS_STORE_PATH: '/store',
              DSH_LAYERFS_IMAGE: 'image:test',
            }
          },
        }
        const { cwd, provider, subagents } = await fixture(root, { shellEnv })
        const handle = await provider.start({
          cwd,
          prompt: [],
          parent: { id: 'p' },
          signal: new AbortController().signal,
        })
        const result = await handle.result
        assert.equal(result.stopReason, 'completed')
        assert.equal(subagents.calls.length, 1)
        const prompt = subagents.calls[0].request.prompt[0].text
        assert.match(prompt, /"DSH_LAYERFS_PROJECT":"shell-project"/)
        assert.match(prompt, /"DSH_LAYERFS_IMAGE":"image:test"/)
        const latest = JSON.parse(await readFile(join(cwd, '.auto-research-methods', 'LATEST.json'), 'utf8'))
        assert.match(latest.leader_branch, /^ar-/)
        const runs = await readdir(join(cwd, '.auto-research-methods', 'runs'))
        assert.equal(runs.length, 1)
        const launches = await readdir(join(cwd, '.auto-research-methods', 'runs', runs[0]!))
        assert.ok(launches.includes('round-1-continue-1'))
        assert.ok((await readdir(mounts)).length >= 2)
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

describe('P0/P1: leader adoption, seed runtime, and cancellation artifacts', () => {
  it('fails loud when LATEST.json names a leader that no longer exists', async () => {
    await withTemp(async root => {
      const { cwd, provider } = await fixture(root)
      const first = await provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal })
      await first.result
      await first.dispose()
      const latest = JSON.parse(await readFile(join(cwd, '.auto-research-methods', 'LATEST.json'), 'utf8'))
      assert.ok(latest.leader_workspace)
      await rm(latest.leader_workspace, { recursive: true, force: true })
      await assert.rejects(
        provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }),
        /Previous leader workspace is missing or inaccessible/,
      )
    })
  })

  it('stores runtime artifacts inside a compact seed and points at them', async () => {
    await withTemp(async root => {
      const cwd = join(root, 'repo')
      const seed = join(cwd, 'SEED')
      await writeWorkspace(seed, { score: 1, metrics: { score: 1 } })
      await writeStateEvaluator(join(seed, 'evaluator.mjs'))
      await mkdir(join(cwd, '.auto-research-methods'), { recursive: true })
      const plan = planObject(seed, { workspace: 'SEED' })
      await writeFile(join(cwd, '.auto-research-methods', 'plan.json'), JSON.stringify(plan))
      const subagents = fakeSubagents(async spec => {
        await setState(spec.request.cwd, { score: 3, metrics: { score: 3 } })
        return { output: [], stopReason: 'completed' }
      })
      const provider = new AutoResearchProvider({
        ctx: { subagents, logger: {} },
        config: { workerProvider: 'worker', branches: 2, explorationMinutes: 0.5, exploitationMinutes: 0.5 },
      })
      const handle = await provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal })
      const result = await handle.result
      assert.equal(result.stopReason, 'completed')
      const runs = await readdir(join(seed, '.auto-research-methods', 'runs'))
      assert.equal(runs.length, 1)
      const pointer = JSON.parse(await readFile(join(cwd, '.auto-research-methods', 'SEED.json'), 'utf8'))
      const realSeed = await import('node:fs/promises').then(fsp => fsp.realpath(seed))
      assert.equal(pointer.runtime, join(realSeed, '.auto-research-methods'))
      assert.equal(pointer.latest, join(realSeed, '.auto-research-methods', 'LATEST.json'))
      assert.ok(await readFile(join(seed, '.auto-research-methods', 'LATEST.json'), 'utf8'))
      let cwdRuns: string[] = []
      try { cwdRuns = await readdir(join(cwd, '.auto-research-methods', 'runs')) } catch { cwdRuns = [] }
      assert.deepEqual(cwdRuns, [])
      await handle.dispose()
    })
  })

  it('writes RESULT.json STOPPED with pending workspace paths on dispose', async () => {
    await withTemp(async root => {
      const gates = gatePair()
      const { cwd, provider } = await fixture(root, { worker: abortableWorker(gates) })
      const handle = await provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal })
      await gates.started
      const disposing = handle.dispose()
      const result = await handle.result
      await disposing
      assert.equal(result.stopReason, 'aborted')
      assert.match((result.output as any)[0].text, /STOPPED/)
      assert.match((result.output as any)[0].text, /pending_workspaces: 1/)
      const stopped = JSON.parse(await readFile(join(cwd, '.auto-research-methods', 'runs', (await readdir(join(cwd, '.auto-research-methods', 'runs')))[0]!, 'RESULT.json'), 'utf8'))
      assert.equal(stopped.status, 'STOPPED')
      assert.equal(stopped.stop_reason, 'stopped')
      assert.equal(stopped.artifacts_preserved, true)
      assert.equal(stopped.pending_workspaces.length, 1)
      assert.match(stopped.pending_workspaces[0].workspace, /round-1-continue-1/)
    })
  })
})

describe('P1: checkout lock and worker selection', () => {
  it('acquires, reclaims stale, and releases the runner lock idempotently', async () => {
    await withTemp(async root => {
      const alive = await acquireRunnerLock(root, 'run-1', { pid: 4242, alive: () => true })
      await assert.rejects(acquireRunnerLock(root, 'run-2', { pid: 4243, alive: () => true }), /already running/)
      await alive.release()
      await alive.release()
      const reclaimed = await acquireRunnerLock(root, 'run-3', { pid: 4244, alive: pid => pid !== 999999 })
      await fspWrite(join(root, 'runner.lock'), JSON.stringify({ pid: 999999, runId: 'dead' }))
      await reclaimed.release()
      const stale = await acquireRunnerLock(root, 'run-4', { pid: 4245, alive: pid => pid !== 999999 })
      assert.equal(JSON.parse(await readFile(join(root, 'runner.lock'), 'utf8')).runId, 'run-4')
      await stale.release()
    })
  })

  it('refuses a second concurrent batch on the same checkout', async () => {
    await withTemp(async root => {
      const gates = gatePair()
      const { cwd, provider, subagents } = await fixture(root, { worker: abortableWorker(gates) })
      const first = await provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal })
      await gates.started
      await assert.rejects(
        provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }),
        /already running for this checkout/,
      )
      const disposing = first.dispose()
      await first.result
      await disposing
      assert.equal(subagents.calls.length, 1)
      gates.release()
      const next = await provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal })
      await next.result
      await next.dispose()
    })
  })

  it('reclaims a stale lock left by a dead process', async () => {
    await withTemp(async root => {
      const { cwd, provider } = await fixture(root)
      await writeFile(join(cwd, '.auto-research-methods', 'runner.lock'), JSON.stringify({
        pid: 99999999,
        runId: 'dead-run',
        cwd,
        started_at: new Date(0).toISOString(),
      }))
      const handle = await provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal })
      const result = await handle.result
      assert.equal(result.stopReason, 'completed')
      await handle.dispose()
    })
  })

  it('prefers external non-inheriting worker providers and blocks recursion', async () => {
    const providers: Record<string, { inheritsParentContext: boolean }> = {
      fork: { inheritsParentContext: true },
      'claude-code': { inheritsParentContext: false },
      codex: { inheritsParentContext: false },
      acp: { inheritsParentContext: false },
    }
    const ctx: any = {
      subagents: {
        list: () => ['fork', 'claude-code', 'codex'],
        get: (name: string) => providers[name],
      },
    }
    assert.equal(new AutoResearchProvider({ ctx, config: {} }).workerProviderName(), 'claude-code')
    const getter = new AutoResearchProvider({
      ctx: { subagents: { list: () => ['fork', 'acp'], getProvider: (name: string) => providers[name] } } as any,
      config: {},
    })
    assert.equal(getter.workerProviderName(), 'acp')

    const onlyFork = new AutoResearchProvider({
      ctx: { subagents: { list: () => ['fork'], get: (name: string) => providers[name] } } as any,
      config: {},
    })
    assert.equal(onlyFork.workerProviderName(), 'fork')

    const recursive = new AutoResearchProvider({
      ctx: { subagents: { list: () => ['auto-research', 'fork'], describe: (name: string) => providers[name] } } as any,
      config: {},
    })
    assert.equal(recursive.workerProviderName(), 'fork')
    assert.throws(() => new AutoResearchProvider({
      ctx: { subagents: { list: () => ['auto-research'] } } as any,
      config: { workerProvider: 'auto-research' },
    }).workerProviderName(), /cannot delegate to itself/)
    assert.throws(() => new AutoResearchProvider({
      ctx: { subagents: { list: () => ['auto-research'] } } as any,
      config: {},
    }).workerProviderName(), /at least one other/)
  })
})

async function fspWrite(path: string, body: string) {
  await writeFile(path, body)
}
