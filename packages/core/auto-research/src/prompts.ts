/**
 * Model-facing messages: a fresh worker's prompt and the message that
 * continues a worker's session. The standing instructions are the prompt
 * packages: the coordinator skill, and the worker context that
 * `dsh-auto-research-worker` injects into every running worker's prompt.
 */

import { join } from 'node:path'
import type { BranchRef } from 'dsh-auto-research-api'
import type { ResearchPlan, TrajectoryRow } from './types.js'

/** The branch's parameters, in the worker's scratch folder. */
export function branchFile(scratch: string): string {
  return join(scratch, 'BRANCH.json')
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
    `This branch's parameters: ${branchFile(scratch)}`,
    ...(portfolioSize === null ? [] : [
      `This is an RSI-top branch. Before you change any file, write ${join(scratch, 'PORTFOLIO.json')}: a JSON array of exactly ${portfolioSize} objects, each with non-empty strings bottleneck, mechanism, expected_effect, lineage and a number verbalized_probability in [0, 1], with distinct bottleneck/mechanism/expected_effect triples. Base it on the metric_view in the parameters file. The branch is scored either way; the portfolio is recorded with it.`,
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
