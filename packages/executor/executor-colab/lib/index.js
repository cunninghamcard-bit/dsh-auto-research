/**
 * `dsh-auto-research-executor-colab`: run a command on a commit on a Google
 * Colab GPU through the signed-in Colab CLI.
 *
 * A Colab kernel runs one request at a time and shares its state, CUDA
 * context and `/content` across requests, so this executor keeps one queue
 * per session, gives each request its own directory and a fresh process
 * group, kills that group at the timeout, and restarts the kernel when the
 * CLI itself gave up waiting. Sessions cost compute units: by default only
 * sessions named in the configuration are used.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const name = 'dsh-auto-research-executor-colab';
export const inject = ['researchExecutor', 'skills'];
/** Marks the result line among the kernel's output. */
const RESULT_MARK = '__AUTO_RESEARCH_RESULT__';
/** Extra seconds the CLI waits beyond the command's own timeout (setup, extraction, cleanup). */
const CLI_SLACK_SECONDS = 120;
/** The Python run on the Colab kernel for one request. */
function remoteScript(id, files, argv, seconds) {
    const payload = Buffer.from(JSON.stringify({
        id,
        files: files.map(file => [file.name, Buffer.from(file.text, 'utf8').toString('base64')]),
        argv,
        seconds,
    })).toString('base64');
    return `
import base64, json, os, shutil, signal, subprocess, tarfile
spec = json.loads(base64.b64decode(${JSON.stringify(payload)}))
root = '/content/auto-research/' + spec['id']
archive = root + '.tar.gz'
result = {'code': None, 'timedOut': False, 'stdout': '', 'stderr': ''}
try:
    os.makedirs(root, exist_ok=True)
    with tarfile.open(archive) as tar:
        tar.extractall(root, filter='data')
    for name, data in spec['files']:
        path = os.path.join(root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as handle:
            handle.write(base64.b64decode(data))
    child = subprocess.Popen(spec['argv'], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = child.communicate(timeout=spec['seconds'])
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        out, err = child.communicate()
        result['timedOut'] = True
    result.update(code=child.returncode, stdout=out[-1000000:], stderr=err[-200000:])
except Exception as error:
    result['stderr'] = 'auto-research Colab setup failed: ' + repr(error)
finally:
    shutil.rmtree(root, ignore_errors=True)
    if os.path.exists(archive):
        os.remove(archive)
print(${JSON.stringify(RESULT_MARK)} + json.dumps(result))
`;
}
export class ColabExecutor {
    config;
    logger;
    name = 'colab';
    cli;
    /** Each session's queue: the promise of its last request. */
    queues = new Map();
    pending = new Map();
    created = [];
    constructor(config, logger = null) {
        this.config = config;
        this.logger = logger;
        this.cli = config.cli ?? join(homedir(), '.local', 'bin', 'colab');
    }
    colab(args, timeoutMs) {
        return new Promise((resolveRun, reject) => {
            execFile(this.cli, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error)
                    reject(Object.assign(error, { stdout, stderr }));
                else
                    resolveRun({ stdout, stderr });
            });
        });
    }
    /** Sessions to use; creates them on first use when allowed. */
    async sessions() {
        if (this.config.sessions?.length)
            return this.config.sessions;
        if (this.created.length === 0) {
            const count = this.config.maxSessions ?? 1;
            for (let index = 0; index < count; index += 1) {
                const session = `auto-research-${randomUUID().slice(0, 8)}`;
                await this.colab(['new', '-s', session, ...(this.config.gpu ? ['--gpu', this.config.gpu] : [])], 15 * 60_000);
                this.created.push(session);
            }
        }
        return this.created;
    }
    /** The session with the fewest queued requests. */
    async pick() {
        const sessions = await this.sessions();
        return [...sessions].sort((a, b) => (this.pending.get(a) ?? 0) - (this.pending.get(b) ?? 0))[0];
    }
    async run(request) {
        const session = await this.pick();
        this.pending.set(session, (this.pending.get(session) ?? 0) + 1);
        const previous = this.queues.get(session) ?? Promise.resolve();
        const current = previous.catch(() => { }).then(() => this.runOn(session, request));
        this.queues.set(session, current);
        try {
            return await current;
        }
        finally {
            this.pending.set(session, (this.pending.get(session) ?? 1) - 1);
        }
    }
    async runOn(session, request) {
        request.signal?.throwIfAborted();
        const id = randomUUID();
        const local = await fsp.mkdtemp(join(tmpdir(), 'auto-research-colab-'));
        const environment = `colab:${this.config.gpu ?? session}`;
        try {
            const archive = await request.workspace.exportTree(request.ref, local);
            await this.colab(['upload', '-s', session, archive, `/content/auto-research/${id}.tar.gz`], 30 * 60_000);
            const seconds = Math.max(1, Math.ceil(request.timeoutMs / 1000));
            const script = join(local, 'run.py');
            await fsp.writeFile(script, remoteScript(id, request.files ?? [], request.argv, seconds));
            let stdout;
            try {
                stdout = (await this.colab(['exec', '-s', session, '-f', script, '--timeout', String(seconds + CLI_SLACK_SECONDS)], (seconds + CLI_SLACK_SECONDS + 60) * 1000)).stdout;
            }
            catch (error) {
                // The CLI stopped waiting, but the kernel keeps running the request:
                // restart it so the next request does not queue behind it.
                await this.colab(['restart-kernel', '-s', session], 120_000).catch(() => { });
                const detail = error.stderr ?? error.message;
                return { code: null, timedOut: true, stdout: '', stderr: `Colab exec failed: ${detail}`, environment };
            }
            const line = stdout.split('\n').reverse().find(entry => entry.startsWith(RESULT_MARK));
            if (!line)
                return { code: null, timedOut: false, stdout, stderr: 'Colab run printed no result', environment };
            const result = JSON.parse(line.slice(RESULT_MARK.length));
            return { ...result, environment };
        }
        finally {
            await fsp.rm(local, { recursive: true, force: true });
        }
    }
    /** Stop only the sessions this executor created. */
    async close() {
        for (const session of this.created.splice(0)) {
            await this.colab(['stop', '-s', session], 120_000).catch((error) => {
                this.logger?.warn?.(`[auto-research] colab stop ${session} failed: ${error.message}`);
            });
        }
    }
}
export class ColabExecutorFactory {
    config;
    name = 'colab';
    priority = 100;
    constructor(config) {
        this.config = config;
    }
    /** Null unless sessions are named or may be created, so `auto` falls back to local. */
    async create(options) {
        if (!this.config.sessions?.length && !this.config.createSessions)
            return null;
        return new ColabExecutor(this.config, options.logger ?? null);
    }
}
const SKILL = fileURLToPath(new URL('../skills/auto-research-colab/SKILL.md', import.meta.url));
export function apply(ctx, config = {}) {
    ctx.effect(() => ctx.researchExecutor.register(new ColabExecutorFactory(config)));
    const skill = {
        name: 'auto-research-colab',
        description: 'Evaluate auto-research candidates on a Google Colab GPU: plan options.executor "colab".',
        invocation: { modelInvocable: true, userInvocable: false },
        provider: name,
        source: 'bundled',
        rank: 600,
        resourceBase: { kind: 'directory', path: join(SKILL, '..') },
    };
    ctx.skills.registerProvider(() => ({
        name,
        list: async () => [skill],
        get: async () => ({ ...skill, content: (await fsp.readFile(SKILL, 'utf8')).replace(/^---\n[\s\S]*?\n---\n+/, '') }),
    }));
}
//# sourceMappingURL=index.js.map