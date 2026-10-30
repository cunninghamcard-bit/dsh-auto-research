import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import {
  FrozenEvaluator,
  runEvaluatorProcess,
} from '../lib/evaluator.js'
import { withTemp, writeWorkspace } from './helpers.mjs'

describe('extensionless evaluator classification', () => {
  async function freeze(root, body, name = 'evaluator') {
    const source = join(root, name)
    await fsp.writeFile(source, body)
    const evaluator = new FrozenEvaluator({
      plan: { evaluator: source, evaluation_seconds: 1, metrics: [] },
      output: join(root, 'out'),
    })
    await evaluator.freeze()
    return evaluator
  }

  it('chooses Python for a python shebang', async () => {
    await withTemp(async root => {
      const evaluator = await freeze(root, '#!/usr/bin/env python3\nprint("{}")\n')
      assert.match(evaluator.script, /\.py$/)
      assert.deepEqual(evaluator.argv('/w').slice(0, 4), [process.env.DSH_PYTHON ?? 'python3', '-I', '-B', evaluator.script])
    })
  })

  it('chooses Node for a node shebang', async () => {
    await withTemp(async root => {
      const evaluator = await freeze(root, '#!/usr/bin/env node\nprocess.stdout.write("{}")\n')
      assert.match(evaluator.script, /\.js$/)
      assert.equal(evaluator.argv('/w')[0], process.execPath)
      assert.equal(evaluator.argv('/w')[1], evaluator.script)
    })
  })

  it('defaults an unrecognized shebang to Python, like ara', async () => {
    await withTemp(async root => {
      const evaluator = await freeze(root, 'print("{}")\n')
      assert.match(evaluator.script, /\.py$/)
      assert.equal(evaluator.argv('/w')[0], process.env.DSH_PYTHON ?? 'python3')
    })
  })
})

describe('runEvaluatorProcess robustness', () => {
  it('settles even when its log directory cannot be written', async () => {
    await withTemp(async root => {
      const blocker = join(root, 'blocker')
      await fsp.writeFile(blocker, 'not a directory\n')
      const result = await runEvaluatorProcess({
        argv: [process.execPath, '-e', 'process.stdout.write("ok")'],
        cwd: root,
        env: process.env,
        timeoutMs: 5000,
        stdoutPath: join(blocker, 'out.log'),
        stderrPath: join(blocker, 'err.log'),
      })
      assert.equal(result.code, 0)
      assert.equal(result.stdout, 'ok')
    })
  })

  it('reports a timeout and kills the process group', async () => {
    await withTemp(async root => {
      const result = await runEvaluatorProcess({
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
        cwd: root,
        env: process.env,
        timeoutMs: 30,
        stdoutPath: join(root, 'timeout.out.log'),
        stderrPath: join(root, 'timeout.err.log'),
      })
      assert.equal(result.timedOut, true)
      assert.notEqual(result.code, 0)
    })
  })

  it('reports aborts through the signal', async () => {
    await withTemp(async root => {
      const controller = new AbortController()
      const running = runEvaluatorProcess({
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
        cwd: root,
        env: process.env,
        timeoutMs: 5000,
        signal: controller.signal,
        stdoutPath: join(root, 'abort.out.log'),
        stderrPath: join(root, 'abort.err.log'),
      })
      setTimeout(() => controller.abort(), 20)
      const result = await running
      assert.equal(result.aborted, true)
    })
  })

  it('accepts a custom spawn implementation that throws synchronously', async () => {
    await withTemp(async root => {
      const result = await runEvaluatorProcess({
        argv: ['missing'],
        cwd: root,
        env: process.env,
        timeoutMs: 100,
        stdoutPath: join(root, 'spawn.out.log'),
        stderrPath: join(root, 'spawn.err.log'),
        spawn: () => { throw new Error('spawn refused') },
      })
      assert.match(result.error.message, /spawn refused/)
    })
  })
})

describe('frozen evaluator edge cases', () => {
  it('accepts an array or string interpreter override', async () => {
    await withTemp(async root => {
      const source = join(root, 'evaluator.mjs')
      await fsp.writeFile(source, 'process.stdout.write("{}")\n')
      const evaluator = new FrozenEvaluator({
        plan: { evaluator: source, evaluation_seconds: 1, metrics: [], evaluator_interpreter: ['/custom/python'] },
        output: join(root, 'out'),
      })
      await evaluator.freeze()
      assert.deepEqual(evaluator.argv('/w'), ['/custom/python', evaluator.script, '/w'])
      evaluator.plan.evaluator_interpreter = '/custom/python -I'
      assert.deepEqual(evaluator.argv('/w'), ['/custom/python', '-I', evaluator.script, '/w'])
    })
  })

  it('rejects an empty evaluator output and a workspace mutation after the run', async () => {
    await withTemp(async root => {
      const source = join(root, 'evaluator.mjs')
      await fsp.writeFile(source, 'process.stdout.write("")\n')
      const workspace = join(root, 'workspace')
      await writeWorkspace(workspace)
      const evaluator = new FrozenEvaluator({
        plan: { evaluator: source, evaluation_seconds: 1, metrics: [] },
        output: join(root, 'out'),
      })
      await evaluator.freeze()
      const result = await evaluator.evaluate(workspace, join(root, 'out', 'eval'))
      assert.equal(result.valid, false)
      assert.match(result.reason, /not a single JSON object/)
    })
  })
})
