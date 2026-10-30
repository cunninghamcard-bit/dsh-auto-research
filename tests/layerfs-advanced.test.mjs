import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LayerFSBackend,
  WorkspaceManager,
  layerfsEnvironment,
  resolveLayerfsConfig,
  resolveShellEnvironment,
  withBusyRetry,
} from '../lib/layerfs-workspace.js'
import { setState, withTemp, writeWorkspace } from './helpers.mjs'

const SANDBOX_PATH = `/workspaces/auto-research-${process.pid}`

function sandboxClient(actions, { path = SANDBOX_PATH, apply = true } = {}) {
  const client = {
    branch: {
      async fork(name, from) {
        actions.push(['fork', name, from])
      },
    },
    workspace: {
      async mount(name) {
        actions.push(['mount', name])
        return { sandbox: 'sandbox-1', path }
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
  if (apply) {
    client.fs = {
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
    }
  } else {
    client.fs = {
      async write(branch, path, content) {
        actions.push(['write', branch, path, Buffer.from(content).toString('utf8')])
      },
      async rm(branch, path) {
        actions.push(['rm', branch, path])
      },
    }
  }
  return client
}

describe('withBusyRetry', () => {
  it('retries Busy with exponential backoff and returns the eventual value', async () => {
    let attempts = 0
    const delays = []
    const value = await withBusyRetry(async () => {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error('workspace is busy'), { code: 'Busy' })
      return 'ok'
    }, { baseDelayMs: 7, delay: async milliseconds => { delays.push(milliseconds) } })
    assert.equal(value, 'ok')
    assert.equal(attempts, 3)
    assert.deepEqual(delays, [7, 14])
  })

  it('does not retry non-Busy errors and stops after the configured retries', async () => {
    await assert.rejects(withBusyRetry(async () => { throw new Error('fatal') }, { delay: async () => {} }), /fatal/)
    let attempts = 0
    await assert.rejects(withBusyRetry(async () => {
      attempts += 1
      throw Object.assign(new Error('busy'), { code: 'Busy' })
    }, { retries: 2, baseDelayMs: 1, delay: async () => {} }), /busy/)
    assert.equal(attempts, 3)
  })
})

describe('LayerFS branch names and adoption', () => {
  it('caps names at 63 characters and keeps the ar- prefix', () => {
    const backend = new LayerFSBackend({
      client: sandboxClient([]),
      output: '/tmp',
      runId: 'run-'.repeat(30),
    })
    const name = backend.branchName('branch-'.repeat(30))
    assert.ok(name.length <= 63, name)
    assert.match(name, /^ar-[a-z0-9-]+$/)
  })

  it('rejects unsafe or oversized adopted branch names', async () => {
    const backend = new LayerFSBackend({ client: sandboxClient([]), output: '/tmp' })
    await assert.rejects(backend.adopt('Bad Branch', 'initial'), /not a safe auto-research branch name/)
    await assert.rejects(backend.adopt('ar-' + 'a'.repeat(70), 'initial'), /not a safe auto-research branch name/)
    await assert.rejects(backend.adopt('../main', 'initial'), /not a safe auto-research branch name/)
  })

  it('fails loud when the saved branch cannot be mounted', async () => {
    const client = sandboxClient([])
    client.workspace.mount = async () => { throw new Error('branch not found') }
    const backend = new LayerFSBackend({ client, output: '/tmp' })
    await assert.rejects(backend.adopt('ar-run-1-leader', 'initial'), /Previous leader branch is missing or inaccessible/)
  })

  it('never closes a host-injected shared client but closes an owned client', async () => {
    const injectedActions = []
    const injected = new LayerFSBackend({ client: sandboxClient(injectedActions), output: '/tmp' })
    await injected.close()
    assert.deepEqual(injectedActions, [])

    const ownedActions = []
    const owned = new LayerFSBackend({ client: sandboxClient(ownedActions), output: '/tmp', ownsClient: true })
    await owned.close()
    assert.deepEqual(ownedActions, [['close']])
  })
})

describe('Sandbox-internal mounting bridge', () => {
  it('stages a host copy and publishes writes/deletes with fs.apply plus workspace.commit', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const backend = new LayerFSBackend({
        client: sandboxClient(actions),
        output: join(root, 'out'),
        runId: 'run-1',
        retryBaseDelayMs: 1,
      })
      const state = await backend.baseline(source, 'initial')
      assert.equal(state.staging, true)
      assert.equal(state.sandboxPath, SANDBOX_PATH)
      assert.equal(state.path, join(root, 'out', 'initial', 'workspace'))
      assert.equal(await readFile(join(state.path, 'notes.md'), 'utf8'), '# notes\n')

      const baselineApply = actions.find(action => action[0] === 'apply')
      assert.ok(baselineApply)
      assert.deepEqual(baselineApply[2].map(change => change.path).sort(), ['/notes.md', '/state.json'])
      assert.ok(actions.some(action => action[0] === 'commit' && action[2] === 'auto-research: baseline initial'))

      await setState(state.path, { score: 9, metrics: { score: 9 } })
      await writeFile(join(state.path, 'extra.txt'), 'new evidence\n')
      await import('node:fs/promises').then(fsp => fsp.unlink(join(state.path, 'notes.md')))
      actions.length = 0
      await backend.commit(state, { message: 'auto-research: verified initial' })
      const apply = actions.find(action => action[0] === 'apply')
      assert.ok(apply)
      const writes = apply[2].filter(change => change.op === 'write').map(change => change.path).sort()
      assert.deepEqual(writes, ['/extra.txt', '/state.json'])
      assert.deepEqual(apply[2].filter(change => change.op === 'rm').map(change => change.path), ['/notes.md'])
      const stateWrite = apply[2].find(change => change.path === '/state.json')
      assert.match(stateWrite.content, /"score": 9/)
      assert.ok(actions.some(action => action[0] === 'commit'))

      await backend.release(state)
      assert.deepEqual(actions.at(-1), ['unmount', 'sandbox-1', false])
    })
  })

  it('falls back to fs.write/fs.rm when fs.apply is unavailable', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const backend = new LayerFSBackend({
        client: sandboxClient(actions, { apply: false }),
        output: join(root, 'out'),
        runId: 'run-2',
        retryBaseDelayMs: 1,
      })
      const state = await backend.baseline(source, 'initial')
      const writes = actions.filter(action => action[0] === 'write').map(action => action[2]).sort()
      assert.deepEqual(writes, ['/notes.md', '/state.json'])
      await backend.commit(state, { message: 'second' })
      assert.ok(actions.some(action => action[0] === 'commit'))
    })
  })

  it('materializes an adopted Sandbox branch through fs.list/fs.read', async () => {
    await withTemp(async root => {
      const actions = []
      const client = sandboxClient(actions)
      client.fs.list = async (branch, path) => {
        if (path === '/') {
          return { items: [{ name: 'state.json', type: 'file' }, { name: 'RESEARCH_CONTEXT', type: 'directory' }], hasMore: false }
        }
        if (path === '/RESEARCH_CONTEXT') {
          return { items: [{ name: 'topic__m__r__verified.md', type: 'file' }], hasMore: false }
        }
        return { items: [], hasMore: false }
      }
      client.fs.read = async (branch, path) => {
        if (path === '/state.json') return '{"score":4}\n'
        if (path.endsWith('.md')) return '# topic\n'
        throw new Error('missing')
      }
      const backend = new LayerFSBackend({ client, output: join(root, 'out'), runId: 'run-3', retryBaseDelayMs: 1 })
      const state = await backend.adopt('ar-run-1-leader', 'initial')
      assert.equal(state.staging, true)
      assert.equal(await readFile(join(state.path, 'state.json'), 'utf8'), '{"score":4}\n')
      assert.equal(await readFile(join(state.path, 'RESEARCH_CONTEXT', 'topic__m__r__verified.md'), 'utf8'), '# topic\n')
    })
  })

  it('retries Busy refusals on branch.fork', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      let attempts = 0
      const client = sandboxClient(actions, { path: join(root, 'host-mount') })
      const fork = client.branch.fork
      client.branch.fork = async (...args) => {
        attempts += 1
        if (attempts < 3) throw Object.assign(new Error('Busy'), { code: 'Busy' })
        await mkdir(join(root, 'host-mount'), { recursive: true })
        return fork(...args)
      }
      const backend = new LayerFSBackend({
        client,
        output: join(root, 'out'),
        runId: 'run-4',
        retryBaseDelayMs: 1,
      })
      const state = await backend.baseline(source, 'initial')
      assert.equal(attempts, 3)
      assert.equal(state.staging, false)
    })
  })
})

