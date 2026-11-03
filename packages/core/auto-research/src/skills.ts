/**
 * Model-facing instructions: packaged skills, the worker prompt, and the
 * message that continues a worker's session.
 *
 * The coordinator loads `auto-research` through `ctx.skills`; a worker gets
 * `auto-research-worker` there while its cwd is a running branch's scratch
 * folder. The prompt names the skill file too, so any provider can read it.
 */

import { readFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BranchRef, SkillsService } from 'dsh-auto-research-api'
import type { ResearchPlan, TrajectoryRow } from './types.js'

/** Absolute directory of the packaged skills. */
export const SKILLS_ROOT = fileURLToPath(new URL('../skills/', import.meta.url))

export const COORDINATOR_SKILL = 'auto-research'
export const WORKER_SKILL = 'auto-research-worker'

/** dsh's rank for packaged (bundled) skills. */
const BUNDLED_SKILL_RANK = 600

/** Absolute path of a packaged `SKILL.md`. */
export function skillFile(name: string, root = SKILLS_ROOT): string {
  return join(root, name, 'SKILL.md')
}

/** The branch's parameters, in the worker's scratch folder. */
export function branchFile(scratch: string): string {
  return join(scratch, 'BRANCH.json')
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

/** The `ctx.skills` candidate shape. */
export interface SkillCandidate {
  name: string
  description: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  provider: string
  source: string
  rank: number
  resourceBase: { kind: 'directory'; path: string }
  locator: string
}

export function skillCandidate(name: string, provider = 'dsh-auto-research', root = SKILLS_ROOT): SkillCandidate {
  const parsed = parseSkill(readFileSync(skillFile(name, root), 'utf8'))
  return {
    name: parsed.name,
    description: parsed.description,
    invocation: { modelInvocable: true, userInvocable: parsed.userInvocable },
    provider,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: join(root, name) },
    locator: skillFile(name, root),
  }
}

export async function loadSkill(found: SkillCandidate, options: { signal?: AbortSignal }) {
  const { rank: _rank, locator, ...summary } = found
  const text = await fsp.readFile(locator, { encoding: 'utf8', ...(options.signal ? { signal: options.signal } : {}) })
  return { ...summary, content: parseSkill(text).content }
}

/**
 * Register the packaged skills. `list({ cwd })` returns the worker skill in a
 * running worker's scratch folder and the coordinator skill everywhere else;
 * the registry caches catalogs by cwd, so `invalidate` runs when workers
 * start or stop.
 */
export function registerSkills(skills: SkillsService, isWorkerCwd: (cwd: string) => boolean): { invalidate: () => void } {
  const coordinator = [skillCandidate(COORDINATOR_SKILL)]
  const worker = [skillCandidate(WORKER_SKILL)]
  let control: { invalidate: () => void } | null = null
  skills.registerProvider(registration => {
    control = registration
    return {
      name: 'dsh-auto-research',
      async list(options: { cwd?: string }) {
        return options.cwd && isWorkerCwd(options.cwd) ? worker : coordinator
      },
      get: loadSkill,
    }
  })
  return { invalidate: () => control?.invalidate() }
}

/** The first prompt of a fresh worker. */
export function buildWorkerPrompt({ plan, project, branch, scratch, seconds, portfolioSize }: {
  plan: ResearchPlan
  project: string
  branch: string
  scratch: string
  seconds: number
  /** Set on RSI-top explore branches. */
  portfolioSize: number | null
}): string {
  return [
    plan.worker_prompt,
    '',
    'Objective: ' + plan.objective,
    `Your branch: LayerFS project ${project}, branch ${branch}. Work and commit only on this branch.`,
    `Your folder for notes and scratch files: ${scratch} (the current directory). It is not part of the project.`,
    `Time: ${Math.round(seconds / 60)} minutes. Commit your best state before then; only committed work is evaluated.`,
    `Before anything else, load the skill \`${WORKER_SKILL}\`. If you cannot load skills, read ${skillFile(WORKER_SKILL)}.`,
    `This branch's parameters: ${branchFile(scratch)}`,
    ...(portfolioSize === null ? [] : [
      `This is an RSI-top branch. Before you change any file, write ${join(scratch, 'PORTFOLIO.json')}: a JSON array of exactly ${portfolioSize} objects, each with non-empty strings bottleneck, mechanism, expected_effect, lineage and a number verbalized_probability in [0, 1], with distinct bottleneck/mechanism/expected_effect triples. Base it on the metric_view in the parameters file. research_run refuses to run until it is valid, and a branch without it is rejected however well it scores.`,
    ]),
  ].join('\n')
}

/** The message that continues a leader's worker session for one more turn. */
export function buildContinueMessage({ plan, leader, head, seconds }: {
  plan: ResearchPlan
  leader: TrajectoryRow
  head: BranchRef
  seconds: number
}): string {
  const moved = head.commit !== leader.ref.commit
  return [
    `Your branch ${leader.ref.branch} was selected as the leader with score ${leader.evaluation.score} (${plan.direction}).`,
    moved
      ? `That score is from commit ${leader.ref.commit}; the branch head is now ${head.commit}, which scored lower. Build on the better state.`
      : `It is the branch head, commit ${head.commit}.`,
    `Continue the research for ${Math.round(seconds / 60)} more minutes on the same branch. Commit your best state before then; only committed work is evaluated.`,
    `Updated parameters: ${branchFile(leader.scratch!)}`,
  ].join('\n')
}
