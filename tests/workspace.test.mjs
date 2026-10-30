import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LayerFSBackend,
  SnapshotBackend,
  WorkspaceManager,
  createWorkspaceManager,
  digestFile,
  freeBytes,
  inventory,
  inventoryBytes,
  jsonDigest,
  jsonEqual,
  loadLayerfs,
  publicRow,
  resolveLayerfsConfig,
  restoreCompletedState,
  retainCompletedState,
  selectPlanWorkspace,
  sha256,
  snapshot,
  writeJsonAtomic,
} from '../lib/layerfs-workspace.js'
import { withTemp, writeWorkspace } from './helpers.mjs'

describe('inventory and snapshot', () => {
  it('hashes regular files and omits runtime, provider, env and shared-method state', async () => {
    await withTemp(async root => {
      await writeWorkspace(root)
      await mkdir(join(root, '.auto-research-methods'), { recursive: true })
      await writeFile(join(root, '.auto-research-methods', 'run.json'), '{}')
      await writeFile(join(root, '.env.local'), 'SECRET=1')
      await writeFile(join(root, '.claude'), 'provider')
      await mkdir(join(root, 'SHARED_CONTEXT', 'methods-1'), { recursive: true })
      await writeFile(join(root, 'SHARED_CONTEXT', 'methods-1', 'raw.md'), 'raw')
      await writeFile(join(root, 'SHARED_CONTEXT', 'peer.md'), 'peer')
      await mkdir(join(root, 'sub'), { recursive: true })
      await writeFile(join(root, 'sub', 'nested.txt'), 'nested')
      const files = await inventory(root)
      assert.deepEqual(Object.keys(files).sort(), ['SHARED_CONTEXT/peer.md', 'notes.md', 'state.json', 'sub/nested.txt'])
      assert.equal(files['notes.md'], sha256('# notes\n'))
      assert.equal(await inventoryBytes(root, files), (await readFile(join(root, 'notes.md'))).length
        + (await readFile(join(root, 'state.json'))).length
        + 'peer'.length + 'nested'.length)
    })
  })

  it('rejects symlinks and non-regular entries', async () => {
    await withTemp(async root => {
      await writeWorkspace(root)
      await symlink(join(root, 'notes.md'), join(root, 'link.md'))
      await assert.rejects(inventory(root), /materializing symlinks/)
    })
  })

  it('copies a workspace atomically and verifies the copy', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const destination = join(root, 'branches', 'one', 'workspace')
      const manifest = await snapshot(source, destination)
      assert.deepEqual(await inventory(destination), manifest)
      await assert.rejects(snapshot(source, destination), /Existing branch is preserved/)
    })
  })

  it('exposes filesystem and JSON helpers', () => {
    assert.equal(sha256('a'), 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb')
    assert.equal(jsonDigest({ b: 1, a: [2] }), sha256('{"a":[2],"b":1}'))
    assert.equal(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true)
    assert.deepEqual(publicRow({ id: 'x', _state: {}, _ownsState: true }), { id: 'x' })
  })
})

