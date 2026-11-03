import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  LayerFSBackend,
  WorkspaceManager,
  layerfsEnvironment,
  resolveLayerfsConfig,
  withBusyRetry,
} from '../lib/layerfs-workspace.js'
import { setState, withTemp, writeWorkspace } from './helpers.ts'

const SANDBOX_PATH = `/workspaces/auto-research-${process.pid}`

function sandboxClient(
  actions: any[],
  { path = SANDBOX_PATH }: { path?: string } = {},
): any {
  return {
    branch: {
      async fork(name: any, from: any) {
        actions.push(['fork', name, from])
      },
    },
    sandbox: {
      async create() {
        return { sandbox: 'sandbox-1', image: 'sha256:image' }
      },
      async list_workspaces() {
        return { items: [{ path, changed: false, headMovedSinceMount: false }] }
      },
    },
    workspace: {
      async mount(sandbox: any, name: any) {
        actions.push(['mount', name])
        return { sandbox, path }
      },
      async commit(handle: any, message: any) {
        actions.push(['commit', handle.sandbox, message])
        return { kind: 'Committed' }
      },
      async unmount(handle: any, discard: any) {
        actions.push(['unmount', handle.sandbox, discard])
      },
      async exec() {
        return { exitCode: 1, stdout: null }
      },
    },
    fs: {
      async apply(branch: any, changes: any[], message: any) {
        actions.push([
          'apply',
          branch,
          changes.map((change: any) => ({
            op: change.op,
            path: change.path,
            content: change.content ?? (change.bytes === undefined ? undefined : Buffer.from(change.bytes).toString('utf8')),
          })),
          message,
        ])
      },
      async list() {
        return { items: [], hasMore: false }
      },
      async read() {
        throw Object.assign(new Error('missing'), { code: 'NoSuchPath' })
      },
    },
    async close() {
      actions.push(['close'])
    },
  }
}

describe('withBusyRetry', () => {
  it('retries Busy with exponential backoff and returns the eventual value', async () => {
    let attempts = 0
    const delays: number[] = []
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
    const injectedActions: any[] = []
    const injected = new LayerFSBackend({ client: sandboxClient(injectedActions), output: '/tmp' })
    await injected.close()
    assert.deepEqual(injectedActions, [])

    const ownedActions: any[] = []
    const owned = new LayerFSBackend({ client: sandboxClient(ownedActions), output: '/tmp', ownsClient: true })
    await owned.close()
    assert.deepEqual(ownedActions, [['close']])
  })
})

describe('Sandbox-internal mounting bridge', () => {
  it('stages a host copy and publishes writes/deletes with fs.apply', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions: any[] = []
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
      assert.deepEqual(baselineApply[2].map((change: any) => change.path).sort(), ['/notes.md', '/state.json'])

      await setState(state.path, { score: 9, metrics: { score: 9 } })
      await writeFile(join(state.path, 'extra.txt'), 'new evidence\n')
      await import('node:fs/promises').then(fsp => fsp.unlink(join(state.path, 'notes.md')))
      actions.length = 0
      await backend.commit(state, { message: 'auto-research: verified initial' })
      const apply = actions.find(action => action[0] === 'apply')
      assert.ok(apply)
      const writes = apply[2].filter((change: any) => change.op === 'write').map((change: any) => change.path).sort()
      assert.deepEqual(writes, ['/extra.txt', '/state.json'])
      assert.deepEqual(apply[2].filter((change: any) => change.op === 'rm').map((change: any) => change.path), ['/notes.md'])
      const stateWrite = apply[2].find((change: any) => change.path === '/state.json')
      assert.match(stateWrite.content, /"score": 9/)

      await backend.release(state)
      assert.deepEqual(actions.at(-1), ['unmount', 'sandbox-1', false])
    })
  })

  it('materializes an adopted Sandbox branch through fs.list/fs.read', async () => {
    await withTemp(async root => {
      const actions: any[] = []
      const client = sandboxClient(actions)
      client.fs.list = async (branch: string, path: string) => {
        if (path === '/') {
          return { items: [{ name: 'state.json', type: 'file' }, { name: 'RESEARCH_CONTEXT', type: 'dir' }], hasMore: false }
        }
        if (path === '/RESEARCH_CONTEXT') {
          return { items: [{ name: 'topic__m__r__verified.md', type: 'file' }], hasMore: false }
        }
        return { items: [], hasMore: false }
      }
      client.fs.read = async (branch: string, path: string) => {
        if (path === '/state.json') return { text: '{"score":4}\n', nextLine: null }
        if (path.endsWith('.md')) return { text: '# topic\n', nextLine: null }
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
      const actions: any[] = []
      let attempts = 0
      const client = sandboxClient(actions, { path: join(root, 'host-mount') })
      const fork = client.branch.fork
      client.branch.fork = async (...args: any[]) => {
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

describe('LayerFS project binding', () => {
  it('names the missing project instead of forking from nothing', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const client = sandboxClient([])
      client.branch.fork = async () => { throw Object.assign(new Error('no project'), { code: 'NoSuchProject' }) }
      const backend = new LayerFSBackend({ client, project: 'demo', output: join(root, 'out'), retryBaseDelayMs: 1 })
      await assert.rejects(backend.baseline(source, 'initial'), /LayerFS project demo does not exist; import the checkout in dsh/)
    })
  })

  it('makes a new Sandbox when the current one closed itself', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions: any[] = []
      const client = sandboxClient(actions)
      let made = 0
      client.sandbox.create = async () => ({ sandbox: String(++made), image: 'sha256:image' })
      const mount = client.workspace.mount
      client.workspace.mount = async (sandbox: string, name: string) => {
        if (sandbox === '1' && name.endsWith('child')) {
          throw Object.assign(new Error('Sandbox 1 is not running'), { code: 'NoSuchSandbox' })
        }
        return mount(sandbox, name)
      }
      const backend = new LayerFSBackend({ client, output: join(root, 'out'), runId: 'run-6', retryBaseDelayMs: 1 })
      const base = await backend.baseline(source, 'initial')
      const child = await backend.fork(base, 'child')
      assert.equal(made, 2)
      assert.equal((child.handle as any).sandbox, '2')
    })
  })
})

describe('session environment resolution', () => {
  it('includes every DSH_LAYERFS_* name in the worker environment', () => {
    const settings = resolveLayerfsConfig({
      DSH_LAYERFS_PROJECT: 'project',
      DSH_LAYERFS_SDK: '/sdk/index.js',
      DSH_LAYERFS_IMAGE: 'image',
      DSH_LAYERFS_VOLUME: 'volume',
      DSH_LAYERFS_DAEMON: 'daemon',
      DSH_LAYERFS_CONTAINER_PREFIX: 'prefix',
      DSH_LAYERFS_DAEMON_HOST: 'host',
    })!
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
      const actions: any[] = []
      const manager = new WorkspaceManager(
        new LayerFSBackend({ client: sandboxClient(actions), output: join(root, 'out'), runId: 'run-5' }),
        { output: join(root, 'out') },
      )
      const state = await manager.baseline(source, 'initial')
      await manager.release(state)
      await manager.release(state)
      assert.deepEqual(actions.filter(action => action[0] === 'unmount'), [
        ['unmount', 'sandbox-1', true],
        ['unmount', 'sandbox-1', false],
        ['unmount', 'sandbox-1', false],
      ])
    })
  })
})
