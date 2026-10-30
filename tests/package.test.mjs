import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

async function json(relative) {
  return JSON.parse(await readFile(join(root, relative), 'utf8'))
}

describe('package metadata', () => {
  it('declares the compiled ESM bundle, icon, locale exports, and build scripts', async () => {
    const pkg = await json('package.json')
    assert.equal(pkg.name, 'dsh-auto-research')
    assert.equal(pkg.version, '0.2.0')
    assert.equal(pkg.type, 'module')
    assert.equal(pkg.main, 'lib/index.js')
    assert.equal(pkg.types, 'lib/index.d.ts')
    assert.equal(pkg.icon, './icon.svg')
    assert.equal(pkg.scripts.typecheck, 'tsc --noEmit')
    assert.equal(pkg.scripts.build, 'tsc')
    assert.equal(pkg.scripts.test, 'npm run typecheck && npm run build && node --test tests/*.test.mjs')
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.deepEqual(pkg.exports['.'], { types: './lib/index.d.ts', default: './lib/index.js' })
    assert.equal(pkg.exports['./package.json'], './package.json')
    assert.equal(pkg.exports['./src/*'], './src/*')
    assert.equal(pkg.exports['./lib/*'], './lib/*')
    assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
    assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
    assert.equal(pkg.license, 'MIT')
    assert.ok(pkg.devDependencies.typescript)
    assert.ok(pkg.devDependencies['@types/node'])
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

  it('ships TypeScript sources, build outputs, and the strict tsconfig', async () => {
    const sources = [
      'index.ts',
      'provider.ts',
      'runner.ts',
      'layerfs-workspace.ts',
      'evaluator.ts',
      'protocols.ts',
      'policies.ts',
      'types.ts',
    ]
    for (const name of sources) {
      assert.equal((await stat(join(root, 'src', name))).isFile(), true, name)
    }
    const jsSources = (await readdir(join(root, 'src'))).filter(name => name.endsWith('.js'))
    assert.deepEqual(jsSources, [], 'src must only contain TypeScript sources')
    for (const name of sources) {
      const base = name.replace(/\.ts$/, '')
      assert.equal((await stat(join(root, 'lib', `${base}.js`))).isFile(), true, base)
      assert.equal((await stat(join(root, 'lib', `${base}.d.ts`))).isFile(), true, base)
      assert.equal((await stat(join(root, 'lib', `${base}.js.map`))).isFile(), true, base)
      assert.equal((await stat(join(root, 'lib', `${base}.d.ts.map`))).isFile(), true, base)
    }
    const tsconfig = await json('tsconfig.json')
    assert.equal(tsconfig.compilerOptions.strict, true)
    assert.equal(tsconfig.compilerOptions.noUncheckedIndexedAccess, true)
    assert.equal(tsconfig.compilerOptions.exactOptionalPropertyTypes, true)
    assert.equal(tsconfig.compilerOptions.declaration, true)
    assert.equal(tsconfig.compilerOptions.sourceMap, true)
    assert.equal(tsconfig.compilerOptions.declarationMap, true)
    assert.equal(tsconfig.compilerOptions.rewriteRelativeImportExtensions, true)
    assert.equal(tsconfig.compilerOptions.rootDir, 'src')
    assert.equal(tsconfig.compilerOptions.outDir, 'lib')
    assert.match(tsconfig.compilerOptions.target, /^es2024$/i)
    for (const test of ['protocols', 'evaluator', 'workspace', 'runner', 'provider', 'policies', 'package']) {
      assert.equal((await stat(join(root, `tests/${test}.test.mjs`))).isFile(), true, test)
    }
    for (const name of ['README.md', 'README.zh.md', 'LICENSE']) {
      assert.equal((await stat(join(root, name))).isFile(), true, name)
    }
  })

  it('documents the coordinator contract, artifacts, TypeScript build, and LayerFS', async () => {
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
      'TypeScript',
    ]) {
      assert.ok(readme.includes(needle), needle)
    }
    const zh = await readFile(join(root, 'README.zh.md'), 'utf8')
    assert.ok(zh.includes('自动研究'))
    assert.ok(zh.includes('LayerFS'))
  })
})

describe('source policies', () => {
  it('contains the ported policies verbatim and the dsh addendum', async () => {
    const {
      RESEARCH_POLICY,
      RESEARCH_METHODS_POLICY,
      CONTINUE_POLICY,
      SHARED_CONTEXT_POLICY,
      DSH_COORDINATOR_ADDENDUM,
    } = await import('../lib/policies.js')
    assert.match(RESEARCH_POLICY, /^You are the research agent inside Auto Research/)
    assert.match(RESEARCH_POLICY, /RESEARCH_STATUS: needs_input/)
    assert.match(RESEARCH_METHODS_POLICY, /^# Optional research methods/)
    assert.match(RESEARCH_METHODS_POLICY, /## Collaborative evidence sharing/)
    assert.match(CONTINUE_POLICY, /^Continue the research from this session's evidence/)
    assert.match(CONTINUE_POLICY, /phase_budget_reached/)
    assert.match(SHARED_CONTEXT_POLICY, /compact checkpoints verbatim/)
    assert.match(SHARED_CONTEXT_POLICY, /Do not invent a successful result/)
    assert.match(DSH_COORDINATOR_ADDENDUM, /subagent_auto_research/)
    assert.match(DSH_COORDINATOR_ADDENDUM, /\.auto-research-methods\/plan\.json/)
  })
})
