import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LayerFSBackend,
  SnapshotBackend,
  WorkspaceManager,
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
import { withTemp, writeWorkspace, snapshotManager } from './helpers.ts'

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

  it('records symlinks by their text without following them', async () => {
    await withTemp(async root => {
      await writeWorkspace(root)
      await mkdir(join(root, 'pkg'), { recursive: true })
      await writeFile(join(root, 'pkg', 'cli.js'), 'run\n')
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true })
      await symlink('../../pkg/cli.js', join(root, 'node_modules', '.bin', 'cli'))
      // A directory link (venv lib64 -> lib) is one entry, not a second tree.
      await symlink('pkg', join(root, 'lib64'))
      await symlink('/etc/hosts', join(root, '.env'))
      const files = await inventory(root)
      assert.equal(files['node_modules/.bin/cli'], 'symlink:../../pkg/cli.js')
      assert.equal(files['lib64'], 'symlink:pkg')
      assert.equal(files['lib64/cli.js'], undefined)
      assert.equal(files['.env'], undefined, 'an env-looking link stays omitted')

      const copy = join(root, '..', 'copy-' + Date.now())
      try {
        assert.deepEqual(await snapshot(root, copy), files)
        assert.equal((await lstat(join(copy, 'node_modules', '.bin', 'cli'))).isSymbolicLink(), true)
        assert.deepEqual(await inventory(copy), files)
      } finally {
        await rm(copy, { recursive: true, force: true })
      }
    })
  })

  it('rejects non-regular entries other than symlinks', async () => {
    await withTemp(async root => {
      await writeWorkspace(root)
      const fifo = join(root, 'pipe')
      execFileSync('mkfifo', [fifo])
      await assert.rejects(inventory(root), /Non-regular workspace entry/)
    })
  })

  it('keeps symlinks out of checkpoint objects and recreates them on restore', async () => {
    await withTemp(async root => {
      const workspace = join(root, 'workspace')
      await writeWorkspace(workspace)
      await mkdir(join(workspace, 'node_modules', '.bin'), { recursive: true })
      await symlink('../pkg/cli.js', join(workspace, 'node_modules', '.bin', 'cli'))
      const output = join(root, 'out')
      const before = await inventory(workspace)
      const checkpoint = await retainCompletedState(output, {
        id: 'b1',
        workspace,
        evaluation: { valid: true, workspace_manifest_sha256: jsonDigest(before), evidence: {} },
      } as any)
      const saved = JSON.parse(await readFile(checkpoint, 'utf8'))
      assert.deepEqual(saved.links, { 'node_modules/.bin/cli': '../pkg/cli.js' })
      assert.equal(saved.files['node_modules/.bin/cli'], undefined)
      const restored = await restoreCompletedState(output, checkpoint, { id: 'b1-epoch-2', workspace } as any)
      assert.deepEqual(await inventory(restored.workspace), before)

      // A checkpoint from before links were recorded restores without them.
      delete saved.links
      saved.row.evaluation.workspace_manifest_sha256 = jsonDigest(Object.fromEntries(
        Object.entries(before).filter(([name]) => name !== 'node_modules/.bin/cli'),
      ))
      await writeFile(checkpoint, JSON.stringify(saved))
      await restoreCompletedState(output, checkpoint, { id: 'b1-epoch-3', workspace } as any)
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
    assert.deepEqual(publicRow({ id: 'x', _state: {}, _ownsState: true } as any), { id: 'x' })
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
      const row: any = {
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
      } as any)
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
      } as any), /evidence drift/)
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
      } as any)
      const saved = JSON.parse(await readFile(checkpoint, 'utf8'))
      await chmod(join(output, 'checkpoint-objects', saved.files['notes.md']), 0o644)
      await writeFile(join(output, 'checkpoint-objects', saved.files['notes.md']), 'tampered')
      await assert.rejects(restoreCompletedState(output, checkpoint, { id: 'next', workspace } as any), /object drift/)
    })
  })
})

