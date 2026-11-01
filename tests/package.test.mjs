import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

async function json(relative_) {
  return JSON.parse(await readFile(join(root, relative_), 'utf8'))
}

/** Every regular file under `directory` (recursive, stable order). */
async function walkFiles(directory) {
  const files = []
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
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

  it('contains no machine-specific absolute path or user name', async () => {
    // A hardcoded absolute home path (or the author's user name) makes the
    // published package unusable on any other machine and leaks the
    // development machine into the artifacts. Every path must be derived or
    // configurable. The needles are assembled so this guard does not flag its
    // own source.
    const forbidden = new RegExp(['/' + 'Users' + '/', 'chen' + 'haonan'].join('|'), 'i')
    const targets = [
      ...await walkFiles(join(root, 'src')),
      ...await walkFiles(join(root, 'tests')),
      ...await walkFiles(join(root, 'locale')),
      ...[
        'README.md',
        'README.zh.md',
        'package.json',
        'cordis.patch.yml',
        'tsconfig.json',
      ].map(name => join(root, name)),
    ]
    for (const path of targets) {
      const text = await readFile(path, 'utf8')
      assert.doesNotMatch(text, forbidden, `${relative(root, path)} must not contain a local path or user name`)
    }
  })

  it('ships no SPEC.md and never lists it in files', async () => {
    await assert.rejects(stat(join(root, 'SPEC.md')), { code: 'ENOENT' })
    const pkg = await json('package.json')
    assert.equal(pkg.files.some(entry => /^SPEC\.md$/i.test(entry)), false)
  })

  it('keeps the real E2E harness portable and contract-faithful', async () => {
    const e2e = await readFile(join(root, 'tests/e2e-real.test.mjs'), 'utf8')
    // Live mounts the real registry contract (`register` + `collect(execution)`)
    // instead of a fake `resolve()` that no `dsh` version implements.
    assert.match(e2e, /ctx\.shellEnv\.collect\(/)
    assert.match(e2e, /\.register\(contributor\)/)
    assert.match(e2e, /callId: 'bash-1'|callId,/)
    // The daemon wrapper's build context is unique and always removed.
    assert.match(e2e, /mkdtempSync\(join\(tmpdir\(\), 'dsh-ar-e2e-runtime-'\)\)/)
    assert.match(e2e, /rmSync\(context, \{ recursive: true, force: true \}\)/)
    assert.doesNotMatch(e2e, /mkdirSync\(join\(tmpdir\(\), 'dsh-ar-e2e-runtime'\)/)
    // Cleanup removes containers by prefix AND by volume, then retries the
    // volume removal.
    assert.match(e2e, /`name=\$\{prefix\}`/)
    assert.match(e2e, /`volume=\$\{volume\}`/)
    assert.match(e2e, /for \(let attempt = 0; attempt < 3; attempt \+= 1\)/)
    const support = await readFile(join(root, 'tests/e2e-support.mjs'), 'utf8')
    assert.match(support, /execFileSync\('docker', \['-H', `unix:\/\/\$\{LAYERFS_DOCKER\}`, 'version'/)
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
