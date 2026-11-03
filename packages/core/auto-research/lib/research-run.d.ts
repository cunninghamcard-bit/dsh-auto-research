/**
 * `research_run`: the dsh tool a branch worker calls to run a command on its
 * own branch through the batch executor (a Colab GPU, or a LayerFS Sandbox),
 * the same way the evaluator runs.
 *
 * The runner registers each worker's session id in {@link Workers} before the
 * worker starts, and the tool takes part in a step only when the calling agent
 * is one of them, so no other session ever sees it. Requests of one worker run
 * one at a time.
 */
import type { ExecutionResult } from 'dsh-auto-research-api';
import type { SubagentActivation } from './types.js';
/** What a worker's request runs: a bash command on the branch head, within the timeout. */
export type WorkerRunHandler = (command: string, timeoutSeconds: number, signal: AbortSignal) => Promise<ExecutionResult & {
    commit: string | null;
}>;
export declare const RESEARCH_RUN_TOOL = "research_run";
/**
 * Running workers, by session id: who may call `research_run`, what their
 * requests run, and which activations a stopping batch interrupts.
 */
export declare class Workers {
    private readonly sessions;
    /** Register `session` until the returned function runs. */
    register(session: string, owner: unknown, handler: WorkerRunHandler): () => void;
    /** Record the activation a registered session runs in. */
    attach(session: string, activation: SubagentActivation): void;
    has(session: string): boolean;
    /** The running activations of one batch. */
    activations(owner: unknown): SubagentActivation[];
    /** Run one request after the session's earlier ones. */
    run(session: string, command: string, timeoutSeconds: number, signal: AbortSignal): Promise<ExecutionResult & {
        commit: string | null;
    }>;
}
/** The result text the worker reads. */
export declare function formatRun(result: ExecutionResult & {
    commit: string | null;
}): string;
/** The structural part of a dsh `ToolDefinition` this tool fills. */
export interface ResearchRunTool {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    output: {
        schema: Record<string, unknown>;
        render: (args: unknown, value: unknown) => Array<{
            type: 'text';
            text: string;
        }>;
    };
    execute: (args: unknown, exec: {
        agent?: {
            id?: unknown;
        };
        signal?: AbortSignal;
    }) => Promise<string>;
}
export declare function researchRunTool(workers: Workers): ResearchRunTool;
//# sourceMappingURL=research-run.d.ts.map