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
  resolveShellEnvironment,
  withBusyRetry,
} from '../lib/layerfs-workspace.js'
import { setState, withTemp, writeWorkspace } from './helpers.ts'

const SANDBOX_PATH = `/workspaces/auto-research-${process.pid}`

function sandboxClient(
  actions: any[],
  { path = SANDBOX_PATH, apply = true }: { path?: string; apply?: boolean } = {},
): any {
  const client: any = {
    branch: {
      async fork(name: any, from: any) {
        actions.push(['fork', name, from])
      },
    },
    workspace: {
      async mount(name: any) {
        actions.push(['mount', name])
        return { sandbox: 'sandbox-1', path }
      },
      async commit(handle: any, message: any) {
        actions.push(['commit', handle.sandbox, message])
      },
      async unmount(handle: any, discard: any) {
        actions.push(['unmount', handle.sandbox, discard])
      },
    },
    async close() {
      actions.push(['close'])
    },
  }
  if (apply) {
    client.fs = {
      async apply(branch: any, changes: any[], message: any) {
        actions.push([
          'apply',
          branch,
          changes.map((change: any) => ({
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
      async write(branch: any, path: any, content: any) {
        actions.push(['write', branch, path, Buffer.from(content).toString('utf8')])
      },
      async rm(branch: any, path: any) {
        actions.push(['rm', branch, path])
      },
    }
  }
  return client
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
  it('stages a host copy and publishes writes/deletes with fs.apply plus workspace.commit', async () => {
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
      assert.ok(actions.some(action => action[0] === 'commit' && action[2] === 'auto-research: baseline initial'))

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
      assert.ok(actions.some(action => action[0] === 'commit'))

      await backend.release(state)
      assert.deepEqual(actions.at(-1), ['unmount', 'sandbox-1', false])
    })
  })

  it('falls back to fs.write/fs.rm when fs.apply is unavailable', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions: any[] = []
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
      const actions: any[] = []
      const client = sandboxClient(actions)
      client.fs.list = async (branch: string, path: string) => {
        if (path === '/') {
          return { items: [{ name: 'state.json', type: 'file' }, { name: 'RESEARCH_CONTEXT', type: 'directory' }], hasMore: false }
        }
        if (path === '/RESEARCH_CONTEXT') {
          return { items: [{ name: 'topic__m__r__verified.md', type: 'file' }], hasMore: false }
        }
        return { items: [], hasMore: false }
      }
      client.fs.read = async (branch: string, path: string) => {
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
      })!
      const { loadLayerfs } = await import('../lib/layerfs-workspace.js')
      const loaded: any = await loadLayerfs(settings)
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

describe('ported SDK environment forwarding', () => {
  it('publishes every DSH_LAYERFS_* setting while a client is alive and restores the process after', async () => {
    await withTemp(async root => {
      const sdk = join(root, 'port-sdk.mjs')
      await writeFile(sdk, `
// A stand-in for @dsh-layerfs/host/src/port/sdk.js: it reads the bundle at
// import time and the Store container on every call.
const bundleAtImport = process.env.DSH_LAYERFS_BUNDLE ?? null
export class LayerFS {
  constructor(project, options) {
    this.projectName = project
    this.options = { ...options, deploy: {} }
    this.bundleAtImport = bundleAtImport
    this.lastCall = null
  }
  async call() {
    this.lastCall = {
      storeContainer: process.env.DSH_LAYERFS_STORE_CONTAINER ?? null,
      bareStoreContainer: process.env.LAYERFS_STORE_CONTAINER ?? null,
      bundle: process.env.DSH_LAYERFS_BUNDLE ?? null,
      daemonHost: process.env.DSH_LAYERFS_DAEMON_HOST ?? null,
    }
    return this.lastCall
  }
  async close() {}
}
`)
      const settings = resolveLayerfsConfig({
        DSH_LAYERFS_PROJECT: 'proj',
        DSH_LAYERFS_SDK: sdk,
        DSH_LAYERFS_HOME: '/home',
        DSH_LAYERFS_DOCKER: '/orbstack/docker.sock',
        DSH_LAYERFS_IMAGE: 'sha256:abc',
        DSH_LAYERFS_VOLUME: 'volume',
        DSH_LAYERFS_DAEMON: '/bundle/layerfs-daemon',
        DSH_LAYERFS_CONTAINER_PREFIX: 'prefix-',
        DSH_LAYERFS_DAEMON_HOST: 'host.docker.internal',
        DSH_LAYERFS_STORE_CONTAINER: 'prefix-store',
        DSH_LAYERFS_BUNDLE: '/bundle',
        DSH_LAYERFS_TRACE_START: '1',
      })!
      assert.equal(settings.storeContainer, 'prefix-store')
      assert.equal(settings.bundle, '/bundle')
      assert.equal(settings.traceStart, '1')
      const env = layerfsEnvironment({}, settings)
      assert.equal(env.DSH_LAYERFS_STORE_CONTAINER, 'prefix-store')
      assert.equal(env.DSH_LAYERFS_BUNDLE, '/bundle')

      const previous = {
        DSH_LAYERFS_STORE_CONTAINER: process.env.DSH_LAYERFS_STORE_CONTAINER,
        LAYERFS_STORE_CONTAINER: process.env.LAYERFS_STORE_CONTAINER,
        DSH_LAYERFS_BUNDLE: process.env.DSH_LAYERFS_BUNDLE,
        LAYERFS_NATIVE: process.env.LAYERFS_NATIVE,
      }
      delete process.env.DSH_LAYERFS_STORE_CONTAINER
      delete process.env.LAYERFS_STORE_CONTAINER
      delete process.env.DSH_LAYERFS_BUNDLE
      const { loadLayerfs } = await import('../lib/layerfs-workspace.js')
      const loaded: any = await loadLayerfs(settings)
      assert.equal(loaded.client.bundleAtImport, '/bundle', 'the bundle is visible at import time')
      assert.deepEqual(await loaded.client.call(), {
        storeContainer: 'prefix-store',
        bareStoreContainer: 'prefix-store',
        bundle: '/bundle',
        daemonHost: 'host.docker.internal',
      })
      await loaded.close()
      assert.equal(process.env.DSH_LAYERFS_STORE_CONTAINER, undefined)
      assert.equal(process.env.LAYERFS_STORE_CONTAINER, undefined)
      assert.equal(process.env.DSH_LAYERFS_BUNDLE, undefined)
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    })
  })
})

describe('LayerFS project initialization', () => {
  it('initializes a missing project before forking its main branch', async () => {
    await withTemp(async root => {
      const home = join(root, 'home')
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions: any[] = []
      const client = {
        options: { home, deploy: {} },
        project: {
          async init(path: string) {
            actions.push(['init', path])
            // project.init records the project as a directory under the home
            await mkdir(join(home, 'proj'), { recursive: true })
            return { kind: 'Initialized' }
          },
        },
        branch: {
          async fork(name: string, from: string | undefined) {
            actions.push(['fork', name, from])
            if (!existsSync(join(home, 'proj'))) throw Object.assign(new Error('project proj does not exist'), { code: 'NoSuchProject' })
          },
        },
        workspace: {
          async mount(branch: string) { return { sandbox: '1', path: `/workspaces/${branch}` } },
          async commit() {},
          async unmount() {},
        },
        fs: { async apply() {} },
      }
      const backend = new LayerFSBackend({ client, project: 'proj', output: join(root, 'out'), runId: 'run-9' })
      const state = await backend.baseline(source, 'initial')
      assert.equal(state.branch, 'ar-run-9-initial')
      assert.deepEqual(actions, [
        ['init', source],
        ['fork', 'ar-run-9-initial', 'main'],
      ])
    })
  })

  it('does not initialize a project whose home entry already exists', async () => {
    await withTemp(async root => {
      const home = join(root, 'home')
      await mkdir(join(home, 'proj'), { recursive: true })
      // A non-empty entry is a real project; only an empty leftover is removed.
      await writeFile(join(home, 'proj', 'owner'), 'layerfs\n')
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions: any[] = []
      const client = {
        options: { home },
        project: { async init() { actions.push('init') } },
        branch: { async fork(name: string) { actions.push(['fork', name]) } },
        workspace: {
          async mount() { return { sandbox: '1', path: '/workspaces/1' } },
          async commit() {},
          async unmount() {},
        },
        fs: { async apply() {} },
      }
      const backend = new LayerFSBackend({ client, project: 'proj', output: join(root, 'out'), runId: 'run-10' })
      await backend.baseline(source, 'initial')
      assert.deepEqual(actions, [['fork', 'ar-run-10-initial']])
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
      shellEnv: { collect: execution => ({ G: '7', agent: String((execution.agent as any)?.id ?? '') }) },
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
