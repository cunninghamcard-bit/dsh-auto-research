import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

async function json(relative) {
  return JSON.parse(await readFile(join(root, relative), 'utf8'))
}

describe('package metadata', () => {
  it('declares the ESM bundle, icon, locale exports, and test script', async () => {
    const pkg = await json('package.json')
    assert.equal(pkg.name, 'dsh-auto-research')
    assert.equal(pkg.type, 'module')
    assert.equal(pkg.main, 'src/index.js')
    assert.equal(pkg.icon, './icon.svg')
    assert.equal(pkg.scripts.test, 'node --test tests/*.test.mjs')
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
    assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
    assert.equal(pkg.license, 'MIT')
  })

  it('localizes the plugin title and description', async () => {
    for (const locale of ['en', 'zh']) {
      const value = await json(`locale/${locale}.json`)
      assert.ok(value.meta.title.length > 0)
      assert.ok(value.meta.description.length > 0)
    }
    assert.match((await json('locale/zh.json')).meta.title, /研究/)
  })

  it('ships a 36x36 SVG icon', async () => {
    const svg = await readFile(join(root, 'icon.svg'), 'utf8')
    assert.match(svg, /^<svg width="36" height="36"/)
    assert.match(svg, /viewBox="0 0 36 36"/)
    assert.match(svg, /<title>Auto Research<\/title>/)
  })

  it('declares both bundle rows in the Cordis patch', async () => {
    const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /id: subagent-auto-research/)
    assert.match(patch, /name: 'dsh-auto-research'/)
    assert.match(patch, /id: tool-subagent-auto-research/)
    assert.match(patch, /name: '@deepseek-ai\/dsh-tool-subagent'/)
    assert.match(patch, /provider: auto-research/)
    assert.match(patch, /toolName: subagent_auto_research/)
    assert.match(patch, /maxDepth: provider-managed/)
  })

  it('contains every implementation module and test file', async () => {
    const modules = [
      'src/index.js',
      'src/provider.js',
      'src/runner.js',
      'src/layerfs-workspace.js',
      'src/evaluator.js',
      'src/protocols.js',
      'src/policies.js',
      'README.md',
      'README.zh.md',
      'LICENSE',
    ]
    for (const name of modules) {
      assert.equal((await stat(join(root, name))).isFile(), true, name)
    }
    for (const test of ['protocols', 'evaluator', 'workspace', 'runner', 'provider', 'package']) {
      assert.equal((await stat(join(root, `tests/${test}.test.mjs`))).isFile(), true, test)
    }
  })

  it('documents the coordinator contract, artifacts, and LayerFS', async () => {
    const readme = await readFile(join(root, 'README.md'), 'utf8')
    for (const needle of [
      'subagent_auto_research',
      'plan.json',
      'RESULT.json',
      'DASHBOARD.json',
      'LEADER.json',
      'SELECTIONS.json',
      'SHARED_CHECKPOINT.json',
      'PEER-REVIEW.json',
      'PORTFOLIO.json',
      'LayerFS',
      'RSI-top',
      'fork-and-flush',
    ]) {
      assert.ok(readme.includes(needle), needle)
    }
    const zh = await readFile(join(root, 'README.zh.md'), 'utf8')
    assert.ok(zh.includes('自动研究'))
    assert.ok(zh.includes('LayerFS'))
  })
})

describe('source policies', () => {
  it('contains the ported policies verbatim', async () => {
    const { RESEARCH_POLICY, RESEARCH_METHODS_POLICY, CONTINUE_POLICY } = await import('../src/policies.js')
    assert.match(RESEARCH_POLICY, /^You are the research agent inside Auto Research/)
    assert.match(RESEARCH_POLICY, /RESEARCH_STATUS: needs_input/)
    assert.match(RESEARCH_METHODS_POLICY, /^# Optional research methods/)
    assert.match(RESEARCH_METHODS_POLICY, /## Collaborative evidence sharing/)
    assert.match(CONTINUE_POLICY, /^Continue the research from this session's evidence/)
    assert.match(CONTINUE_POLICY, /phase_budget_reached/)
  })
})
