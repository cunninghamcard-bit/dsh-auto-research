/**
 * `dsh-auto-research-workspace-layerfs`: research branches as LayerFS branches
 * of the coordinator's project.
 *
 * Workers reach their branch with the `layerfs` command the dsh-layerfs preset
 * gives every bash call; this plugin forks branches, reads their heads, and
 * runs commands on a commit in a Sandbox of its own. It provides
 * `ctx.researchWorkspace` and registers that Sandbox as the `sandbox`
 * executor, the default where no other executor applies. Nothing is copied to
 * the host except an exported tarball an executor asks for.
 */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const name = 'dsh-auto-research-workspace-layerfs';
export const inject = ['researchExecutor', 'shellEnv'];
/** The `DSH_LAYERFS_*` names `@dsh-layerfs/host` publishes, and the `LAYERFS_*` names `LayerFS.open` reads. */
const SDK_ENVIRONMENT = [
    ['LAYERFS_HOME', 'DSH_LAYERFS_HOME'],
    ['LAYERFS_STORE_PATH', 'DSH_LAYERFS_STORE_PATH'],
    ['LAYERFS_DOCKER', 'DSH_LAYERFS_DOCKER'],
    ['LAYERFS_IMAGE', 'DSH_LAYERFS_IMAGE'],
    ['LAYERFS_VOLUME', 'DSH_LAYERFS_VOLUME'],
    ['LAYERFS_DAEMON', 'DSH_LAYERFS_DAEMON'],
    ['LAYERFS_CONTAINER_PREFIX', 'DSH_LAYERFS_CONTAINER_PREFIX'],
    ['LAYERFS_DAEMON_HOST', 'DSH_LAYERFS_DAEMON_HOST'],
    ['LAYERFS_WORKER_ENDPOINT', 'DSH_LAYERFS_WORKER_ENDPOINT'],
];
/** Opens run one at a time: each one owns `process.env`'s `LAYERFS_*` names while it reads them. */
let opening = Promise.resolve();
/**
 * Open the coordinator's LayerFS project with the SDK its session names.
 * `LayerFS.open` reads its deployment from `LAYERFS_*` once, so those names are
 * set on `process.env` around the open and restored right after it.
 */
