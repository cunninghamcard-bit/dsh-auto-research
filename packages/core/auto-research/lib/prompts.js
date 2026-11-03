/**
 * Model-facing messages: a fresh worker's prompt and the message that
 * continues a worker's session. The standing instructions are the prompt
 * packages: the coordinator skill, and the worker context that
 * `dsh-auto-research-worker` injects into every running worker's prompt.
 */
import { join } from 'node:path';
/** The branch's parameters, in the worker's scratch folder. */
export function branchFile(scratch) {
    return join(scratch, 'BRANCH.json');
}
/** The first prompt of a fresh worker. */
export function buildWorkerPrompt({ plan, branch, scratch, seconds, portfolioSize }) {
    return [
        plan.worker_prompt,
        '',
        'Objective: ' + plan.objective,
        branch,
        `Your folder for notes and scratch files: ${scratch} (the current directory). It is not part of the project.`,
        `Time: ${Math.round(seconds / 60)} minutes. Commit your best state before then; only committed work is evaluated.`,
        `This branch's parameters: ${branchFile(scratch)}`,
        ...(portfolioSize === null ? [] : [
            `This is an RSI-top branch. Before you change any file, write ${join(scratch, 'PORTFOLIO.json')}: a JSON array of exactly ${portfolioSize} objects, each with non-empty strings bottleneck, mechanism, expected_effect, lineage and a number verbalized_probability in [0, 1], with distinct bottleneck/mechanism/expected_effect triples. Base it on the metric_view in the parameters file. The branch is scored either way; the portfolio is recorded with it.`,
        ]),
    ].join('\n');
}
/** The first message of a continue worker, after the leader worker's own turns. */
export function buildContinueMessage({ plan, leader, ref, scratch, seconds }) {
    return [
        `Your branch ${leader.ref.branch} was selected as the leader with score ${leader.evaluation.score} (${plan.direction}), at commit ${leader.ref.commit}.`,
        `Continue the research for ${Math.round(seconds / 60)} more minutes on a new branch forked from that commit: ${ref.branch}. Work and commit only on this branch; leave ${leader.ref.branch} as it is.`,
        `Your folder is now ${scratch} (the current directory), a copy of your previous one.`,
        `Commit your best state before then; only committed work is evaluated. Updated parameters: ${branchFile(scratch)}`,
    ].join('\n');
}
//# sourceMappingURL=prompts.js.map