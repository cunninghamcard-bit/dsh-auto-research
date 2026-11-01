/**
 * Frozen evaluator execution.
 *
 * The evaluator script is copied out of the candidate workspace before any
 * branch runs, and its SHA-256 is checked before and after every evaluation.
 * The evaluated workspace inventory is likewise compared across the process:
 * a checker that mutates the candidate, or a script that changes underneath a
 * run, rejects the observation instead of ranking it.
 */
import { spawn } from 'node:child_process';
import type { EvaluationResult, Logger, MetricDefinition, SelectionMetric } from './types.js';
/** Plan fields the evaluator needs; a full {@link ResearchPlan} satisfies it. */
export interface EvaluatorPlan {
    evaluator: string;
    evaluation_seconds?: number | string;
    metrics?: MetricDefinition[];
    selection_metrics?: SelectionMetric[];
    evaluator_interpreter?: string | string[];
    [key: string]: unknown;
}
/**
 * Parse a finite numeric score. Booleans are not scores; neither is an empty
 * string, a non-finite number, or a value that only coerces to one.
 *
 * String input must be a decimal literal: `"0x10"`, `"0b11"`, `"0o7"` and
 * `"Infinity"` are rejected instead of being silently coerced by `Number`.
 */
export declare function scoreValue(value: unknown, label?: string): number;
/** Result of one evaluator process. */
export interface EvaluatorProcessResult {
    code: number | null;
    timedOut: boolean;
    aborted: boolean;
    stdout: string;
    stderr: string;
    error?: Error;
}
/** One evaluator process invocation. */
export interface EvaluatorProcessParts {
    argv: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    stdoutPath: string;
    stderrPath: string;
    spawn?: typeof spawn;
}
/**
 * Run one evaluator process, capturing stdout/stderr and enforcing a timeout.
 * `settle()` never rejects: a log write failure cannot leave the promise
 * pending, and the hard SIGKILL timer is cleared as soon as the child closes.
 */
export declare function runEvaluatorProcess(parts: EvaluatorProcessParts): Promise<EvaluatorProcessResult>;
/** A frozen evaluator bound to one run directory. */
export declare class FrozenEvaluator {
    readonly output: string;
    readonly logger: Logger | null;
    readonly plan: EvaluatorPlan;
    hash: string | null;
    script: string | null;
    private readonly spawnImpl;
    constructor({ plan, output, logger, spawn: spawnImpl, }: {
        plan: EvaluatorPlan;
        output: string;
        logger?: Logger | null;
        spawn?: typeof spawn;
    });
    /**
     * Copy the evaluator outside every candidate workspace and hash it.
     * Extensionless scripts are classified from a Python/Node shebang; a script
     * without either defaults to Python, matching `ara`.
     */
    freeze(): Promise<string>;
    argv(workspace: string): string[];
    validateCandidate(value: unknown, before: Record<string, string>, workspace: string): Promise<EvaluationResult>;
    /** Evaluate one candidate workspace. `folder` receives evaluation logs. */
    evaluate(workspace: string, folder: string, options?: {
        deadline?: number;
        signal?: AbortSignal;
        now?: () => number;
    }): Promise<EvaluationResult>;
}
/** @returns the frozen evaluator for a plan. */
export declare function createFrozenEvaluator(options: ConstructorParameters<typeof FrozenEvaluator>[0]): FrozenEvaluator;
//# sourceMappingURL=evaluator.d.ts.map