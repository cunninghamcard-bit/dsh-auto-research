/**
 * Model-facing messages: a fresh worker's prompt and the message that
 * continues a worker's session. The skills themselves are the prompt packages
 * `dsh-auto-research-coordinator` and `dsh-auto-research-worker`.
 */
import type { BranchRef } from 'dsh-auto-research-api';
import type { ResearchPlan, TrajectoryRow } from './types.js';
/** The worker skill, from `dsh-auto-research-worker`. */
export declare const WORKER_SKILL = "auto-research-worker";
/** The branch's parameters, in the worker's scratch folder. */
export declare function branchFile(scratch: string): string;
/** The first prompt of a fresh worker. */
export declare function buildWorkerPrompt({ plan, project, branch, scratch, seconds, portfolioSize }: {
    plan: ResearchPlan;
    project: string;
    branch: string;
    scratch: string;
    seconds: number;
    /** Set on RSI-top explore branches. */
    portfolioSize: number | null;
}): string;
/** The message that continues a leader's worker session for one more turn. */
export declare function buildContinueMessage({ plan, leader, head, seconds }: {
    plan: ResearchPlan;
    leader: TrajectoryRow;
    head: BranchRef;
    seconds: number;
}): string;
//# sourceMappingURL=prompts.d.ts.map