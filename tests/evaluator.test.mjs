import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FrozenEvaluator,
  createFrozenEvaluator,
  runEvaluatorProcess,
  scoreValue,
} from '../src/evaluator.js'
import { withTemp, writeStateEvaluator, writeWorkspace } from './helpers.mjs'

async function fixture(root, options = {}) {
  const evaluatorPath = join(root, 'evaluator.mjs')
  await writeStateEvaluator(evaluatorPath)
  const output = join(root, 'output')
  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeWorkspace(workspace, options.state ?? { score: 1, metrics: { score: 1 } })
  const plan = {
    evaluator: evaluatorPath,
    evaluation_seconds: options.evaluationSeconds ?? 10,
    metrics: options.metrics ?? [{ name: 'score', definition: 'fixture score' }],
    selection_metrics: options.selectionMetrics ?? [],
    ...(options.plan ?? {}),
  }
  const frozen = new FrozenEvaluator({ plan, output })
  await frozen.freeze()
  return { root, output, workspace, plan, frozen, evaluatorPath }
}

describe('scoreValue', () => {
  it('accepts finite numbers and numeric strings', () => {
    assert.equal(scoreValue(1), 1)
    assert.equal(scoreValue('2.5'), 2.5)
    assert.equal(scoreValue(-0), -0)
  })

  it('rejects booleans, empty strings, objects, and non-finite values', () => {
    for (const value of [true, false, '', '  ', null, undefined, {}, [], Number.NaN, Infinity, -Infinity, 'abc']) {
      assert.throws(() => scoreValue(value), /must be finite|not a score/)
    }
  })
})

