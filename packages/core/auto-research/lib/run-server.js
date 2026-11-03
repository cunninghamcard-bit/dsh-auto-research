/**
 * `research-run`: how a branch worker runs a command on its own branch through
 * the batch executor (a Colab GPU, or a LayerFS Sandbox), the same way the
 * evaluator runs.
 *
 * The provider serves one local HTTP endpoint. Each worker session gets a
 * token, and `ctx.shellEnv` hands that session's bash calls the CLI path, the
 * endpoint and the token. Requests of one worker run one at a time.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
/** The CLI workers call. */
export const RUN_CLI = fileURLToPath(new URL('../bin/research-run.mjs', import.meta.url));
export const RUN_ENV_VARIABLES = {
    DSH_AUTO_RESEARCH_RUN: { description: 'auto-research worker: CLI that runs a command on your committed branch head through the batch executor (node "$DSH_AUTO_RESEARCH_RUN" -- <command>)' },
    DSH_AUTO_RESEARCH_URL: { description: 'auto-research worker: endpoint the research-run CLI calls' },
    DSH_AUTO_RESEARCH_TOKEN: { description: 'auto-research worker: this worker session\'s research-run token' },
};
export class WorkerRunServer {
    bySession = new Map();
    byToken = new Map();
    server = null;
    /** Serve `session`'s requests with `handler` until the returned function runs. */
    async register(session, handler) {
        await this.listen();
        const entry = { token: randomBytes(24).toString('hex'), handler, queue: Promise.resolve() };
        this.bySession.set(session, entry);
        this.byToken.set(entry.token, entry);
        return () => {
            if (this.bySession.get(session) === entry)
                this.bySession.delete(session);
            this.byToken.delete(entry.token);
        };
    }
    /** The bash environment of one worker session; empty for any other session. */
    environment(session) {
        const entry = session ? this.bySession.get(session) : undefined;
        if (!entry || !this.address)
            return {};
        return { DSH_AUTO_RESEARCH_RUN: RUN_CLI, DSH_AUTO_RESEARCH_URL: this.address, DSH_AUTO_RESEARCH_TOKEN: entry.token };
    }
    address = null;
    listen() {
        return this.server ??= new Promise((resolveListen, reject) => {
            const server = createServer((request, response) => {
                const reply = (status, body) => {
                    response.writeHead(status, { 'content-type': 'application/json' });
                    response.end(JSON.stringify(body));
                };
                const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
                const entry = this.byToken.get(token);
                if (request.method !== 'POST' || !entry) {
                    reply(403, { error: 'not a running auto-research worker' });
                    request.resume();
                    return;
                }
                let body = '';
                request.setEncoding('utf8');
                request.on('data', chunk => { body += chunk; });
                request.on('end', () => {
                    let argv;
                    let timeout;
                    try {
                        const parsed = JSON.parse(body);
                        if (!Array.isArray(parsed.argv) || parsed.argv.length === 0)
                            throw new Error('argv must be a non-empty array');
                        argv = parsed.argv.map(String);
                        timeout = typeof parsed.timeout === 'number' && parsed.timeout > 0 ? parsed.timeout : 300;
                    }
                    catch (error) {
                        reply(400, { error: error.message });
                        return;
                    }
                    const run = entry.queue.catch(() => { }).then(() => entry.handler(argv, timeout));
                    entry.queue = run;
                    run.then(result => reply(200, result), (error) => reply(500, { error: error.message }));
                });
            });
            server.requestTimeout = 0;
            server.headersTimeout = 60_000;
            server.on('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.unref();
                this.address = `http://127.0.0.1:${server.address().port}/run`;
                resolveListen({ server, url: this.address });
            });
        });
    }
}
//# sourceMappingURL=run-server.js.map