describe('snapshot backend and completion checkpoints', () => {
  it('creates baseline and fork copies through the manager', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source, { score: 3, metrics: { score: 3 } })
      const output = join(root, 'out')
      const manager = new WorkspaceManager(new SnapshotBackend({ output }), { output })
      assert.equal(manager.kind, 'snapshot')
      const base = await manager.baseline(source, 'initial')
      const child = await manager.fork(base, 'round-1-continue-1')
      assert.equal(await readFile(join(child.path, 'state.json'), 'utf8'), await readFile(join(base.path, 'state.json'), 'utf8'))
      await manager.commit(child)
      await manager.release(child, { discard: true })
    })
  })

  it('retains each completed file once and restores the evaluated bytes', async () => {
    await withTemp(async root => {
      const workspace = join(root, 'workspace')
      await writeWorkspace(workspace, { score: 4, metrics: { score: 4 } })
      const output = join(root, 'out')
      const before = await inventory(workspace)
      const row = {
        id: 'round-1-explore-1',
        workspace,
        evaluation: {
          valid: true,
          workspace_manifest_sha256: jsonDigest(before),
          evidence: { 'state.json': await digestFile(join(workspace, 'state.json')) },
        },
      }
      const checkpoint = await retainCompletedState(output, row)
      const saved = JSON.parse(await readFile(checkpoint, 'utf8'))
      assert.equal(Object.keys(saved.files).length, 2)
      assert.equal(await readFile(join(output, 'checkpoint-objects', saved.files['notes.md']), 'utf8'), '# notes\n')

      await writeFile(join(workspace, 'state.json'), '{"score":0}\n')
      const restored = await restoreCompletedState(output, checkpoint, {
        id: 'round-1-explore-1-epoch-2',
        workspace,
      })
      assert.equal(restored.retained_completed_id, 'round-1-explore-1')
      assert.equal(restored.pending_workspace, workspace)
      assert.deepEqual(await inventory(restored.workspace), before)
      assert.equal(await readFile(join(restored.workspace, 'state.json'), 'utf8'), JSON.stringify({ score: 4, metrics: { score: 4 } }, null, 2) + '\n')
    })
  })

  it('rejects evidence drift and checkpoint-object drift', async () => {
    await withTemp(async root => {
      const workspace = join(root, 'workspace')
      await writeWorkspace(workspace)
      const output = join(root, 'out')
      await assert.rejects(retainCompletedState(output, {
        id: 'bad',
        workspace,
        evaluation: { valid: true, evidence: { 'state.json': '0'.repeat(64) } },
      }), /evidence drift/)
    })
    await withTemp(async root => {
      const workspace = join(root, 'workspace')
      await writeWorkspace(workspace)
      const output = join(root, 'out')
      const before = await inventory(workspace)
      const checkpoint = await retainCompletedState(output, {
        id: 'good',
        workspace,
        evaluation: { valid: true, workspace_manifest_sha256: jsonDigest(before) },
      })
      const saved = JSON.parse(await readFile(checkpoint, 'utf8'))
      await chmod(join(output, 'checkpoint-objects', saved.files['notes.md']), 0o644)
      await writeFile(join(output, 'checkpoint-objects', saved.files['notes.md']), 'tampered')
      await assert.rejects(restoreCompletedState(output, checkpoint, { id: 'next', workspace }), /object drift/)
    })
  })
})

function fakeLayerfs(root, actions) {
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
}

describe('LayerFS backend', () => {
  it('forks, mounts, copies the baseline, commits and discards rejected states', async () => {
    await withTemp(async root => {
      const source = join(root, 'source')
      await writeWorkspace(source)
      const actions = []
      const backend = new LayerFSBackend({
        client: fakeLayerfs(root, actions),
        project: 'p',
        output: join(root, 'out'),
        runId: 'run-1',
        ownsClient: true,
      })
      const manager = new WorkspaceManager(backend, { output: join(root, 'out') })
      assert.equal(manager.kind, 'layerfs')
      const base = await manager.baseline(source, 'initial')
      assert.equal(base.branch, 'ar-run-1-initial')
      assert.equal(await readFile(join(base.path, 'notes.md'), 'utf8'), '# notes\n')
      const child = await manager.fork(base, 'round-1-continue-1')
      assert.equal(child.branch, 'ar-run-1-round-1-continue-1')
      await manager.commit(child, { message: 'verified' })
      await manager.release(child, { discard: true })
      await manager.close()
      assert.deepEqual(actions, [
        ['fork', 'ar-run-1-initial', 'main'],
        ['mount', 'ar-run-1-initial'],
        ['commit', 'sandbox-1', 'auto-research: baseline initial'],
        ['fork', 'ar-run-1-round-1-continue-1', 'ar-run-1-initial'],
        ['mount', 'ar-run-1-round-1-continue-1'],
        ['commit', 'sandbox-1', 'verified'],
        ['unmount', 'sandbox-1', true],
        ['close'],
      ])
    })
  })

  it('adopts a saved LayerFS branch and refuses adoption on snapshot backends', async () => {
    await withTemp(async root => {
      const actions = []
      const output = join(root, 'out')
      const backend = new LayerFSBackend({
        client: fakeLayerfs(root, actions),
        project: 'p',
        output,
        runId: 'run-1',
      })
      const adopted = await backend.adopt('ar-run-1-round-1-continue-1', 'initial')
      assert.equal(adopted.branch, 'ar-run-1-round-1-continue-1')
      assert.match(adopted.path, /ar-run-1-round-1-continue-1/)
      assert.deepEqual(actions, [['mount', 'ar-run-1-round-1-continue-1']])
      const snapshotOutput = join(root, 'snapshot')
      const snapshotManager = new WorkspaceManager(
        new SnapshotBackend({ output: snapshotOutput }),
        { output: snapshotOutput },
      )
      await assert.rejects(snapshotManager.adopt('branch', 'initial'), /cannot adopt/)
    })
  })

  it('rejects incomplete LayerFS clients and parent branches', async () => {
    assert.throws(() => new LayerFSBackend({ client: {}, output: '/tmp' }), /requires branch.fork/)
    const backend = new LayerFSBackend({ client: fakeLayerfs('/tmp', []), output: '/tmp' })
    await assert.rejects(backend.fork({ id: 'x' }, 'child'), /parent branch/)
  })
})

