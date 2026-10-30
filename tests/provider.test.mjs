import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AutoResearchProvider,
  NO_START_CAPABILITIES,
  extractPromptText,
  parsePlanFromPrompt,
  resolveConfig,
  resolvePlan,
} from '../lib/provider.js'
import { Config, apply, coordinatorPolicy, name as pluginName, inject } from '../lib/index.js'
import { ResearchStoppedError } from '../lib/runner.js'
import { fakeSubagents, setState, withTemp, writeStateEvaluator, writeWorkspace } from './helpers.mjs'

function planObject(root, extra = {}) {
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

async function fixture(root, { plan = {}, worker = null, config = {} } = {}) {
  const cwd = join(root, 'repo')
  await writeWorkspace(cwd, { score: 1, metrics: { score: 1 } })
  await writeStateEvaluator(join(cwd, 'evaluator.mjs'))
  const value = planObject(cwd, plan)
  await mkdir(join(cwd, '.auto-research-methods'), { recursive: true })
  if (plan !== null) {
    await writeFile(join(cwd, '.auto-research-methods', 'plan.json'), JSON.stringify(value))
  }
  const subagents = fakeSubagents(worker ?? (async spec => {
    await setState(spec.request.cwd, { score: 2, metrics: { score: 2 } })
    return { output: [], stopReason: 'completed' }
  }), ['worker'])
  const provider = new AutoResearchProvider({
    ctx: { subagents, logger: { info() {}, warn() {} } },
    config: {
      workerProvider: 'worker',
      rounds: 1,
      branches: 2,
      explorationMinutes: 0.5,
      exploitationMinutes: 0.5,
      ...config,
    },
  })
  return { cwd, subagents, provider, plan: value }
}


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

describe('provider parsing helpers', () => {
  it('extracts text blocks from prompt content', () => {
    assert.equal(extractPromptText('plain'), 'plain')
    assert.equal(extractPromptText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
    assert.equal(extractPromptText([{ type: 'image' }]), '')
    assert.equal(extractPromptText(null), '')
  })

  it('finds a plan in a fenced block, a PLAN_JSON line, or a bare object', () => {
    const plan = { objective: 'o', evaluator: 'e' }
    assert.deepEqual(parsePlanFromPrompt('```json\n' + JSON.stringify(plan) + '\n```'), plan)
    assert.deepEqual(parsePlanFromPrompt('hello\nPLAN_JSON: ' + JSON.stringify(plan)), plan)
    assert.deepEqual(parsePlanFromPrompt(JSON.stringify(plan)), plan)
    assert.equal(parsePlanFromPrompt('no plan here'), null)
    assert.equal(parsePlanFromPrompt('```json\n{"objective":"o"}\n```'), null)
  })

  it('prefers config, then the plan file, then the prompt', async () => {
    await withTemp(async root => {
      const config = { plan: { objective: 'o', evaluator: 'e' }, planPath: '.auto-research-methods/plan.json' }
      assert.equal((await resolvePlan({ cwd: root, config, promptText: '' })).source, 'config')
    })
    await withTemp(async root => {
      await mkdir(join(root, '.auto-research-methods'), { recursive: true })
      await writeFile(join(root, '.auto-research-methods', 'plan.json'), JSON.stringify({ objective: 'o', evaluator: 'e' }))
      const result = await resolvePlan({ cwd: root, config: { planPath: '.auto-research-methods/plan.json' }, promptText: '' })
      assert.equal(result.source.endsWith('plan.json'), true)
    })
    await withTemp(async root => {
      const result = await resolvePlan({
        cwd: root,
        config: { planPath: '.auto-research-methods/plan.json' },
        promptText: '```json\n{"objective":"o","evaluator":"e"}\n```',
      })
      assert.equal(result.source, 'prompt')
    })
    await withTemp(async root => {
      await assert.rejects(resolvePlan({ cwd: root, config: { planPath: 'none.json' }, promptText: '' }), /No research plan/)
    })
  })
})

describe('plugin entry', () => {
  it('validates config through the standard schema', () => {
    assert.equal(Config['~standard'].validate({}).value.providerName, 'auto-research')
    assert.equal(Config['~standard'].validate({ branches: 2 }).value.branches, 2)
    assert.deepEqual(Config['~standard'].validate(null).value.workerEnv, {})
    assert.equal(resolveConfig({}).rounds, 1)
  })

  it('registers the provider and the coordinator prompt section', () => {
    const registered = []
    const sections = []
    const ctx = {
      subagents: {
        registerProvider(provider) { registered.push(provider) },
      },
      systemPrompt: {
        getSectionOrder(name) { return name === 'PLAN_POLICY' ? 500 : 999 },
        section(section) { sections.push(section) },
      },
    }
    apply(ctx, { branches: 2, rsiTop: false })
    assert.equal(pluginName, 'dsh-auto-research')
    assert.deepEqual(inject, ['subagents', 'systemPrompt'])
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'auto-research')
    assert.equal(registered[0].inheritsParentContext, false)
    assert.equal(registered[0].capabilities, NO_START_CAPABILITIES)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'auto-research:coordinator')
    assert.equal(sections[0].order, 500)
    assert.equal(sections[0].interpolate, false)
    assert.match(sections[0].text, /You are the coordinator/)
    assert.match(sections[0].text, /RESEARCH_STATUS: continue/)
    assert.match(coordinatorPolicy(), /Collaborative evidence sharing/)
  })

  it('falls back to a numeric order when the host lacks getSectionOrder', () => {
    const sections = []
    apply({
      subagents: { registerProvider() {} },
      systemPrompt: { section(section) { sections.push(section) } },
    }, {})
    assert.equal(sections[0].order, 500)
  })
})

