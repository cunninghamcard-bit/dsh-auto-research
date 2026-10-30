import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildPeerEvidence,
  buildZeroSynthesisContext,
  readSharedCheckpoint,
  readSharedContextFiles,
  sampleMetricViews,
  seededRandom,
  writeSharedContextAtomic,
} from '../lib/protocols.js'
import { SHARED_CONTEXT_POLICY } from '../lib/policies.js'
import { withTemp } from './helpers.mjs'

describe('RSI metric-view sampling at scale', () => {
  const metrics = Array.from({ length: 60 }, (_, index) => ({ name: `m${index}`, definition: `metric ${index}` }))

  it('draws distinct subsets without enumerating a combinatorial explosion', () => {
    const views = sampleMetricViews({ metrics, subset: 3, count: 12, rng: seededRandom(17) })
    assert.equal(views.length, 12)
    const signatures = views.map(view => view.definitions.map(definition => definition.name).sort().join(','))
    assert.equal(new Set(signatures).size, 12)
    for (const view of views) assert.equal(view.definitions.length, 3)
  })

  it('stays deterministic for a seeded RNG and projects diagnostics/rows', () => {
    const rows = [{ id: 'initial', parent: null, workspace: '/w', evaluation: { metrics: { m0: 1, m1: 2 } } }]
    const diagnostics = [{ name: 'm0' }, { name: 'm1' }]
    const first = sampleMetricViews({ metrics, subset: 5, count: 6, rows, diagnostics, rng: seededRandom(3) })
    const second = sampleMetricViews({ metrics, subset: 5, count: 6, rows, diagnostics, rng: seededRandom(3) })
    assert.deepEqual(first, second)
    for (const view of first) {
      const keys = view.definitions.map(definition => definition.name)
      assert.deepEqual(view.diagnostics.map(item => item.name), diagnostics.filter(item => keys.includes(item.name)).map(item => item.name))
      assert.deepEqual(Object.keys(view.rows[0].metrics), keys)
    }
  })

  it('repeats the small combination space when more views than combinations are requested', () => {
    const small = metrics.slice(0, 4)
    const views = sampleMetricViews({ metrics: small, subset: 2, count: 8, rng: seededRandom(9) })
    assert.equal(views.length, 8)
    const signatures = views.map(view => view.definitions.map(definition => definition.name).sort().join(','))
    assert.equal(new Set(signatures).size, 6)
    assert.deepEqual(signatures.slice(0, 2), signatures.slice(6))
  })
})

describe('shared-context fidelity', () => {
  it('starts with the shared-context policy and includes peer checkout/transcript/notes paths', () => {
    const text = buildZeroSynthesisContext({
      objective: 'prove X',
      rows: [{
        id: 'branch-1',
        workspace: '/cohort/checkout-1',
        shared_checkpoint: {
          summary: 'One verified case and one failure.',
          files: {
            'RESEARCH_CHECKPOINT.md': { sha256: 'a'.repeat(64), text: '# handwritten checkpoint\nline two' },
            'RESEARCH_CONTEXT/integer__mult__kappa0__verified.md': { sha256: 'b'.repeat(64), text: '# topic' },
          },
        },
      }],
    })
    assert.ok(text.startsWith(SHARED_CONTEXT_POLICY))
    assert.match(text, /# Shared research context/)
    assert.match(text, /Objective: prove X/)
    assert.match(text, /Checkout: \/cohort\/checkout-1/)
    assert.match(text, /Saved transcript: \/cohort\/checkout-1\/provider\.jsonl/)
    assert.match(text, /Saved notes: \/cohort\/checkout-1\/RESEARCH_HANDOFF\.md/)
    assert.match(text, /# handwritten checkpoint\nline two/)
    assert.match(text, /`RESEARCH_CONTEXT\/integer__mult__kappa0__verified\.md` — integer \/ mult \/ kappa0 \/ verified/)
    assert.match(text, /untrusted research evidence/)
  })

  it('writes shared-context.md atomically with a private mode', async () => {
    await withTemp(async root => {
      const path = join(root, 'SHARED_CONTEXT', 'shared-context.md')
      await writeSharedContextAtomic(path, '# context\n', { mode: 0o600 })
      assert.equal(await readFile(path, 'utf8'), '# context\n')
      assert.equal((await lstat(path)).mode % 512, 384)
      assert.deepEqual((await readdir(join(root, 'SHARED_CONTEXT'))).filter(name => name.endsWith('.new')), [])
    })
  })
})

describe('shared checkpoint auto-discovery', () => {
  async function setup(root, { listed = [], extra = {} } = {}) {
    for (const [name, body] of Object.entries(extra)) {
      await mkdir(join(root, name, '..'), { recursive: true })
      await writeFile(join(root, name), body)
    }
    await writeFile(join(root, 'SHARED_CHECKPOINT.json'), JSON.stringify({
      summary: 'checked one case',
      files: listed,
    }))
  }

  it('adds RESEARCH_CHECKPOINT.md and RESEARCH_CONTEXT/*.md beyond the allowlist', async () => {
    await withTemp(async root => {
      await setup(root, {
        listed: ['evidence.json'],
        extra: {
          'evidence.json': '{"ok":true}\n',
          'RESEARCH_CHECKPOINT.md': '# checkpoint\n',
          'RESEARCH_CONTEXT/a__b__c__verified.md': '# topic a\n',
          'RESEARCH_CONTEXT/ignored.txt': 'not markdown\n',
        },
      })
      const checkpoint = await readSharedCheckpoint(root)
      assert.deepEqual(Object.keys(checkpoint.files).sort(), [
        'RESEARCH_CHECKPOINT.md',
        'RESEARCH_CONTEXT/a__b__c__verified.md',
        'evidence.json',
      ])
      assert.equal(checkpoint.files['RESEARCH_CHECKPOINT.md'].text, '# checkpoint\n')
    })
  })

  it('rejects symlinked context entries and credential content', async () => {
    await withTemp(async root => {
      await setup(root, { extra: { 'real.md': 'fine\n' } })
      await mkdir(join(root, 'RESEARCH_CONTEXT'), { recursive: true })
      await symlink(join(root, 'real.md'), join(root, 'RESEARCH_CONTEXT', 'link.md'))
      await assert.rejects(readSharedCheckpoint(root), /regular files inside the agent checkout/)
    })
    await withTemp(async root => {
      await setup(root, { extra: { 'RESEARCH_CHECKPOINT.md': 'api_key = abc\n' } })
      await assert.rejects(readSharedCheckpoint(root), /credential content/)
    })
    await withTemp(async root => {
      await setup(root, {})
      await symlink(join(root, 'nowhere'), join(root, 'RESEARCH_CONTEXT'))
      await assert.rejects(readSharedCheckpoint(root), /Research context files/)
    })
  })

  it('returns an empty discovery map when neither file exists', async () => {
    await withTemp(async root => {
      assert.deepEqual(await readSharedContextFiles(root), {})
    })
  })

  it('builds immutable peer evidence with every peer id', () => {
    const bundle = buildPeerEvidence({ objective: 'o', peers: [{ id: 'p1' }, { id: 'p2' }] })
    assert.equal(bundle.objective, 'o')
    assert.equal(bundle.peers.length, 2)
    assert.match(bundle.scope, /not a shared proof/)
  })
})