describe('FrozenEvaluator', () => {
  it('freezes a copy outside the candidate and hashes it', async () => {
    await withTemp(async root => {
      const { frozen, evaluatorPath } = await fixture(root)
      assert.notEqual(frozen.script, evaluatorPath)
      assert.match(frozen.hash, /^[0-9a-f]{64}$/)
      assert.equal(await readFile(frozen.script, 'utf8'), await readFile(evaluatorPath, 'utf8'))
    })
  })

  it('evaluates a valid candidate with evidence receipts', async () => {
    await withTemp(async root => {
      const { frozen, workspace, output } = await fixture(root)
      const result = await frozen.evaluate(workspace, join(output, 'eval'))
      assert.equal(result.valid, true)
      assert.equal(result.score, 1)
      assert.match(result.evidence['state.json'], /^[0-9a-f]{64}$/)
      assert.match(result.workspace_manifest_sha256, /^[0-9a-f]{64}$/)
      assert.equal((await stat(join(output, 'eval', 'evaluation.log'))).isFile(), true)
    })
  })

  it('returns invalid for a rejected candidate and malformed output', async () => {
    await withTemp(async root => {
      const { frozen, workspace, output } = await fixture(root, {
        state: { valid: false, score: 0, reason: 'not a real improvement' },
      })
      const rejected = await frozen.evaluate(workspace, join(output, 'eval-1'))
      assert.equal(rejected.valid, false)
      assert.match(rejected.reason, /not a real improvement/)
    })
    await withTemp(async root => {
      const { frozen, workspace, output } = await fixture(root, { state: { rawOutput: 'not json' } })
      const result = await frozen.evaluate(workspace, join(output, 'eval-2'))
      assert.equal(result.valid, false)
      assert.match(result.reason, /not a single JSON object/)
    })
  })

  it('rejects missing required metrics, invalid optional observations, and missing selection metrics', async () => {
    await withTemp(async root => {
      const { frozen, workspace, output } = await fixture(root, {
        state: { score: 1, metrics: { other: 1 } },
      })
      const result = await frozen.evaluate(workspace, join(output, 'eval-1'))
      assert.equal(result.valid, false)
      assert.match(result.reason, /metric score/)
    })
    await withTemp(async root => {
      const { frozen, workspace, output } = await fixture(root, {
        metrics: [{ name: 'score' }, { name: 'optional', optional: true }],
        state: { score: 1, metrics: { score: 1 } },
      })
      const result = await frozen.evaluate(workspace, join(output, 'eval-2'))
      assert.equal(result.valid, true)
    })
    await withTemp(async root => {
      const { frozen, workspace, output } = await fixture(root, {
        metrics: [{ name: 'score' }, { name: 'progress', optional: true }],
        selectionMetrics: [{ name: 'progress', direction: 'maximize' }],
        state: { score: 1, metrics: { score: 1 } },
      })
      const result = await frozen.evaluate(workspace, join(output, 'eval-3'))
      assert.equal(result.valid, false)
      assert.match(result.reason, /selection metric progress/)
    })
  })

  it('rejects evidence outside the workspace, missing evidence, and empty evidence', async () => {
    for (const evidence of [['../outside.txt'], ['missing.txt'], []]) {
      await withTemp(async root => {
        const { frozen, workspace, output } = await fixture(root, {
          state: { score: 1, metrics: { score: 1 }, evidence },
        })
        const result = await frozen.evaluate(workspace, join(output, 'eval'))
        assert.equal(result.valid, false)
        assert.match(result.reason, /Evidence|No evaluation evidence/)
      })
    }
  })

  it('rejects a mutation of the evaluated workspace', async () => {
    await withTemp(async root => {
      const { frozen, workspace, output } = await fixture(root, {
        state: { score: 1, metrics: { score: 1 }, mutate: 'tampered.txt' },
      })
      await assert.rejects(
        frozen.evaluate(workspace, join(output, 'eval')),
        /Evaluator or evaluated workspace changed/,
      )
    })
  })

  it('rejects an evaluator that rewrites its frozen copy', async () => {
    await withTemp(async root => {
      const { frozen, workspace, output } = await fixture(root, {
        state: { score: 1, metrics: { score: 1 }, rewriteEvaluator: true },
      })
      await assert.rejects(
        frozen.evaluate(workspace, join(output, 'eval')),
        /Evaluator or evaluated workspace changed/,
      )
    })
  })

  it('reports timeout and non-zero exits as invalid observations', async () => {
    await withTemp(async root => {
      const { frozen, workspace, output } = await fixture(root, {
        evaluationSeconds: 0.05,
        state: { score: 1, metrics: { score: 1 }, sleepMs: 1000 },
      })
      const result = await frozen.evaluate(workspace, join(output, 'eval-timeout'))
      assert.equal(result.valid, false)
      assert.match(result.reason, /failed or exceeded/)
    })
    await withTemp(async root => {
      const { frozen, workspace, output } = await fixture(root, { state: { exitCode: 7 } })
      const result = await frozen.evaluate(workspace, join(output, 'eval-exit'))
      assert.equal(result.valid, false)
      assert.equal(result.exit_code, 7)
    })
  })

  it('returns immediately when the phase budget is exhausted', async () => {
    await withTemp(async root => {
      const { frozen, workspace, output } = await fixture(root)
      const result = await frozen.evaluate(workspace, join(output, 'eval'), { deadline: 0 })
      assert.equal(result.valid, false)
      assert.match(result.reason, /budget exhausted/)
    })
  })

  it('chooses an interpreter from the extension or the plan', async () => {
    await withTemp(async root => {
      const python = join(root, 'evaluator.py')
      await writeFile(python, 'print("{}")\n')
      const plan = { evaluator: python, evaluation_seconds: 1, metrics: [] }
      const evaluator = new FrozenEvaluator({ plan, output: join(root, 'out') })
      await evaluator.freeze()
      assert.deepEqual(evaluator.argv('/w').slice(0, 4), [process.env.DSH_PYTHON ?? 'python3', '-I', '-B', evaluator.script])
      assert.equal(evaluator.argv('/w').at(-1), '/w')
      evaluator.plan.evaluator_interpreter = ['/custom/python']
      assert.deepEqual(evaluator.argv('/w').slice(0, 3), ['/custom/python', evaluator.script, '/w'])
      evaluator.plan.evaluator_interpreter = '/custom/python -I'
      assert.deepEqual(evaluator.argv('/w').slice(0, 4), ['/custom/python', '-I', evaluator.script, '/w'])
    })
  })

  it('rejects an evaluator modified before evaluation', async () => {
    await withTemp(async root => {
      const { frozen, workspace, output } = await fixture(root)
      await writeFile(frozen.script, '// changed before evaluation\n')
      await assert.rejects(
        frozen.evaluate(workspace, join(output, 'eval')),
        /Evaluator or evaluated workspace changed/,
      )
    })
  })

  it('validates required constructor inputs and freeze ordering', async () => {
    assert.throws(() => new FrozenEvaluator({ plan: {}, output: '/tmp' }), /evaluator/)
    await withTemp(async root => {
      const evaluator = createFrozenEvaluator({
        plan: { evaluator: join(root, 'missing.mjs'), evaluation_seconds: 1, metrics: [] },
        output: join(root, 'out'),
      })
      await assert.rejects(evaluator.evaluate(root, join(root, 'eval')), /frozen/)
    })
  })
})

describe('runEvaluatorProcess', () => {
  it('captures stdout and stderr and reports a spawn failure', async () => {
    await withTemp(async root => {
      const ok = await runEvaluatorProcess({
        argv: [process.execPath, '-e', 'process.stdout.write("out"); process.stderr.write("err")'],
        cwd: root,
        env: process.env,
        timeoutMs: 5000,
        stdoutPath: join(root, 'out.log'),
        stderrPath: join(root, 'err.log'),
      })
      assert.equal(ok.code, 0)
      assert.equal(ok.stdout, 'out')
      assert.equal(ok.stderr, 'err')
      const failed = await runEvaluatorProcess({
        argv: [join(root, 'does-not-exist')],
        cwd: root,
        env: process.env,
        timeoutMs: 1000,
        stdoutPath: join(root, 'out2.log'),
        stderrPath: join(root, 'err2.log'),
      })
      assert.ok(failed.error)
    })
  })
})
