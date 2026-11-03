/**
 * Model-facing instructions: packaged skills, the worker prompt, and the
 * message that continues a worker's session.
 *
 * The coordinator loads `auto-research` through `ctx.skills`; a worker gets
 * `auto-research-worker` there while its cwd is a running branch's scratch
 * folder. The prompt names the skill file too, so any provider can read it.
 */
import type { BranchRef, SkillsService } from 'dsh-auto-research-api';
import type { ResearchPlan, TrajectoryRow } from './types.js';
/** Absolute directory of the packaged skills. */
export declare const SKILLS_ROOT: string;
export declare const COORDINATOR_SKILL = "auto-research";
export declare const WORKER_SKILL = "auto-research-worker";
/** Absolute path of a packaged `SKILL.md`. */
export declare function skillFile(name: string, root?: string): string;
/** The branch's parameters, in the worker's scratch folder. */
export declare function branchFile(scratch: string): string;
interface ParsedSkill {
    name: string;
    description: string;
    userInvocable: boolean;
    content: string;
}
/** Split a packaged `SKILL.md` into its frontmatter fields and body. */
export declare function parseSkill(text: string): ParsedSkill;
/** The `ctx.skills` candidate shape. */
export interface SkillCandidate {
    name: string;
    description: string;
    invocation: {
        modelInvocable: boolean;
        userInvocable: boolean;
    };
    provider: string;
    source: string;
    rank: number;
    resourceBase: {
        kind: 'directory';
        path: string;
    };
    locator: string;
}
export declare function skillCandidate(name: string, provider?: string, root?: string): SkillCandidate;
export declare function loadSkill(found: SkillCandidate, options: {
    signal?: AbortSignal;
}): Promise<{
    name: string;
    description: string;
    invocation: {
        modelInvocable: boolean;
        userInvocable: boolean;
    };
    provider: string;
    source: string;
    resourceBase: {
        kind: 'directory';
        path: string;
    };
    content: string;
}>;
/**
 * Register the packaged skills. `list({ cwd })` returns the worker skill in a
 * running worker's scratch folder and the coordinator skill everywhere else;
 * the registry caches catalogs by cwd, so `invalidate` runs when workers
 * start or stop.
 */
export declare function registerSkills(skills: SkillsService, isWorkerCwd: (cwd: string) => boolean): {
    invalidate: () => void;
};
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
export {};
//# sourceMappingURL=skills.d.ts.map