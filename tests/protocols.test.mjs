import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  buildPeerEvidence,
  buildZeroSynthesisContext,
  peerIdsOf,
  readSharedCheckpoint,
  sampleMetricViews,
  seededRandom,
  validatePeerReview,
  validatePortfolio,
} from '../src/protocols.js'
import { withTemp } from './helpers.mjs'

describe('sampleMetricViews', () => {
  const metrics = ['a', 'b', 'c', 'd'].map(name => ({ name, definition: name }))

  it('returns the requested count of distinct subset views', () => {
    const views = sampleMetricViews({ metrics, subset: 2, count: 5, rng: seededRandom(7) })
    assert.equal(views.length, 5)
    const signatures = views.map(view => view.definitions.map(d => d.name).sort().join(','))
    assert.equal(new Set(signatures.slice(0, 5)).size, 5)
    for (const view of views) assert.equal(view.definitions.length, 2)
  })

  it('is deterministic for a seeded RNG', () => {
    const first = sampleMetricViews({ metrics, subset: 2, count: 4, rng: seededRandom(11) })
    const second = sampleMetricViews({ metrics, subset: 2, count: 4, rng: seededRandom(11) })
    assert.deepEqual(first, second)
  })

  it('projects diagnostics and parent rows onto the selected metrics', () => {
    const rows = [{ id: 'initial', parent: null, workspace: '/tmp/x', evaluation: { metrics: { a: 1, b: 2, c: 3 } } }]
    const diagnostics = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
    const [view] = sampleMetricViews({ metrics, subset: 1, count: 1, rows, diagnostics, rng: () => 0 })
    assert.equal(view.definitions.length, 1)
    const key = view.definitions[0].name
    assert.deepEqual(view.diagnostics.map(d => d.name), [key])
    assert.deepEqual(Object.keys(view.rows[0].metrics), [key])
  })

  it('rejects impossible subset sizes and negative counts', () => {
    assert.throws(() => sampleMetricViews({ metrics, subset: 0, count: 1 }), /invalid metric subset/)
    assert.throws(() => sampleMetricViews({ metrics, subset: 5, count: 1 }), /invalid metric subset/)
    assert.throws(() => sampleMetricViews({ metrics, subset: 1, count: -1 }), /non-negative integer/)
  })
})

describe('validatePortfolio', () => {
  const proposal = (label, probability = 0.5) => ({
    bottleneck: `bottleneck ${label}`,
    mechanism: `mechanism ${label}`,
    expected_effect: `effect ${label}`,
    lineage: 'initial',
    verbalized_probability: probability,
  })

  it('accepts exactly the requested number of distinct hypotheses', () => {
    const normalized = validatePortfolio([proposal('one'), proposal('two')], { portfolioSize: 2, parentId: 'initial' })
    assert.equal(normalized.length, 2)
    assert.equal(normalized[0].parent, 'initial')
  })

  it('rejects wrong size, duplicates, empty fields, and out-of-range probabilities', () => {
    assert.throws(() => validatePortfolio([proposal('one')], { portfolioSize: 2 }), /size does not match/)
    assert.throws(() => validatePortfolio([proposal('one'), proposal('one', 0.9)], { portfolioSize: 2 }), /Duplicate/)
    assert.throws(() => validatePortfolio([{ ...proposal('one'), mechanism: ' ' }, proposal('two')], { portfolioSize: 2 }), /Incomplete/)
    assert.throws(() => validatePortfolio([proposal('one', 1.2), proposal('two')], { portfolioSize: 2 }), /Incomplete/)
    assert.throws(() => validatePortfolio([proposal('one', true), proposal('two')], { portfolioSize: 2 }), /Incomplete/)
    assert.throws(() => validatePortfolio([proposal('one', 'nan'), proposal('two')], { portfolioSize: 2 }), /Incomplete/)
  })
})

