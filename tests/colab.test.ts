import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrozenEvaluator } from '../lib/evaluator.js'
import { ResearchExecutorRegistry } from '../lib/registry.js'
import * as colabPlugin from '../lib/colab/index.js'
import {
  COLAB_WORKER_PY,
  ColabClient,
  ColabExecutor,
  Config as ColabConfig,
  buildColabBootstrapCell,
  createGraphCutBenchmark,
  packWorkspaceFiles,
  resolveColabConfig,
  writeColabConnectionFile,
} from '../lib/colab/index.js'
import { fakePluginContext, withTemp } from './helpers.ts'

interface LiveColabServer {
  endpoint: string
  connectionFile: string
  stop: () => Promise<void>
}

/** Run the packaged queue server (`COLAB_WORKER_PY`) on loopback. */
async function startLocalColabServer(root: string): Promise<LiveColabServer> {
  const token = 'colab-test-secret-token-0123456789abcdef'
  const scriptPath = join(root, 'colab_worker.py')
  const readyFile = join(root, 'ready.json')
  await writeFile(scriptPath, COLAB_WORKER_PY, 'utf8')
  const child: ChildProcess = spawn(
    process.env.DSH_PYTHON ?? 'python3',
    ['-u', scriptPath, '--host', '127.0.0.1', '--port', '0', '--token', token, '--work-root', join(root, 'server-work'), '--ready-file', readyFile],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const info = await readFile(readyFile, 'utf8').then(raw => JSON.parse(raw) as { endpoint?: string }).catch(() => null)
    if (info?.endpoint) {
      const connectionFile = await writeColabConnectionFile(join(root, 'connection.json'), {
        endpoint: info.endpoint,
        token,
        timeoutSeconds: 30,
      })
      return {
        endpoint: info.endpoint,
        connectionFile,
        stop: async () => {
          child.kill('SIGTERM')
          await new Promise<void>(resolvePromise => {
            child.once('close', () => resolvePromise())
            setTimeout(() => { child.kill('SIGKILL'); resolvePromise() }, 1000).unref()
          })
        },
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  child.kill('SIGKILL')
  throw new Error('Timed out waiting for the local Colab queue server')
}

describe('dsh-auto-research/colab plugin', () => {
  it('registers a colab executor that declines without an endpoint, its skill, and DSH_COLAB_* for workers', async () => {
    const registry = new ResearchExecutorRegistry()
    const skillProviders: any[] = []
    const contributors: any[] = []
    const ctx = fakePluginContext({
      researchExecutor: registry,
      skills: { registerProvider(factory: any) { skillProviders.push(factory({ invalidate() {}, signal: new AbortController().signal })) } },
      shellEnv: { register(contributor: any) { contributors.push(contributor); return () => contributors.splice(contributors.indexOf(contributor), 1) } },
    })
    assert.deepEqual(colabPlugin.inject, ['researchExecutor', 'skills'])
    colabPlugin.apply(ctx, { endpoint: null, connectionFile: null })
    assert.deepEqual(registry.list().map(item => [item.name, item.priority]), [['colab', 100]])
    assert.equal(await registry.list()[0]!.create({ config: {}, plan: {} }), null)
    assert.deepEqual((await skillProviders[0].list({ cwd: '/repo' })).map((skill: any) => skill.name), ['auto-research-colab'])
    assert.match((await skillProviders[0].get((await skillProviders[0].list({}))[0], {})).content, /"executor": "colab"/)
    assert.equal(contributors.length, 1)
    assert.match(contributors[0].resolve({}).DSH_COLAB_CLI, /colab[\\/]cli\.js$/)
    ctx.dispose()
    assert.deepEqual(registry.list(), [])
    assert.deepEqual(contributors, [])
  })

  it('validates config, writes mode-0600 connection files, and generates the bootstrap cell', async () => {
    await withTemp(async root => {
      const connPath = await writeColabConnectionFile(join(root, 'conn.json'), {
        endpoint: 'https://example.trycloudflare.com/',
        token: '0123456789abcdef0123456789abcdef',
        timeoutSeconds: 120,
      })
      assert.equal((await stat(connPath)).mode & 0o777, 0o600)
      const resolved = resolveColabConfig({ connectionFile: connPath })
      assert.equal(resolved.endpoint, 'https://example.trycloudflare.com')
      assert.equal(resolved.timeoutSeconds, 120)
      assert.equal('value' in ColabConfig['~standard'].validate({ endpoint: 'http://127.0.0.1:8765' }), true)
      assert.equal('issues' in ColabConfig['~standard'].validate({ endpoint: 'ftp://bad-url' }), true)
      const cell = buildColabBootstrapCell({ port: 9000, tunnel: 'cloudflared' })
      assert.match(cell, /colab_worker\.py/)
    })
  })

  it('rejects a result from a different evaluator than the frozen copy', async () => {
    await withTemp(async root => {
      const workspace = join(root, 'ws')
      await mkdir(workspace, { recursive: true })
      await writeFile(join(workspace, 'candidate.txt'), 'x\n')
      const evaluator = join(root, 'eval.py')
      await writeFile(evaluator, 'print("{}")\n')
      const executor = new ColabExecutor({ endpoint: 'http://127.0.0.1:9', token: 'x'.repeat(32) })
      ;(executor.client as any).evaluate = async () => ({
        ok: true, id: 'j', exit_code: 0, timed_out: false, duration_ms: 1, gpu_name: null,
        stdout: JSON.stringify({ valid: true, score: 99, metrics: {}, evidence: ['candidate.txt'] }),
        stderr: '', evaluator_sha256: '0'.repeat(64), workspace_manifest_sha256: '', workspace_mutated: false,
      })
      const frozen = new FrozenEvaluator({ executor, plan: { evaluator, evaluation_seconds: 5, metrics: [] }, output: join(root, 'out') })
      await frozen.freeze()
      await assert.rejects(frozen.evaluate(workspace, join(root, 'eval')), /different evaluator than the frozen copy/)
    })
  })
})

describe('dsh-auto-research/colab against a local queue server', () => {
  let server: LiveColabServer | null = null
  let serverRoot = ''

  before(async () => {
    serverRoot = await mkdtemp(join(tmpdir(), 'dsh-colab-suite-'))
    server = await startLocalColabServer(serverRoot)
  })

  after(async () => {
    await server?.stop()
    if (serverRoot) await rm(serverRoot, { recursive: true, force: true })
  })

  it('enforces Bearer token authentication and reports queue health', async () => {
    const health = await new ColabClient({ connectionFile: server!.connectionFile }).health()
    assert.equal(health.ok, true)
    assert.equal(health.queue_depth, 0)
    const bad = new ColabClient({ endpoint: server!.endpoint, token: 'wrong-token-value-1234567890' })
    await assert.rejects(() => bad.health(), /401|Unauthorized/)
  })

  it('omits secrets when packing and serializes concurrent jobs on the queue', async () => {
    await withTemp(async root => {
      const branches = ['A', 'B', 'C'].map(name => [join(root, `branch-${name}`), name] as const)
      for (const [dir, name] of branches) {
        await mkdir(join(dir, '.ssh'), { recursive: true })
        await writeFile(join(dir, '.env'), 'SECRET_KEY=123\n')
        await writeFile(join(dir, '.ssh', 'id_rsa'), 'PRIVATE KEY\n')
        await writeFile(join(dir, 'branch_id.txt'), name)
        await writeFile(join(dir, 'job.py'), [
          'import json, pathlib, time',
          't0 = time.time()',
          'time.sleep(0.15)',
          't1 = time.time()',
          'print(json.dumps({"branch": pathlib.Path("branch_id.txt").read_text().strip(), "t0": t0, "t1": t1, "has_env": pathlib.Path(".env").exists()}))',
        ].join('\n') + '\n')
      }
      const packed = await packWorkspaceFiles(branches[0]![0])
      assert.equal(Object.hasOwn(packed.manifest, '.env'), false)
      assert.equal(Object.hasOwn(packed.manifest, '.ssh/id_rsa'), false)
      const executor = new ColabExecutor({ connectionFile: server!.connectionFile })
      const results = await Promise.all(branches.map(([dir]) => executor.exec(dir, ['python3', 'job.py'])))
      const parsed = results.map(result => {
        assert.equal(result.exit_code, 0)
        return JSON.parse(result.stdout.trim()) as { branch: string; t0: number; t1: number; has_env: boolean }
      })
      assert.deepEqual(parsed.map(entry => entry.branch), ['A', 'B', 'C'])
      for (const entry of parsed) assert.equal(entry.has_env, false)
      const sorted = [...parsed].sort((x, y) => x.t0 - y.t0)
      for (let i = 1; i < sorted.length; i += 1) {
        assert.ok(sorted[i]!.t0 >= sorted[i - 1]!.t1 - 0.02, `jobs overlapped: ${JSON.stringify(sorted)}`)
      }
    })
  })

  it('runs FrozenEvaluator on Colab for the graph-cut benchmark', async () => {
    await withTemp(async root => {
      const benchmark = await createGraphCutBenchmark(join(root, 'graph-cut'), { seed: 7, n: 12, executor: 'colab' })
      assert.equal((benchmark.plan as any).options.executor, 'colab')
      const frozen = new FrozenEvaluator({
        executor: new ColabExecutor({ connectionFile: server!.connectionFile }),
        plan: {
          evaluator: benchmark.evaluatorPath,
          evaluation_seconds: 30,
          metrics: [{ name: 'cut' }, { name: 'gain' }, { name: 'best_probe' }, { name: 'unique_probes' }, { name: 'distinct_probe_scores' }],
          selection_metrics: [{ name: 'cut', direction: 'maximize' }],
        },
        output: join(root, 'frozen-out'),
      })
      await frozen.freeze()
      const base = await frozen.evaluate(benchmark.workspace, join(root, 'eval-base'))
      assert.equal(base.valid, true, String(base.reason))
      assert.equal(base.score, benchmark.baselineScore)
      assert.match(await readFile(join(root, 'eval-base', 'evaluation.log'), 'utf8'), /"valid": true|"valid":true/)

      const optimum = Array.from({ length: 12 }, (_, index) => (benchmark.optimumLeftVertices.includes(index) ? 1 : 0))
      await writeFile(benchmark.candidatePath, JSON.stringify(optimum) + '\n')
      const best = await frozen.evaluate(benchmark.workspace, join(root, 'eval-opt'))
      assert.equal(best.valid, true, String(best.reason))
      assert.equal(best.score, benchmark.optimumScore)
    })
  })

  it('rejects an evaluation that mutates the uploaded workspace', async () => {
    await withTemp(async root => {
      const workspace = join(root, 'ws')
      await mkdir(workspace, { recursive: true })
      await writeFile(join(workspace, 'candidate.txt'), 'clean\n')
      const evaluator = join(root, 'mutating_eval.py')
      await writeFile(evaluator, [
        'import json, pathlib, sys',
        'root = pathlib.Path(sys.argv[-1])',
        '(root / "candidate.txt").write_text("tampered\\n")',
        'print(json.dumps({"valid": True, "score": 99, "metrics": {}, "evidence": ["candidate.txt"]}))',
      ].join('\n') + '\n')
      const frozen = new FrozenEvaluator({
        executor: new ColabExecutor({ connectionFile: server!.connectionFile }),
        plan: { evaluator, evaluation_seconds: 10, metrics: [] },
        output: join(root, 'out'),
      })
      await frozen.freeze()
      await assert.rejects(frozen.evaluate(workspace, join(root, 'eval')), /workspace changed on Colab/)
    })
  })
})
