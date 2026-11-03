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
import type { SkillsService } from './types.js';
/** Absolute directory of the packaged skills. */
export declare const SKILLS_ROOT: string;
export declare const COORDINATOR_SKILL = "auto-research";
export declare const WORKER_SKILL = "auto-research-worker";
/** Absolute path of a packaged `SKILL.md`. */
export declare function skillFile(name: string): string;
interface ParsedSkill {
    name: string;
    description: string;
    userInvocable: boolean;
    content: string;
}
/** Split a packaged `SKILL.md` into its frontmatter fields and body. */
export declare function parseSkill(text: string): ParsedSkill;
/** The `ctx.skills` provider shape this bundle registers. */
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
/** @returns the `ctx.skills` candidate for a packaged skill. */
export declare function skillCandidate(name: string, provider?: string): SkillCandidate;
/** Load a packaged skill's body for `ctx.skills`. */
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
 * Register the packaged skills on `ctx.skills`.
 *
 * `list({ cwd })` returns the worker skill inside a live branch checkout and
 * the coordinator skill everywhere else. The registry caches catalogs by cwd,
 * so the returned `invalidate` must run when workers start or stop.
 */
export declare function registerSkills(skills: SkillsService, isWorkerCwd: (cwd: string) => boolean): {
    invalidate: () => void;
};
/** Build the worker prompt: the task itself plus where the instructions live. */
export declare function buildWorkerPrompt({ plan, checkout, }: {
    plan: {
        objective: string;
        worker_prompt: string;
    };
    checkout: string;
}): string;
/**
 * Write the per-branch files a worker reads, and return what was written so
 * {@link removeWorkerFiles} can delete exactly those paths before the branch is
 * evaluated and committed.
 */
export declare function materializeWorkerFiles(checkout: string, files: {
    branch: unknown;
    marker: unknown;
    handoff: string | null;
}): Promise<string[]>;
/**
 * Delete the files {@link materializeWorkerFiles} wrote, then any directory
 * that became empty. A repository's own `.claude/` or `.agents/` content is
 * left untouched: only the written paths are removed.
 */
export declare function removeWorkerFiles(checkout: string, written: readonly string[]): Promise<void>;
/** Whether `cwd` is inside a branch checkout that a running worker owns. */
export declare function insideWorkerCheckout(cwd: string): boolean;
export {};
//# sourceMappingURL=skills.d.ts.map