describe('AutoResearchProvider', () => {
  it('runs one batch from a plan file and settles through result', async () => {
    await withTemp(async root => {
      const { cwd, provider, subagents } = await fixture(root)
      const controller = new AbortController()
      const handle = await provider.start({
        cwd,
        prompt: [{ type: 'text', text: 'start the batch' }],
        parent: { id: 'parent' },
        signal: controller.signal,
      })
      const result = await handle.result
      assert.equal(result.stopReason, 'completed')
      assert.match(result.output[0].text, /Auto-research batch COMPLETED/)
      assert.match(result.output[0].text, /leader: round-1-continue-1/)
      assert.equal(subagents.calls.length, 1)
      const runs = await readdir(join(cwd, '.auto-research-methods', 'runs'))
      assert.equal(runs.length, 1)
      assert.equal(JSON.parse(await readFile(join(cwd, '.auto-research-methods', 'runs', runs[0], 'RESULT.json'), 'utf8')).status, 'COMPLETED')
      assert.equal(JSON.parse(await readFile(join(cwd, '.auto-research-methods', 'LATEST.json'), 'utf8')).leader_workspace.includes('runs'), true)
      await handle.dispose()
      await handle.dispose()
    })
  })

  it('accepts a plan embedded in the delegation prompt', async () => {
    await withTemp(async root => {
      const cwd = join(root, 'repo')
      await writeWorkspace(cwd, { score: 1, metrics: { score: 1 } })
      await writeStateEvaluator(join(cwd, 'evaluator.mjs'))
      const plan = { ...planObject(cwd), evaluator: 'evaluator.mjs' }
      const subagents = fakeSubagents(async spec => {
        await setState(spec.request.cwd, { score: 5, metrics: { score: 5 } })
        return { output: [], stopReason: 'completed' }
      }, ['worker'])
      const provider = new AutoResearchProvider({ ctx: { subagents, logger: {} }, config: { workerProvider: 'worker' } })
      const handle = await provider.start({
        cwd,
        prompt: [{ type: 'text', text: 'Plan:\n```json\n' + JSON.stringify(plan) + '\n```' }],
        parent: { id: 'parent' },
        signal: new AbortController().signal,
      })
      const result = await handle.result
      assert.equal(result.stopReason, 'completed')
      assert.match(result.output[0].text, /score: 5/)
      await handle.dispose()
    })
  })

  it('rejects setup errors before publication', async () => {
    await withTemp(async root => {
      const cwd = join(root, 'repo')
      await writeWorkspace(cwd, { score: 1, metrics: { score: 1 } })
      const provider = new AutoResearchProvider({
        ctx: { subagents: fakeSubagents(async () => ({ stopReason: 'completed' }), ['worker']) },
        config: { workerProvider: 'worker' },
      })
      await assert.rejects(provider.start({
        cwd,
        prompt: [{ type: 'text', text: 'x' }],
        parent: { id: 'p' },
        signal: new AbortController().signal,
      }), /No research plan/)
      await assert.rejects(provider.start({
        cwd: 'relative',
        prompt: [],
        parent: { id: 'p' },
        signal: new AbortController().signal,
      }), /absolute path/)
      await assert.rejects(provider.start({
        cwd: join(root, 'missing'),
        prompt: [],
        parent: { id: 'p' },
        signal: new AbortController().signal,
      }), /accessible directory/)
    })
  })

  it('rejects missing evaluator, invalid plan, self worker, and missing worker', async () => {
    await withTemp(async root => {
      const cwd = join(root, 'repo')
      await writeWorkspace(cwd, { score: 1, metrics: { score: 1 } })
      await mkdir(join(cwd, '.auto-research-methods'), { recursive: true })
      await writeFile(join(cwd, '.auto-research-methods', 'plan.json'), JSON.stringify({
        ...planObject(cwd), evaluator: join(cwd, 'missing.mjs'),
      }))
      const provider = new AutoResearchProvider({
        ctx: { subagents: fakeSubagents(async () => ({ stopReason: 'completed' }), ['worker']) },
        config: { workerProvider: 'worker' },
      })
      await assert.rejects(provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }), /does not exist/)
    })
    await withTemp(async root => {
      const { cwd } = await fixture(root)
      const provider = new AutoResearchProvider({
        ctx: { subagents: fakeSubagents(async () => ({ stopReason: 'completed' }), ['worker']) },
        config: { workerProvider: 'worker', branches: 1 },
      })
      await assert.rejects(provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }), /branch\/round/)
    })
    await withTemp(async root => {
      const { cwd } = await fixture(root)
      const provider = new AutoResearchProvider({
        ctx: { subagents: { list: () => ['auto-research'], startActivation() {} } },
        config: { workerProvider: 'auto-research' },
      })
      await assert.rejects(provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }), /cannot delegate to itself/)
    })
    await withTemp(async root => {
      const { cwd } = await fixture(root)
      const provider = new AutoResearchProvider({
        ctx: { subagents: { list: () => ['auto-research'], startActivation() {} } },
        config: {},
      })
      await assert.rejects(provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }), /at least one other/)
    })
    await withTemp(async root => {
      const { cwd } = await fixture(root)
      const provider = new AutoResearchProvider({
        ctx: { subagents: { list: () => ['worker'], startActivation() {} } },
        config: { workerProvider: 'missing' },
      })
      await assert.rejects(provider.start({ cwd, prompt: [], parent: { id: 'p' }, signal: new AbortController().signal }), /not registered/)
    })
  })

  it('rejects an already-aborted request and maps cancellation to aborted', async () => {
    await withTemp(async root => {
      const { cwd, provider } = await fixture(root)
      const aborted = new AbortController()
      aborted.abort()
      await assert.rejects(provider.start({
        cwd,
        prompt: [],
        parent: { id: 'p' },
        signal: aborted.signal,
      }), error => error instanceof ResearchStoppedError)
    })
    await withTemp(async root => {
      let startedResolve
      const started = new Promise(resolve => { startedResolve = resolve })
      let release
      const gate = new Promise(resolve => { release = resolve })
      const worker = async spec => {
        startedResolve()
        await gate
        return { output: [], stopReason: spec.signal?.aborted ? 'aborted' : 'completed' }
      }
      const { cwd, provider } = await fixture(root, { worker })
      const handle = await provider.start({
        cwd,
        prompt: [],
        parent: { id: 'p' },
        signal: new AbortController().signal,
      })
      await started
      const disposing = handle.dispose()
      release()
      const result = await handle.result
      await disposing
      assert.equal(result.stopReason, 'aborted')
      assert.match(result.output[0].text, /STOPPED/)
    })
  })

  it('remounts the saved LayerFS leader branch on the next batch', async () => {
    await withTemp(async root => {
      const actions = []
      const client = fakeLayerfs(root, actions)
      const { cwd, provider } = await fixture(root, {
        config: { layerfs: { client, project: 'p' } },
      })
      const first = await provider.start({
        cwd,
        prompt: [],
        parent: { id: 'p' },
        signal: new AbortController().signal,
      })
      await first.result
      await first.dispose()
      const latest = JSON.parse(await readFile(join(cwd, '.auto-research-methods', 'LATEST.json'), 'utf8'))
      assert.match(latest.leader_branch, /-round-1-continue-1$/)
      const before = actions.length
      const second = await provider.start({
        cwd,
        prompt: [],
        parent: { id: 'p' },
        signal: new AbortController().signal,
      })
      const result = await second.result
      assert.equal(result.stopReason, 'completed')
      assert.deepEqual(actions[before], ['mount', latest.leader_branch])
      await second.dispose()
    })
  })

  it('refuses to reuse a changed original workspace', async () => {
    await withTemp(async root => {
      const { cwd, provider } = await fixture(root)
      const first = await provider.start({
        cwd,
        prompt: [],
        parent: { id: 'p' },
        signal: new AbortController().signal,
      })
      await first.result
      await first.dispose()
      await setState(cwd, { score: 9, metrics: { score: 9 } })
      await assert.rejects(provider.start({
        cwd,
        prompt: [],
        parent: { id: 'p' },
        signal: new AbortController().signal,
      }), /Original workspace changed/)
    })
  })
})
