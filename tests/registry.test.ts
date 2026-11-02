import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { ResearchExecutorRegistry, ResearchWorkspaceRegistry } from '../lib/registry.js'
import * as localPlugin from '../lib/local.js'
import * as layerfsPlugin from '../lib/layerfs.js'
import * as snapshotPlugin from '../lib/snapshot.js'
import { fakePluginContext, withTemp } from './helpers.ts'

const factory = (name: string, priority: number, backend: any) => ({
  name,
  priority,
  calls: 0,
  async create() { this.calls += 1; return backend },
})

describe('ResearchWorkspaceRegistry', () => {
  it('fails when no backend is registered', async () => {
    await assert.rejects(new ResearchWorkspaceRegistry().select('auto', { output: '/o', runId: 'r' }), /no workspace backend is available \(registered: none\)/)
  })

  it('fails when the named backend is missing or returns null', async () => {
    const registry = new ResearchWorkspaceRegistry()
    registry.register(factory('layerfs', 100, null))
    await assert.rejects(registry.select('layerfs', { output: '/o', runId: 'r' }), /"layerfs" is not available/)
    await assert.rejects(registry.select('colab', { output: '/o', runId: 'r' }), /"colab" is not registered \(registered: layerfs\)/)
  })

  it('tries auto backends by priority and takes the first non-null one', async () => {
    const registry = new ResearchWorkspaceRegistry()
    const low = factory('snapshot', 0, { name: 'snapshot' })
    const high = factory('layerfs', 100, null)
    const mid = factory('custom', 50, { name: 'custom' })
    registry.register(low)
    registry.register(high)
    registry.register(mid)
    assert.deepEqual(registry.list().map(item => item.name), ['layerfs', 'custom', 'snapshot'])
    assert.equal((await registry.select('auto', { output: '/o', runId: 'r' })).name, 'custom')
    assert.deepEqual([high.calls, mid.calls, low.calls], [1, 1, 0])
    // A concrete name skips priority order.
    assert.equal((await registry.select('snapshot', { output: '/o', runId: 'r' })).name, 'snapshot')
  })

  it('refuses a second factory with the same name and forgets a disposed one', () => {
    const registry = new ResearchWorkspaceRegistry()
    const dispose = registry.register(factory('snapshot', 0, null))
    assert.throws(() => registry.register(factory('snapshot', 0, null)), /already registered/)
    dispose()
    assert.deepEqual(registry.list(), [])
  })
})

describe('workspace backend plugins', () => {
  it('register on ctx.researchWorkspace and unregister on unload', () => {
    const registry = new ResearchWorkspaceRegistry()
    const layerfs = fakePluginContext({ researchWorkspace: registry })
    const snapshot = fakePluginContext({ researchWorkspace: registry })
    assert.equal(layerfsPlugin.name, 'dsh-auto-research-layerfs')
    assert.deepEqual(layerfsPlugin.inject, ['researchWorkspace'])
    assert.equal(snapshotPlugin.name, 'dsh-auto-research-snapshot')
    assert.deepEqual(snapshotPlugin.inject, ['researchWorkspace'])
    snapshotPlugin.apply(snapshot)
    layerfsPlugin.apply(layerfs)
    assert.deepEqual(registry.list().map(item => [item.name, item.priority]), [['layerfs', 100], ['snapshot', 0]])
    snapshot.dispose()
    assert.deepEqual(registry.list().map(item => item.name), ['layerfs'])
    layerfs.dispose()
    assert.deepEqual(registry.list(), [])
  })

  it('falls back to snapshot when LayerFS is opted out, even with a bound environment', async () => {
    await withTemp(async root => {
      const registry = new ResearchWorkspaceRegistry()
      layerfsPlugin.apply(fakePluginContext({ researchWorkspace: registry }))
      snapshotPlugin.apply(fakePluginContext({ researchWorkspace: registry }))
      const backend = await registry.select('auto', {
        output: join(root, 'out'),
        runId: 'r',
        config: { layerfs: false },
        env: { DSH_LAYERFS_PROJECT: 'p', DSH_LAYERFS_SDK: 'file:///sdk.js' },
      })
      assert.equal(backend.name, 'snapshot')
    })
  })
})

describe('executor plugins', () => {
  it('local registers on ctx.researchExecutor, picks up ctx.subprocess, and unregisters on unload', async () => {
    const registry = new ResearchExecutorRegistry()
    const subprocess = { spawn() { throw new Error('unused') } }
    const ctx = fakePluginContext({ researchExecutor: registry, subprocess })
    assert.deepEqual(localPlugin.inject, ['researchExecutor'])
    localPlugin.apply(ctx)
    assert.deepEqual(registry.list().map(item => [item.name, item.priority]), [['local', 0]])
    const executor = await registry.select('auto', { config: {}, plan: {} }) as any
    assert.equal(executor.name, 'local')
    assert.equal(executor.subprocess, subprocess)
    ctx.dispose()
    assert.equal(executor.subprocess, null)
    assert.deepEqual(registry.list(), [])
    await assert.rejects(registry.select('auto', { config: {}, plan: {} }), /no executor is available \(registered: none\); load dsh-auto-research\/local/)
  })
})
