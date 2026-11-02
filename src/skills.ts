/**
 * Model-facing instructions as skills.
 *
 * The coordinator loads `auto-research` through `ctx.skills`. Branch workers
 * get `auto-research-worker` two ways: through `ctx.skills` when the worker is
 * a dsh agent whose cwd is a live branch checkout, and as files written into
 * the checkout for external CLIs (`.claude/skills`, `.agents/skills`). The
 * worker prompt carries the task plus the absolute path of the skill file, so
 * every provider can reach it.
 */

import { existsSync, readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillsService } from './types.js'

/** Absolute directory of the packaged skills. */
export const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url))

export const COORDINATOR_SKILL = 'auto-research'
export const WORKER_SKILL = 'auto-research-worker'

/** dsh's rank for packaged (bundled) skills. */
const BUNDLED_SKILL_RANK = 600

/** Runner-owned directory inside a branch checkout; omitted from every inventory. */
const RUNTIME_DIR = '.auto-research-methods'

/** Skill directories external CLIs discover in a project. */
const CLI_SKILL_DIRS = ['.claude/skills', '.agents/skills'] as const

/** Absolute path of a packaged `SKILL.md`. */
export function skillFile(name: string): string {
  return join(SKILLS_ROOT, name, 'SKILL.md')
}

interface ParsedSkill {
  name: string
  description: string
  userInvocable: boolean
  content: string
}

/** Split a packaged `SKILL.md` into its frontmatter fields and body. */
export function parseSkill(text: string): ParsedSkill {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!match) throw new Error('Packaged skill has no frontmatter')
  const fields: Record<string, string> = {}
  for (const line of (match[1] as string).split('\n')) {
    const colon = line.indexOf(':')
    if (colon > 0) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return {
    name: fields.name ?? '',
    description: fields.description ?? '',
    userInvocable: fields['user-invocable'] !== 'false',
    content: text.slice(match[0].length).replace(/^\n+/, ''),
  }
}

/** The `ctx.skills` provider shape this bundle registers. */
interface SkillCandidate {
  name: string
  description: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  provider: string
  source: string
  rank: number
  resourceBase: { kind: 'directory'; path: string }
  locator: string
}

/**
 * Register the packaged skills on `ctx.skills`.
 *
 * `list({ cwd })` returns the worker skill inside a live branch checkout and
 * the coordinator skill everywhere else. The answer depends on which workers
 * are running, so worker results are reported incomplete (never cached) and
 * `invalidate` is returned for the runner to call when workers start or stop.
 */
export function registerSkills(
  skills: SkillsService,
  isWorkerCwd: (cwd: string) => boolean,
): { invalidate: () => void } {
  const candidate = (name: string): SkillCandidate => {
    const parsed = parseSkill(readFileSync(skillFile(name), 'utf8'))
    return {
      name: parsed.name,
      description: parsed.description,
      invocation: { modelInvocable: true, userInvocable: parsed.userInvocable },
      provider: 'dsh-auto-research',
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: join(SKILLS_ROOT, name) },
      locator: skillFile(name),
    }
  }
  const coordinator = [candidate(COORDINATOR_SKILL)]
  const worker = [candidate(WORKER_SKILL)]
  let control: { invalidate: () => void } | null = null
  skills.registerProvider(registration => {
    control = registration
    return {
      name: 'dsh-auto-research',
      async list(options: { cwd?: string }) {
        // The registry caches by cwd; worker register/dispose calls invalidate().
        return options.cwd && isWorkerCwd(options.cwd) ? worker : coordinator
      },
      async get(found: SkillCandidate, options: { signal?: AbortSignal }) {
        const { rank: _rank, locator, ...summary } = found
        const text = await fsp.readFile(locator, { encoding: 'utf8', signal: options.signal })
        return { ...summary, content: parseSkill(text).content }
      },
    }
  })
  return { invalidate: () => control?.invalidate() }
}

/** Build the worker prompt: the task itself plus where the instructions live. */
export function buildWorkerPrompt({
  plan,
  checkout,
}: {
  plan: { objective: string; worker_prompt: string }
  checkout: string
}): string {
  return [
    plan.worker_prompt,
    'Objective: ' + plan.objective,
    'Work only in this branch: ' + checkout,
    `Before anything else, load the skill \`${WORKER_SKILL}\`. If you cannot load skills, read ${skillFile(WORKER_SKILL)}.`,
    `This branch's parameters: ${join(checkout, RUNTIME_DIR, 'BRANCH.json')}`,
  ].join('\n')
}

/**
 * Write the per-branch files a worker reads, and return what was written so
 * {@link removeWorkerFiles} can delete exactly those paths before the branch is
 * evaluated and committed.
 */
export async function materializeWorkerFiles(
  checkout: string,
  files: { branch: unknown; marker: unknown; handoff: string | null },
): Promise<string[]> {
  const written: string[] = []
  const put = async (relative: string, content: string): Promise<void> => {
    const target = join(checkout, relative)
    await fsp.mkdir(dirname(target), { recursive: true })
    await fsp.writeFile(target, content, { mode: 0o600 })
    written.push(relative)
  }
  await put(`${RUNTIME_DIR}/BRANCH.json`, JSON.stringify(files.branch, null, 2) + '\n')
  await put(`${RUNTIME_DIR}/WORKER.json`, JSON.stringify(files.marker, null, 2) + '\n')
  if (files.handoff !== null) await put(`${RUNTIME_DIR}/HANDOFF.md`, files.handoff)
  const skill = await fsp.readFile(skillFile(WORKER_SKILL), 'utf8')
  for (const directory of CLI_SKILL_DIRS) await put(`${directory}/${WORKER_SKILL}/SKILL.md`, skill)
  return written
}

/**
 * Delete the files {@link materializeWorkerFiles} wrote, then any directory
 * that became empty. A repository's own `.claude/` or `.agents/` content is
 * left untouched: only the written paths are removed.
 */
export async function removeWorkerFiles(checkout: string, written: readonly string[]): Promise<void> {
  const directories = new Set<string>()
  for (const relative of written) {
    await fsp.rm(join(checkout, relative), { force: true })
    for (let directory = dirname(relative); directory !== '.'; directory = dirname(directory)) {
      directories.add(directory)
    }
  }
  // Deepest first, so a parent is tried only after its children.
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    await fsp.rmdir(join(checkout, directory)).catch(() => {})
  }
}

/** Whether `cwd` is inside a branch checkout that a running worker owns. */
export function insideWorkerCheckout(cwd: string): boolean {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    if (existsSync(join(directory, RUNTIME_DIR, 'WORKER.json'))) return true
    if (dirname(directory) === directory) return false
  }
}