export async function openLayerfs(env) {
    const project = env.DSH_LAYERFS_PROJECT;
    const sdk = env.DSH_LAYERFS_SDK;
    if (!project || !sdk)
        return null;
    const open = opening.then(async () => {
        const saved = SDK_ENVIRONMENT.map(([key]) => [key, process.env[key]]);
        for (const [key, source] of SDK_ENVIRONMENT) {
            const value = env[source];
            if (value)
                process.env[key] = value;
            else
                delete process.env[key];
        }
        try {
            const url = sdk.startsWith('file:') ? sdk : pathToFileURL(isAbsolute(sdk) ? sdk : resolve(sdk)).href;
            const module = await import(__rewriteRelativeImportExtension(url));
            if (typeof module.LayerFS?.open !== 'function')
                throw new Error('LayerFS SDK does not export LayerFS.open: ' + sdk);
            return await module.LayerFS.open(project);
        }
        finally {
            for (const [key, value] of saved) {
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
        }
    });
    opening = open.catch(() => { });
    return open;
}
function refusal(error) {
    const code = error?.code;
    return typeof code === 'string' ? code : '';
}
const TRANSIENT = /ECONNREFUSED|ECONNRESET|EPIPE|Connection refused|socket hang up|failed to connect to daemon/i;
/**
 * Retry a call LayerFS refused for a passing reason: `Busy` (another agent is
 * changing the project) or a Sandbox daemon still binding its port.
 */
async function retry(call, attempts = 6) {
    for (let attempt = 0;; attempt += 1) {
        try {
            return await call();
        }
        catch (error) {
            const passing = refusal(error) === 'Busy' || TRANSIENT.test(String(error?.message ?? error));
            if (!passing || attempt >= attempts)
                throw error;
            await new Promise(done => setTimeout(done, 150 * 2 ** attempt).unref());
        }
    }
}
function quote(value) {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}
/** Bytes per exported chunk; base64 of it stays well inside one exec reply. */
const EXPORT_CHUNK = 4 * 1024 * 1024;
export class LayerFSWorkspace {
    client;
    project;
    logger;
    sandbox = null;
    constructor(client, project, logger = null) {
        this.client = client;
        this.project = project;
        this.logger = logger;
    }
    async fork(from, name) {
        const source = typeof from === 'string' ? from : from.commit ?? from.base;
        const forked = await retry(() => this.client.branch.fork(name, source));
        return { branch: forked.branch, commit: forked.head, base: forked.base };
    }
    describe(ref) {
        return [
            `Your branch: LayerFS project ${this.project}, branch ${ref.branch}. Work and commit only on this branch.`,
            'Read and change it with the `layerfs` command or the SDK, as the LayerFS instructions in your system prompt describe: mount a Workspace in your own Sandbox, run commands there, commit, and unmount every Workspace before you end your turn.',
        ].join('\n');
    }
    async head(branch) {
        for (let page = 0;;) {
            const listed = await retry(() => this.client.project.list_branches(1000, page));
            const found = listed.items.find(item => item.name === branch);
            if (found)
                return { branch, commit: found.head, base: found.base };
            if (!listed.hasMore || listed.nextPagePos === null)
                throw new Error(`LayerFS branch ${branch} does not exist`);
            page = listed.nextPagePos;
        }
    }
    async run(ref, options) {
        options.signal?.throwIfAborted();
        const seconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
        const setup = (options.files ?? []).map(file => {
            const target = quote(file.name);
            const data = Buffer.from(file.text, 'utf8').toString('base64');
            return `mkdir -p "$(dirname ${target})" && printf %s ${quote(data)} | base64 -d > ${target}`;
        });
        const command = [
            ...setup,
            `timeout -k 10 ${seconds} ${options.argv.map(quote).join(' ')}`,
        ].join(' && ');
        const result = await this.onCommit(ref, ws => retry(() => this.client.workspace.exec(ws, command, 'auto-research run')));
        return {
            code: result.exitCode,
            // `timeout` exits 124 when it stopped the command, 137 when it had to kill it.
            timedOut: result.exitCode === 124 || result.exitCode === 137,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
            environment: 'layerfs',
        };
    }
    async exportTree(ref, directory) {
        const target = join(directory, `${ref.branch}-${(ref.commit ?? ref.base).slice(0, 12)}.tar.gz`);
        const archive = `/tmp/ar-export-${randomUUID()}.tar.gz`;
        await fsp.mkdir(directory, { recursive: true });
        await this.onCommit(ref, async (ws) => {
            const exec = async (command) => {
                const result = await retry(() => this.client.workspace.exec(ws, command, 'auto-research export'));
                if (result.exitCode !== 0)
                    throw new Error(`LayerFS export of ${ref.branch} failed: ${result.stderr}`);
                return result.stdout;
            };
            const size = Number((await exec(`tar czf ${archive} --exclude=./.git . && wc -c < ${archive}`)).trim());
            const handle = await fsp.open(target, 'w');
            try {
                for (let offset = 0; offset < size; offset += EXPORT_CHUNK) {
                    const chunk = await exec(`tail -c +${offset + 1} ${archive} | head -c ${EXPORT_CHUNK} | base64 -w0`);
                    await handle.write(Buffer.from(chunk, 'base64'));
                }
            }
            finally {
                await handle.close();
                await exec(`rm -f ${archive}`).catch(() => '');
            }
        });
        return target;
    }
    async close() {
        await this.client.close();
    }
    /**
     * Mount `ref` for one call and unmount it with its changes discarded. A
     * branch whose head moved past `ref` is read through a scratch branch forked
     * at `ref`, so the call always sees exactly that commit.
     */
    async onCommit(ref, use) {
        const head = await this.head(ref.branch);
        const branch = head.commit === ref.commit
            ? ref.branch
            : (await this.fork(ref, `${ref.branch.slice(0, 48)}-at-${randomUUID().slice(0, 8)}`)).branch;
        const ws = await this.mount(branch);
        try {
            return await use(ws);
        }
        finally {
            await retry(() => this.client.workspace.unmount(ws, true)).catch((error) => {
                this.logger?.warn?.(`[auto-research] unmount of ${ws.sandbox}:${ws.path} failed: ${error.message}`);
            });
        }
    }
    /**
     * Mount in this backend's Sandbox. A Sandbox closes itself two minutes after
     * its last Workspace and holds at most 16; either refusal makes a new one.
     */
    async mount(branch) {
        for (let attempt = 0;; attempt += 1) {
            const current = this.sandbox ??= retry(() => this.client.sandbox.create()).then(made => made.sandbox);
            try {
                const sandbox = await current;
                return await retry(() => this.client.workspace.mount(sandbox, branch));
            }
            catch (error) {
                if (this.sandbox === current)
                    this.sandbox = null;
                const code = refusal(error);
                if (attempt > 0 || (code !== 'NoSuchSandbox' && code !== 'Capacity'))
                    throw error;
            }
        }
    }
}
/** The synthetic tool-call id the coordinator's bash variables are read under. */
const SHELL_ENV_CALL_ID = 'auto-research-env';
/** `ctx.researchWorkspace`: the project the coordinator's session is bound to. */
export class LayerFSWorkspaceService {
    shellEnv;
    constructor(shellEnv) {
        this.shellEnv = shellEnv;
    }
    async open(parent, options) {
        const env = this.shellEnv.collect({ agent: parent, callId: SHELL_ENV_CALL_ID, rootCallId: SHELL_ENV_CALL_ID });
        const client = await openLayerfs(env);
        if (!client)
            throw new Error('This session is not bound to a LayerFS project; use LayerFS in the conversation first');
        return new LayerFSWorkspace(client, env.DSH_LAYERFS_PROJECT, options.logger ?? null);
    }
}
/** The `sandbox` executor: run in the batch workspace's own Sandbox (CPU). */
export class SandboxExecutor {
    name = 'sandbox';
    run(request) {
        const { ref, workspace, ...options } = request;
        return workspace.run(ref, options);
    }
}
export class SandboxExecutorFactory {
    name = 'sandbox';
    priority = 0;
    async create() {
        return new SandboxExecutor();
    }
}
export function apply(ctx) {
    ctx.provide('researchWorkspace', new LayerFSWorkspaceService(ctx.shellEnv));
    ctx.effect(() => ctx.researchExecutor.register(new SandboxExecutorFactory()));
}
//# sourceMappingURL=index.js.map