function fakeLayerfs(root: string, actions: any[]): any {
  const mounts = join(root, 'mounts')
  return {
    branch: {
      async fork(name: string, from: string | undefined) {
        actions.push(['fork', name, from])
        await mkdir(join(mounts, name), { recursive: true })
      },
    },
    sandbox: {
      async create() {
        return { sandbox: '1', image: 'sha256:image' }
      },
    },
    workspace: {
      async mount(sandbox: string, name: string) {
        actions.push(['mount', sandbox, name])
        const path = join(mounts, name)
        await mkdir(path, { recursive: true })
        return { sandbox, path }
      },
      async commit(handle: any, message: any) {
        actions.push(['commit', handle.sandbox, message])
        return { kind: 'Committed' }
      },
      async unmount(handle: any, discard: any) {
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
      const actions: any[] = []
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
        ['mount', '1', 'ar-run-1-initial'],
        ['commit', '1', 'auto-research: baseline initial'],
        ['fork', 'ar-run-1-round-1-continue-1', 'ar-run-1-initial'],
        ['mount', '1', 'ar-run-1-round-1-continue-1'],
        ['commit', '1', 'verified'],
        ['unmount', '1', true],
        ['close'],
      ])
    })
  })

  it('adopts a saved LayerFS branch and refuses adoption on snapshot backends', async () => {
    await withTemp(async root => {
      const actions: any[] = []
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
      assert.deepEqual(actions, [['mount', '1', 'ar-run-1-round-1-continue-1']])
      const snapshotOutput = join(root, 'snapshot')
      const snapshotManager = new WorkspaceManager(
        new SnapshotBackend({ output: snapshotOutput }),
        { output: snapshotOutput },
      )
      await assert.rejects(snapshotManager.adopt('branch', 'initial'), /cannot adopt/)
    })
  })

  it('rejects parents without a workspace', async () => {
    const backend = new LayerFSBackend({ client: fakeLayerfs('/tmp', []), output: '/tmp' })
    await assert.rejects(backend.fork({ id: 'x' } as any, 'child'), /parent workspace/)
  })
})

describe('LayerFS configuration', () => {
  it('resolves project settings from DSH_LAYERFS_* variables', () => {
    const config = resolveLayerfsConfig({
      DSH_LAYERFS_PROJECT: 'proj',
      DSH_LAYERFS_SDK: 'file:///sdk/index.js',
      DSH_LAYERFS_STORE_PATH: '/store',
    })!
    assert.equal(config.project, 'proj')
    assert.equal(config.storePath, '/store')
    assert.equal(resolveLayerfsConfig({}), null)
    assert.equal(resolveLayerfsConfig({ DSH_LAYERFS_PROJECT: 'x' }, false), null)
  })

  it('falls back to the snapshot backend without a project', async () => {
    await withTemp(async root => {
      const manager = snapshotManager({ output: join(root, 'out'), runId: 'r', env: {} })
      assert.equal(manager.kind, 'snapshot')
    })
  })

  it('opens the project with LAYERFS_* set from the binding, then restores the environment', async () => {
    await withTemp(async root => {
      const sdk = join(root, 'sdk.mjs')
      await writeFile(sdk, `
export class LayerFS {
  static async open(project) {
    return { project, storePath: process.env.LAYERFS_STORE_PATH, image: process.env.LAYERFS_IMAGE, async close() {} }
  }
}
`)
      process.env.LAYERFS_IMAGE = 'ambient'
      try {
        const client: any = await loadLayerfs({ project: 'proj', sdk, storePath: '/store', home: '/home' } as any)
        assert.equal(client.project, 'proj')
        assert.equal(client.storePath, '/store')
        // A name the binding leaves unset is cleared while the client is made.
        assert.equal(client.image, undefined)
        assert.equal(process.env.LAYERFS_IMAGE, 'ambient')
        assert.equal(process.env.LAYERFS_STORE_PATH, undefined)
      } finally {
        delete process.env.LAYERFS_IMAGE
      }
      await assert.rejects(loadLayerfs({ project: 'p', sdk: join(root, 'missing.mjs') } as any))
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

  it('rejects absolute paths, traversal, runtime directories and links that leave the checkout', async () => {
    await withTemp(async root => {
      const checkout = join(root, 'checkout')
      await mkdir(join(checkout, 'real'), { recursive: true })
      await mkdir(join(root, 'outside'), { recursive: true })
      await symlink(join(checkout, 'real'), join(checkout, 'link'))
      await symlink(join(root, 'outside'), join(checkout, 'away'))
      for (const workspace of ['/absolute', '../up', '.auto-research-methods', 'a/../b', 'away', '.']) {
        await assert.rejects(selectPlanWorkspace(checkout, { workspace }), /Plan workspace/)
      }
      assert.equal(await selectPlanWorkspace(checkout, { workspace: 'link' }), await realpath(join(checkout, 'real')))
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