describe('LayerFS configuration', () => {
  it('resolves project settings from DSH_LAYERFS_* variables', () => {
    const config = resolveLayerfsConfig({
      DSH_LAYERFS_PROJECT: 'proj',
      DSH_LAYERFS_SDK: 'file:///sdk/index.js',
      DSH_LAYERFS_OPERATOR: 'file:///sdk/operator.js',
      DSH_LAYERFS_STORE_PATH: '/store',
    })
    assert.equal(config.project, 'proj')
    assert.equal(config.storePath, '/store')
    assert.equal(resolveLayerfsConfig({}), null)
    assert.equal(resolveLayerfsConfig({ DSH_LAYERFS_PROJECT: 'x' }, false), null)
  })

  it('falls back to the snapshot backend without a project', async () => {
    await withTemp(async root => {
      const manager = await createWorkspaceManager({ output: join(root, 'out'), runId: 'r', env: {} })
      assert.equal(manager.kind, 'snapshot')
    })
  })

  it('imports an SDK module and constructs client + operator', async () => {
    await withTemp(async root => {
      const sdk = join(root, 'sdk.mjs')
      await writeFile(sdk, `
export class LayerFS {
  constructor(project, options) { this.projectName = project; this.options = options }
  async close() {}
}
export class LayerFSOperator { constructor(client) { this.client = client } }
`)
      const loaded = await loadLayerfs({
        project: 'proj',
        sdk,
        operator: sdk,
        storePath: '/store',
        home: '/home',
      })
      assert.equal(loaded.client.projectName, 'proj')
      assert.equal(loaded.client.options.storePath, '/store')
      assert.equal(loaded.operator.client, loaded.client)
      await assert.rejects(loadLayerfs({ project: 'p', sdk: join(root, 'missing.mjs') }))
    })
  })
})

describe('selectPlanWorkspace', () => {
  it('accepts a compact contained subdirectory', async () => {
    await withTemp(async root => {
      await mkdir(join(root, 'SEED'), { recursive: true })
      assert.equal(await selectPlanWorkspace(root, { workspace: 'SEED' }), await import('node:fs/promises').then(m => m.realpath(join(root, 'SEED'))))
      assert.equal(await selectPlanWorkspace(root, {}), root)
    })
  })

  it('rejects absolute paths, traversal, runtime directories and symlinks', async () => {
    await withTemp(async root => {
      await mkdir(join(root, 'real'), { recursive: true })
      await symlink(join(root, 'real'), join(root, 'link'))
      for (const workspace of ['/absolute', '../up', '.auto-research-methods', 'a/../b', 'link', '.']) {
        await assert.rejects(selectPlanWorkspace(root, { workspace }), /Plan workspace|symlink/)
      }
    })
  })
})

describe('filesystem facts', () => {
  it('reports free space and writes JSON atomically', async () => {
    await withTemp(async root => {
      assert.ok(await freeBytes(root) > 0)
      const target = join(root, 'nested', 'value.json')
      await writeJsonAtomic(target, { a: 1 })
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { a: 1 })
      const info = await lstat(target)
      assert.equal(info.isFile(), true)
    })
  })
})