describe('loadLayerfs deployment binding', () => {
  it('mirrors ctx.shellEnv deployment settings onto the SDK client options', async () => {
    await withTemp(async root => {
      const sdk = join(root, 'sdk.mjs')
      await writeFile(sdk, `
export class LayerFS {
  constructor(project, options) {
    this.projectName = project
    this.options = { ...options, deploy: {} }
  }
  async close() {}
}
`)
      const settings = resolveLayerfsConfig({
        DSH_LAYERFS_PROJECT: 'proj',
        DSH_LAYERFS_SDK: sdk,
        DSH_LAYERFS_STORE_PATH: '/store',
        DSH_LAYERFS_HOME: '/home',
        DSH_LAYERFS_DOCKER: '/docker.sock',
        DSH_LAYERFS_IMAGE: 'image:test',
        DSH_LAYERFS_VOLUME: 'volume',
        DSH_LAYERFS_DAEMON: 'daemon',
        DSH_LAYERFS_CONTAINER_PREFIX: 'prefix',
        DSH_LAYERFS_DAEMON_HOST: 'host.docker.internal',
      })
      const { loadLayerfs } = await import('../lib/layerfs-workspace.js')
      const loaded = await loadLayerfs(settings)
      assert.equal(loaded.client.projectName, 'proj')
      assert.equal(loaded.client.options.storePath, '/store')
      assert.equal(loaded.client.options.home, '/home')
      assert.deepEqual(loaded.client.options.deploy, {
        docker: '/docker.sock',
        image: 'image:test',
        volume: 'volume',
        daemon: 'daemon',
        containerPrefix: 'prefix',
        daemonHost: 'host.docker.internal',
      })
    })
  })
})

