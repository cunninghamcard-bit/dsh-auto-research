/**
 * One research batch.
 *
 * A port of ara's `Runner` onto LayerFS branches and dsh continuable
 * subagents: explore forks the leader's commit into fresh branches, each with
 * a new worker; continue resumes the leader's own worker session on its own
 * branch. Every state is a commit, scored by the plan's evaluator through the
 * batch executor.
 */
import type { BranchRef, ExecutorBackend, Logger, WorkspaceBackend } from 'dsh-auto-research-api';
import type { WorkerRunServer } from './run-server.js';
import type { BatchResult, EvaluationResult, Latest, MetricDiagnostic, ResearchOptions, ResearchPlan, SubagentsService, TrajectoryRow, WorkerAgentOptions } from './types.js';
/** Raised when the caller stops a batch; branches and sessions are kept. */
export declare class ResearchStoppedError extends Error {
    constructor(message?: string);
}
/** Workers of running batches, for the skill catalog and the recursion guard. */
export declare class ActiveWorkers {
    readonly cwds: Set<string>;
    readonly sessions: Set<string>;
    onChange: () => void;
    add(cwd: string, session: string | null): void;
    remove(cwd: string, session: string | null): void;
    ownsCwd(cwd: string): boolean;
}
export interface RunnerDeps {
    plan: ResearchPlan;
    options: ResearchOptions;
    runId: string;
    /** The batch's run directory on the host. */
    output: string;
    /** `LATEST.json` of this coordinator folder. */
    latestFile: string;
    latest: Latest | null;
    workspace: WorkspaceBackend;
    executor: ExecutorBackend;
    evaluatorText: string;
    evaluatorSha256: string;
    subagents: SubagentsService;
    /** The coordinator agent: parent of every worker. */
    parent: unknown;
    workerProvider: string;
    workerAgentOptions: WorkerAgentOptions | null;
    workers: ActiveWorkers;
    /** Serves `research-run` requests of running workers. */
    runs: WorkerRunServer;
    signal?: AbortSignal;
    logger?: Logger;
    rng?: () => number;
}
export declare class Runner {
    readonly deps: RunnerDeps;
    readonly plan: ResearchPlan;
    readonly options: ResearchOptions;
    readonly rows: TrajectoryRow[];
    readonly selections: Array<Record<string, unknown>>;
    readonly abort: AbortController;
    /** Activations still running, so a stop can interrupt them. */
    private readonly live;
    anchor: number | null;
    stalledWorkSeconds: number;
    constructor(deps: RunnerDeps);
    stopped(): boolean;
    checkStopped(): void;
    /** Stop scheduling and interrupt every running worker. */
    stop(): void;
    private interrupt;
    branchName(id: string): string;
    run(): Promise<BatchResult>;
    /**
     * The batch's starting state: the previous batch's leader when its frontier
     * was scored by the same evaluator on the same executor, else a fresh
     * branch at `plan.base`, which must evaluate as valid.
     */
    private baseline;
    /** Fork the leader's commit into `branches` fresh branches, one new worker each. */
    private explore;
    /**
     * Continue the leader's own worker session on the leader's branch. A leader
     * without a session (the baseline), or one whose session cannot resume (a
     * different coordinator conversation), gets a fresh worker on a fork instead.
     */
    private continueLeader;
    private freshWorker;
    private resumeWorker;
    private writeBranchFile;
    /**
     * Wait for one worker turn under its time budget, then read its branch head
     * and evaluate it. A worker that ran out of time is interrupted; whatever it
     * committed is still evaluated.
     */
    private settle;
    /**
     * The activation's result. At `budgetMs` the worker is interrupted; after an
     * interrupt (deadline or stop) it gets {@link WORKER_GRACE_MS} to settle
     * before the activation is disposed. Its session stays persisted either way.
     */
    private awaitSettled;
    /**
     * A worker's `research-run` handler: run argv on its branch head through the
     * batch executor, no longer than the turn has left. Every request is
     * appended to the branch's `research-runs.jsonl`.
     */
    private workerRun;
    /** Score one commit with the plan's evaluator, through the batch executor. */
    evaluate(ref: BranchRef, folder: string): Promise<EvaluationResult>;
    private parseEvaluation;
    /** The best valid state among the incumbent and the candidates. */
    choose(incumbent: TrajectoryRow, candidates: TrajectoryRow[]): TrajectoryRow;
    /** Reset the stall clock on a meaningful gain, else add this phase's work time. */
    private recordProgress;
    metricDiagnostics(): MetricDiagnostic[];
    private views;
    private frontier;
    private writeState;
    private finish;
}
//# sourceMappingURL=runner.d.ts.map