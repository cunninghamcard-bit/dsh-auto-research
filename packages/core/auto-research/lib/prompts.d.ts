/**
 * Model-facing messages: a fresh worker's prompt and the message that
 * continues a worker's session. The standing instructions are the prompt
 * packages: the coordinator skill, and the worker context that
 * `dsh-auto-research-worker` injects into every running worker's prompt.
 */
import type { BranchRef } from 'dsh-auto-research-api';
import type { ResearchPlan, TrajectoryRow } from './types.js';
/** The branch's parameters, in the worker's scratch folder. */
export declare function branchFile(scratch: string): string;
/** The first prompt of a fresh worker. */
export declare function buildWorkerPrompt({ plan, branch, scratch, seconds, portfolioSize }: {
    plan: ResearchPlan;
    /** The workspace's description of the worker's branch. */
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