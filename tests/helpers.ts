import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Create a temporary directory inside the OS temp root. */
export async function tempDir(prefix = 'dsh-auto-research-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Run `fn(dir)` and always remove the directory. */
export async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await tempDir()
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** A deterministic monotonic clock whose sleep advances instantly. */
export interface FakeClock {
  now: () => number
  sleep: (milliseconds: number) => Promise<void>
  advance: (milliseconds: number) => void
}

export function fakeClock(start = 1000): FakeClock {
  let current = start
  return {
    now: () => current,
    sleep: async milliseconds => {
      current += Math.max(0, milliseconds)
    },
    advance: milliseconds => {
      current += Math.max(0, milliseconds)
    },
  }
}

/**
 * A fake `ctx.subagents` service. The handler runs for every activation and
 * receives `(spec, index)`; its return value becomes `activation.result`.
 *
 * The structural host surface is intentionally loose (`any`) here: tests build
 * partial Cordis contexts and assert on the recorded calls.
 */
export function fakeSubagents(
  handler: (spec: any, index: number) => any,
  names: string[] = ['worker'],
): {
  calls: any[]
  list: () => string[]
  startActivation: (spec: any) => Promise<any>
} {
  const calls: any[] = []
  return {
    calls,
    list: () => [...names],
    async startActivation(spec: any) {
      const index = calls.length
      calls.push(spec)
      let value: any
      try {
        value = await handler(spec, index)
      } catch (error) {
        value = {
          output: [],
          stopReason: 'error',
          diagnostic: error instanceof Error ? error.message : String(error),
        }
      }
      return {
        childId: `child-${index + 1}`,
        result: Promise.resolve(value ?? { output: [], stopReason: 'completed' }),
        async dispose() {},
      }
    },
  }
}

/** Write a Node evaluator that scores `state.json` in the workspace. */
export async function writeStateEvaluator(
  path: string,
  {
    requiredMetrics = ['score'],
    optionalMetrics = [],
    selectionMetrics = [],
  }: {
    requiredMetrics?: string[]
    optionalMetrics?: string[]
    selectionMetrics?: string[]
  } = {},
): Promise<{ requiredMetrics: string[]; optionalMetrics: string[]; selectionMetrics: string[] }> {
  const script = `
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const workspace = process.argv[2]
const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))
if (state.mutate) {
  writeFileSync(join(workspace, state.mutate), 'changed')
}
if (state.rewriteEvaluator) {
  writeFileSync(process.argv[1], '// rewritten by evaluator\\n')
}
if (state.sleepMs) {
  await new Promise(resolve => setTimeout(resolve, state.sleepMs))
}
if (state.exitCode) {
  process.exit(state.exitCode)
}
if (state.rawOutput) {
  process.stdout.write(state.rawOutput)
} else {
  const metrics = { ...(state.metrics ?? { score: state.score }) }
  const valid = state.valid !== false
  process.stdout.write(JSON.stringify({
    valid,
    ...(valid ? {} : { reason: state.reason ?? 'rejected by fixture' }),
    score: state.score ?? 0,
    metrics,
    evidence: state.evidence ?? ['state.json'],
  }) + '\\n')
}
`
  await writeFile(path, script)
  return { requiredMetrics, optionalMetrics, selectionMetrics }
}

/** Write a baseline workspace with state.json and one evidence file. */
export async function writeWorkspace(
  root: string,
  state: Record<string, unknown> = { score: 1, metrics: { score: 1 } },
): Promise<void> {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'state.json'), JSON.stringify(state, null, 2) + '\n')
  await writeFile(join(root, 'notes.md'), '# notes\n')
}

/** Patch the candidate's state.json in place. */
export async function setState(root: string, state: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, 'state.json'), JSON.stringify(state, null, 2) + '\n')
}
