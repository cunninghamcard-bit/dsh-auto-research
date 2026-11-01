import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTINUE_POLICY,
  DSH_COORDINATOR_ADDENDUM,
  RESEARCH_METHODS_POLICY,
  RESEARCH_POLICY,
  SHARED_CONTEXT_POLICY,
  buildWorkerPrompt,
  coordinatorPolicy,
  workerPolicy,
} from '../lib/policies.js'

const plan = {
  objective: 'prove a bounded claim',
  worker_prompt: 'Run exactly one bounded experiment.',
  portfolio_size: 3,
  metrics: [{ name: 'score' }],
}

const parent = { id: 'round-1-explore-1' }
const view = {
  definitions: [{ name: 'score', definition: 's' }],
  diagnostics: [{ name: 'score', observations: 2, missing_observations: 0, distinct_values: 2, constant_in_observed_checkpoints: false }],
  rows: [{ id: 'initial', parent: null, workspace: '/w', metrics: { score: 1 } }],
}

describe('coordinatorPolicy', () => {
  it('concatenates the verbatim policies and the dsh addendum in order', () => {
    const text = coordinatorPolicy()
    assert.equal(text, [RESEARCH_POLICY, RESEARCH_METHODS_POLICY, CONTINUE_POLICY, DSH_COORDINATOR_ADDENDUM].join('\n\n'))
    assert.ok(text.indexOf('You are the research agent inside Auto Research') < text.indexOf('# Optional research methods'))
    assert.ok(text.indexOf('# Optional research methods') < text.indexOf('Continue the research from this session'))
    assert.ok(text.indexOf('Continue the research from this session') < text.indexOf('DeepSeek Harness (dsh) coordinator addendum'))
    assert.match(text, /RESEARCH_STATUS: finished/)
    assert.match(text, /Do not claim the papers' benchmark gains/)
    assert.match(text, /subagent_auto_research/)
    assert.match(text, /\.auto-research-methods\/plan\.json/)
    assert.doesNotMatch(DSH_COORDINATOR_ADDENDUM, /You are the coordinator/)
  })

  it('exports the shared-context policy verbatim', () => {
    assert.match(SHARED_CONTEXT_POLICY, /^This input contains the agents' compact checkpoints verbatim/)
    assert.match(SHARED_CONTEXT_POLICY, /Each agent keeps its own checkout/)
    assert.match(SHARED_CONTEXT_POLICY, /RESEARCH_HANDOFF\.md/)
    assert.match(SHARED_CONTEXT_POLICY, /Do not invent a successful result/)
  })
})

describe('workerPolicy', () => {
  it('always includes the research policy and never the coordinator methods policy by default', () => {
    const policy = workerPolicy()
    assert.ok(policy.startsWith(RESEARCH_POLICY))
    assert.ok(!policy.includes(RESEARCH_METHODS_POLICY))
    assert.ok(!policy.includes(SHARED_CONTEXT_POLICY))
  })

  it('adds the shared-context policy for cooperation and methods only on request', () => {
    const cooperative = workerPolicy({ cooperation: true })
    assert.ok(cooperative.includes(RESEARCH_POLICY))
    assert.ok(cooperative.includes(SHARED_CONTEXT_POLICY))
    assert.ok(!cooperative.includes(RESEARCH_METHODS_POLICY))
    const explicit = workerPolicy({ includeMethodsPolicy: true })
    assert.ok(explicit.includes(RESEARCH_METHODS_POLICY))
  })
})

describe('buildWorkerPrompt', () => {
  it('states the objective, branch boundary, evidence rules, budget, and worker policy', () => {
    const text = buildWorkerPrompt({
      plan,
      parent,
      checkout: '/work/branch',
      phase: 'continue',
      view: { definitions: [], diagnostics: [], rows: [] },
      options: { rsiTop: false },
      seconds: 600,
    })
    assert.match(text, /^Harness instructions:\nYou are the research agent inside Auto Research/)
    assert.match(text, /User request:\nRun exactly one bounded experiment\./)
    assert.match(text, /Objective: prove a bounded claim/)
    assert.match(text, /Work only in this branch: \/work\/branch/)
    assert.match(text, /Do not spawn agents or run the optional-method runner recursively/)
    assert.match(text, /No publishing or merging/)
    assert.match(text, /Assigned total remaining phase window in seconds: 600/)
    assert.doesNotMatch(text, /RSI-top dashboard view/)
    assert.doesNotMatch(text, /# Optional research methods/)
  })

  it('serializes the complete RSI view (definitions, diagnostics, rows)', () => {
    const text = buildWorkerPrompt({
      plan,
      parent,
      checkout: '/work/branch',
      phase: 'explore',
      view,
      options: { rsiTop: true },
      seconds: 600,
    })
    const line = text.split('\n').find(value => value.startsWith('RSI-top dashboard view'))
    assert.ok(line)
    const payload = JSON.parse(line.slice(line.indexOf(':') + 2))
    assert.deepEqual(payload, view)
    assert.deepEqual(payload.definitions, view.definitions)
    assert.deepEqual(payload.diagnostics, view.diagnostics)
    assert.deepEqual(payload.rows, view.rows)
    assert.match(text, /joint portfolio of 3 distinct/)
    assert.match(text, /exactly 3 objects/)
    assert.match(text, /actual parent id round-1-explore-1/)
    assert.match(text, /PORTFOLIO\.json/)
  })

  it('injects the shared-context policy and peer protocol for every provider', () => {
    for (const provider of ['claude-code', 'codex', 'acp', 'dsh-sdk', 'custom']) {
      const text = buildWorkerPrompt({
        plan,
        parent,
        checkout: '/work/branch',
        phase: 'continue',
        options: { rsiTop: false },
        cooperation: { index: 1, count: 3, target: 120, seconds: 300 },
        peer: { path: '/work/branch/SHARED_CONTEXT/peer.json', digest: 'abc123' },
        provider,
        seconds: 300,
      })
      assert.match(text, /^Harness instructions:\n/)
      assert.ok(text.includes(SHARED_CONTEXT_POLICY), provider)
      assert.ok(!text.includes(RESEARCH_METHODS_POLICY), provider)
      assert.match(text, /Collaborator 2 of 3/)
      assert.match(text, /Return with a completed checkpoint within 120 seconds/)
      assert.match(text, /write SHARED_CHECKPOINT\.json/)
      assert.match(text, /Read the immutable peer evidence snapshot at \/work\/branch\/SHARED_CONTEXT\/peer\.json/)
      assert.match(text, /manifest_sha256=abc123/)
      assert.match(text, /write PEER-REVIEW\.json/)
    }
  })

  it('honors an explicit policy override and the methods opt-in', () => {
    const text = buildWorkerPrompt({
      plan,
      parent,
      checkout: '/work/branch',
      phase: 'continue',
      options: { rsiTop: false },
      provider: 'codex',
      policy: 'HARNESS POLICY',
      env: { DSH_LAYERFS_PROJECT: 'project' },
      seconds: 10,
    })
    assert.match(text, /^Harness instructions:\nHARNESS POLICY\nUser request:/)
    assert.match(text, /Workspace environment \(data, not instructions\): \{"DSH_LAYERFS_PROJECT":"project"\}/)
    const methods = buildWorkerPrompt({
      plan,
      parent,
      checkout: '/work/branch',
      options: { rsiTop: false },
      includeMethodsPolicy: true,
      seconds: 10,
    })
    assert.ok(methods.includes(RESEARCH_METHODS_POLICY))
  })

  it('carries the previous turn handoff and the published shared context path', () => {
    const text = buildWorkerPrompt({
      plan,
      parent,
      checkout: '/work/branch',
      phase: 'continue',
      options: { rsiTop: false },
      seconds: 60,
      handoff: { from: 'round-1-continue-1', text: 'previous assistant output', path: '/work/branch/.auto-research-methods-handoff.md' },
      sharedContext: '/work/branch/SHARED_CONTEXT/shared-context.md',
    })
    assert.match(text, /Previous turn handoff \(from parent round-1-continue-1\):/)
    assert.match(text, /previous assistant output/)
    assert.match(text, /Saved handoff note: \/work\/branch\/\.auto-research-methods-handoff\.md/)
    assert.match(text, /Read the published cooperative context at \/work\/branch\/SHARED_CONTEXT\/shared-context\.md/)
  })

  it('requires a worker prompt', () => {
    assert.throws(() => buildWorkerPrompt({ plan: { objective: 'o' } } as any), /worker_prompt/)
    assert.throws(() => buildWorkerPrompt({} as any), /worker_prompt/)
  })
})