describe('session environment resolution', () => {
  it('merges ctx.shellEnv contributors, resolve(), env, and ctx.get fallback', async () => {
    const service = {
      env: { A: '1', skip: 42 },
      async resolve() { return { B: '2' } },
      contributors: [
        () => ({ C: '3' }),
        { contribute: () => ({ D: '4' }) },
        { env: { E: '5' } },
        () => { throw new Error('unavailable') },
      ],
    }
    const merged = await resolveShellEnvironment({ shellEnv: service })
    assert.deepEqual(merged, { A: '1', B: '2', C: '3', D: '4', E: '5' })
    const viaGet = await resolveShellEnvironment({ get: name => name === 'shellEnv' ? { env: { F: '6' } } : null })
    assert.deepEqual(viaGet, { F: '6' })
    const viaCollect = await resolveShellEnvironment({
      shellEnv: { collect: execution => ({ G: '7', agent: String(execution.agent?.id ?? '') }) },
    }, { id: 'parent-1' })
    assert.deepEqual(viaCollect, { G: '7', agent: 'parent-1' })
    assert.deepEqual(await resolveShellEnvironment({}), {})
  })

  it('includes every DSH_LAYERFS_* name in the worker environment', () => {
    const settings = resolveLayerfsConfig({
      DSH_LAYERFS_PROJECT: 'project',
      DSH_LAYERFS_SDK: '/sdk/index.js',
      DSH_LAYERFS_IMAGE: 'image',
      DSH_LAYERFS_VOLUME: 'volume',
      DSH_LAYERFS_DAEMON: 'daemon',
      DSH_LAYERFS_CONTAINER_PREFIX: 'prefix',
      DSH_LAYERFS_DAEMON_HOST: 'host',
    })
    assert.equal(settings.image, 'image')
    assert.equal(settings.daemonHost, 'host')
    assert.equal(resolveLayerfsConfig({}), null)
    assert.equal(resolveLayerfsConfig({ DSH_LAYERFS_PROJECT: 'x' }, false), null)
    const env = layerfsEnvironment({ DSH_LAYERFS_CLI: 'cli', DSH_LAYERFS_SKILL: 'skill' }, settings)
    assert.equal(env.DSH_LAYERFS_CLI, 'cli')
    assert.equal(env.DSH_LAYERFS_SKILL, 'skill')
    assert.equal(env.DSH_LAYERFS_IMAGE, 'image')
    assert.equal(env.DSH_LAYERFS_CONTAINER_PREFIX, 'prefix')
  })

  it('keeps WorkspaceManager release idempotent for a shared backend', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const manager = new WorkspaceManager(
        new LayerFSBackend({ client: sandboxClient(actions), output: join(root, 'out'), runId: 'run-5' }),
        { output: join(root, 'out') },
      )
      const state = await manager.baseline(source, 'initial')
      await manager.release(state)
      await manager.release(state)
      assert.deepEqual(actions.filter(action => action[0] === 'unmount'), [
        ['unmount', 'sandbox-1', false],
        ['unmount', 'sandbox-1', false],
      ])
    })
  })
})
