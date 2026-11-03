/**
 * `research-run`: how a branch worker runs a command on its own branch through
 * the batch executor (a Colab GPU, or a LayerFS Sandbox), the same way the
 * evaluator runs.
 *
 * The provider serves one local HTTP endpoint. Each worker session gets a
 * token, and `ctx.shellEnv` hands that session's bash calls the CLI path, the
 * endpoint and the token. Requests of one worker run one at a time.
 */
/** What a worker's request runs: argv on the branch head, within the timeout. */
export type WorkerRunHandler = (argv: string[], timeoutSeconds: number) => Promise<unknown>;
/** The CLI workers call. */
export declare const RUN_CLI: string;
export declare const RUN_ENV_VARIABLES: {
    readonly DSH_AUTO_RESEARCH_RUN: {
        readonly description: 'auto-research worker: CLI that runs a command on your committed branch head through the batch executor (node "$DSH_AUTO_RESEARCH_RUN" -- <command>)';
    };
    readonly DSH_AUTO_RESEARCH_URL: {
        readonly description: 'auto-research worker: endpoint the research-run CLI calls';
    };
    readonly DSH_AUTO_RESEARCH_TOKEN: {
        readonly description: 'auto-research worker: this worker session\'s research-run token';
    };
};
export declare class WorkerRunServer {
    private readonly bySession;
    private readonly byToken;
    private server;
    /** Serve `session`'s requests with `handler` until the returned function runs. */
    register(session: string, handler: WorkerRunHandler): Promise<() => void>;
    /** The bash environment of one worker session; empty for any other session. */
    environment(session: string | null): Record<string, string>;
    private address;
    private listen;
}
//# sourceMappingURL=run-server.d.ts.map