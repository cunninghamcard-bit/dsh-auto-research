import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  COORDINATOR_SKILL,
  WORKER_SKILL,
  buildWorkerPrompt,
  insideWorkerCheckout,
  materializeWorkerFiles,
  parseSkill,
  registerSkills,
  removeWorkerFiles,
  skillFile,
} from '../lib/skills.js'
import { withTemp } from './helpers.ts'

describe('packaged skills', () => {
  it('parse with names, descriptions and invocation policy', async () => {
    const coordinator = parseSkill(await readFile(skillFile(COORDINATOR_SKILL), 'utf8'))
    assert.equal(coordinator.name, 'auto-research')
    assert.match(coordinator.description, /subagent_auto_research/)
    assert.equal(coordinator.userInvocable, true)
    assert.match(coordinator.content, /^# Auto research \(coordinator\)/)
    const worker = parseSkill(await readFile(skillFile(WORKER_SKILL), 'utf8'))
    assert.equal(worker.name, 'auto-research-worker')
    assert.equal(worker.userInvocable, false)
    assert.match(worker.content, /BRANCH\.json/)
  })

  it('carry no instructions from the macOS application', async () => {
    for (const name of [COORDINATOR_SKILL, WORKER_SKILL]) {
      const text = await readFile(skillFile(name), 'utf8')
      assert.doesNotMatch(text, /macOS|external SSD|Daytona|ResearchMethods\.py|RESEARCH_STATUS|RESEARCH_METHOD_PLAN/, name)
    }
  })
})

describe('registerSkills', () => {
  it('lists the worker skill inside a worker checkout and the coordinator skill elsewhere', async () => {
    let factory: any = null
    let invalidated = 0
    const handle = registerSkills({ registerProvider: (value: any) => { factory = value } } as any, cwd => cwd.startsWith('/work/branch'))
    const provider = factory({ invalidate: () => { invalidated += 1 }, signal: new AbortController().signal })
    assert.equal(provider.name, 'dsh-auto-research')

    const coordinator = await provider.list({ cwd: '/repo' })
    assert.deepEqual(coordinator.map((entry: any) => entry.name), ['auto-research'])
    const worker = await provider.list({ cwd: '/work/branch/src' })
    assert.deepEqual(worker.map((entry: any) => entry.name), ['auto-research-worker'])
    assert.deepEqual(worker[0].invocation, { modelInvocable: true, userInvocable: false })

    const loaded = await provider.get(worker[0], {})
    assert.equal(loaded.name, 'auto-research-worker')
    assert.match(loaded.content, /^# Auto research \(branch worker\)/)
    assert.equal(loaded.locator, undefined)

    handle.invalidate()
    assert.equal(invalidated, 1)
  })
})

describe('buildWorkerPrompt', () => {
  it('carries the task and points at the worker skill and BRANCH.json', () => {
    const text = buildWorkerPrompt({
      plan: { objective: 'prove a bounded claim', worker_prompt: 'Run exactly one bounded experiment.' },
      checkout: '/work/branch',
    })
    const lines = text.split('\n')
    assert.equal(lines[0], 'Run exactly one bounded experiment.')
    assert.equal(lines[1], 'Objective: prove a bounded claim')
    assert.equal(lines[2], 'Work only in this branch: /work/branch')
    assert.ok(lines[3]!.includes('`auto-research-worker`'))
    assert.ok(lines[3]!.includes(skillFile(WORKER_SKILL)))
    assert.equal(lines[4], "This branch's parameters: /work/branch/.auto-research-methods/BRANCH.json")
  })
})

describe('worker files', () => {
  it('writes branch files and skills, then removes only what it wrote', async () => {
    await withTemp(async root => {
      // The repository's own Claude settings must survive.
      await mkdir(join(root, '.claude'), { recursive: true })
      await writeFile(join(root, '.claude', 'settings.json'), '{}\n')
      const written = await materializeWorkerFiles(root, {
        branch: { branch_id: 'b1' },
        marker: { run_id: 'r', branch_id: 'b1' },
        handoff: 'previous output',
      })
      assert.deepEqual(written, [
        '.auto-research-methods/BRANCH.json',
        '.auto-research-methods/WORKER.json',
        '.auto-research-methods/HANDOFF.md',
        '.claude/skills/auto-research-worker/SKILL.md',
        '.agents/skills/auto-research-worker/SKILL.md',
      ])
      assert.equal(JSON.parse(await readFile(join(root, '.auto-research-methods', 'BRANCH.json'), 'utf8')).branch_id, 'b1')
      assert.equal(await readFile(join(root, '.claude/skills/auto-research-worker/SKILL.md'), 'utf8'), await readFile(skillFile(WORKER_SKILL), 'utf8'))
      assert.equal(insideWorkerCheckout(join(root, 'src', 'deep')), true)

      await removeWorkerFiles(root, written)
      assert.deepEqual((await readdir(root)).sort(), ['.claude'])
      assert.deepEqual(await readdir(join(root, '.claude')), ['settings.json'])
      assert.equal(insideWorkerCheckout(root), false)
    })
  })
})
