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
export const RESEARCH_RUN_TOOL = 'research_run';
/** Default timeout of one request, in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 300;
/** How much of each output stream a result keeps: the tail. */
const OUTPUT_CHARS = 20_000;
/**
 * Running workers, by session id: who may call `research_run`, what their
 * requests run, and which activations a stopping batch interrupts.
 */
export class Workers {
    sessions = new Map();
    /** Register `session` until the returned function runs. */
    register(session, owner, handler) {
        const worker = { owner, handler, queue: Promise.resolve(), activation: null };
        this.sessions.set(session, worker);
        return () => {
            if (this.sessions.get(session) === worker)
                this.sessions.delete(session);
        };
    }
    /** Record the activation a registered session runs in. */
    attach(session, activation) {
        const worker = this.sessions.get(session);
        if (worker)
            worker.activation = activation;
    }
    has(session) {
        return this.sessions.has(session);
    }
    /** The running activations of one batch. */
    activations(owner) {
        return [...this.sessions.values()].filter(worker => worker.owner === owner && worker.activation).map(worker => worker.activation);
    }
    /** Run one request after the session's earlier ones. */
    run(session, command, timeoutSeconds, signal) {
        const worker = this.sessions.get(session);
        if (!worker)
            return Promise.reject(new Error('research_run works only inside a running auto-research worker'));
        const run = worker.queue.catch(() => { }).then(() => worker.handler(command, timeoutSeconds, signal));
        worker.queue = run;
        return run;
    }
}
function tail(text) {
    return text.length <= OUTPUT_CHARS ? text : `[… ${text.length - OUTPUT_CHARS} earlier characters cut]\n${text.slice(-OUTPUT_CHARS)}`;
}
/** The result text the worker reads. */
export function formatRun(result) {
    const status = result.timedOut ? 'timed out' : `exit code ${result.code}`;
    return [
        `${result.environment} @ ${(result.commit ?? 'unknown').slice(0, 12)}: ${status}`,
        '--- stdout ---',
        tail(result.stdout),
        '--- stderr ---',
        tail(result.stderr),
    ].join('\n');
}
export function researchRunTool(workers) {
    return {
        name: RESEARCH_RUN_TOOL,
        description: 'Run a bash command on the evaluation hardware (a Colab GPU when the batch uses one, else a LayerFS Sandbox), '
            + 'from the root of a fresh copy of your branch\'s newest commit. Commit first: only committed files are there, and nothing the command writes is kept. '
            + 'Returns the environment, the commit, the exit code, stdout and stderr. Runs of all branches share one queue with the evaluations, so keep them short.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Bash command, run with bash -c from the commit root.' },
                timeout_seconds: { type: 'integer', minimum: 1, description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}); never longer than your turn has left.` },
            },
            required: ['command'],
            additionalProperties: false,
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
            const { command, timeout_seconds: timeout } = args;
            if (typeof command !== 'string' || command.trim() === '')
                throw new Error('command must be a non-empty string');
            const session = typeof exec.agent?.id === 'string' ? exec.agent.id : '';
            const seconds = typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_TIMEOUT_SECONDS;
            return formatRun(await workers.run(session, command, seconds, exec.signal ?? new AbortController().signal));
        },
    };
}
//# sourceMappingURL=research-run.js.map