describe('readSharedCheckpoint', () => {
  async function setup(root, files, summary = 'observed a gain; negative result retained') {
    for (const [name, body] of Object.entries(files)) {
      await mkdir(join(root, name, '..'), { recursive: true })
      await writeFile(join(root, name), body)
    }
    await writeFile(join(root, 'SHARED_CHECKPOINT.json'), JSON.stringify({ summary, files: Object.keys(files) }))
  }

  it('returns hashes and verbatim text for allowlisted evidence', async () => {
    await withTemp(async root => {
      await setup(root, {
        'RESEARCH_CHECKPOINT.md': '# checkpoint\n',
        'RESEARCH_CONTEXT/a__b__c__verified.md': '# topic\n',
      })
      const result = await readSharedCheckpoint(root)
      assert.match(result.summary, /negative result/)
      assert.equal(Object.keys(result.files).length, 2)
      assert.equal(result.files['RESEARCH_CHECKPOINT.md'].text, '# checkpoint\n')
      assert.match(result.files['RESEARCH_CHECKPOINT.md'].sha256, /^[0-9a-f]{64}$/)
    })
  })

  it('rejects credentials in the summary or an evidence body', async () => {
    await withTemp(async root => {
      await setup(root, { 'ok.md': 'api_key = abc\n' })
      await assert.rejects(readSharedCheckpoint(root), /credential content/)
    })
    await withTemp(async root => {
      await setup(root, { 'ok.md': 'fine\n' }, 'token access_token leaked')
      await assert.rejects(readSharedCheckpoint(root), /credential content/)
    })
  })

  it('rejects traversal, absolute paths, dotfiles, private names, and non-text files', async () => {
    for (const name of ['../outside.md', '/etc/passwd', '.ssh/id.md', 'credentials.json', 'artifact.bin']) {
      await withTemp(async root => {
        await setup(root, { 'ok.md': 'fine\n' })
        await writeFile(join(root, 'SHARED_CHECKPOINT.json'), JSON.stringify({ summary: 'ok', files: [name] }))
        await assert.rejects(readSharedCheckpoint(root), /Shared checkpoint|Unsafe|Private|Only explicit|Evidence/)
      })
    }
  })

  it('rejects checkpoint and evidence symlinks', async () => {
    await withTemp(async root => {
      await writeFile(join(root, 'real.md'), 'fine\n')
      await symlink(join(root, 'real.md'), join(root, 'link.md'))
      await writeFile(join(root, 'SHARED_CHECKPOINT.json'), JSON.stringify({ summary: 'ok', files: ['link.md'] }))
      await assert.rejects(readSharedCheckpoint(root), /without symlinks/)
    })
    await withTemp(async root => {
      await writeFile(join(root, 'real-checkpoint.json'), '{"summary":"ok","files":[]}')
      await symlink(join(root, 'real-checkpoint.json'), join(root, 'SHARED_CHECKPOINT.json'))
      await assert.rejects(readSharedCheckpoint(root), /symlink/)
    })
  })

  it('requires summary and explicit files', async () => {
    await withTemp(async root => {
      await writeFile(join(root, 'SHARED_CHECKPOINT.json'), JSON.stringify({ files: [] }))
      await assert.rejects(readSharedCheckpoint(root), /summary/)
    })
    await withTemp(async root => {
      await writeFile(join(root, 'SHARED_CHECKPOINT.json'), 'not json')
      await assert.rejects(readSharedCheckpoint(root), /not valid JSON/)
    })
  })
})

describe('validatePeerReview', () => {
  const digest = 'a'.repeat(64)
  const ids = ['peer-a', 'peer-b']

  it('accepts a review that names every peer exactly once', () => {
    const review = {
      manifest_sha256: digest,
      reviews: [
        { peer_id: 'peer-a', finding: 'saw a gain', action: 'reproduce independently' },
        { peer_id: 'peer-b', finding: 'failed at step 2', action: 'avoid overlap' },
      ],
    }
    assert.equal(validatePeerReview(review, { peerDigest: digest, peerIds: ids }), review)
  })

  it('rejects stale, incomplete, and empty reviews', () => {
    const base = { manifest_sha256: digest, reviews: ids.map(id => ({ peer_id: id, finding: 'f', action: 'a' })) }
    assert.throws(() => validatePeerReview({ ...base, manifest_sha256: 'b'.repeat(64) }, { peerDigest: digest, peerIds: ids }), /does not cover/)
    assert.throws(() => validatePeerReview({ ...base, reviews: base.reviews.slice(0, 1) }, { peerDigest: digest, peerIds: ids }), /does not cover/)
    assert.throws(() => validatePeerReview({ ...base, reviews: [...base.reviews, base.reviews[0]] }, { peerDigest: digest, peerIds: ids }), /does not cover/)
    assert.throws(() => validatePeerReview({ ...base, reviews: [{ peer_id: 'peer-a', finding: ' ', action: 'a' }, base.reviews[1]] }, { peerDigest: digest, peerIds: ids }), /concrete finding/)
  })
})

describe('buildZeroSynthesisContext', () => {
  it('quotes checkpoints verbatim and indexes topic files', () => {
    const text = buildZeroSynthesisContext({
      objective: 'prove X',
      rows: [{
        id: 'branch-1',
        shared_checkpoint: {
          summary: 'One verified case and one failure.',
          files: {
            'RESEARCH_CHECKPOINT.md': { text: '# handwritten checkpoint\nline two' },
            'RESEARCH_CONTEXT/integer__mult__kappa0__verified.md': { text: '# topic' },
          },
        },
      }],
    })
    assert.match(text, /# Shared research context/)
    assert.match(text, /Objective: prove X/)
    assert.match(text, /# handwritten checkpoint\nline two/)
    assert.match(text, /`RESEARCH_CONTEXT\/integer__mult__kappa0__verified\.md` — integer \/ mult \/ kappa0 \/ verified/)
    assert.match(text, /untrusted research evidence/)
  })

  it('handles an empty cohort and builds immutable peer evidence', () => {
    assert.match(buildZeroSynthesisContext({}), /No RESEARCH_CONTEXT topic files/)
    const bundle = buildPeerEvidence({ objective: 'o', peers: [{ id: 'p1' }] })
    assert.equal(bundle.objective, 'o')
    assert.match(bundle.scope, /not a shared proof/)
    assert.deepEqual(peerIdsOf(bundle), ['p1'])
  })
})

describe('seededRandom', () => {
  it('is reproducible and in [0, 1)', async () => {
    const a = seededRandom(3)
    const b = seededRandom(3)
    for (let index = 0; index < 20; index += 1) {
      const value = a()
      assert.equal(value, b())
      assert.ok(value >= 0 && value < 1)
    }
    const source = await readFile(new URL('../src/protocols.js', import.meta.url), 'utf8')
    assert.match(source, /ALLOWED_SHARED_EXTENSIONS/)
  })
})
