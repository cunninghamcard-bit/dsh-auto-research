/**
 * Workspace ownership for auto-research branches.
 *
 * Two interchangeable backends implement the same small contract:
 *
 * - LayerFS: fork copy-on-write branches, mount each branch, commit verified
 *   states, and unmount with `discard` only for abandoned work.
 * - Snapshot: content-addressed, full-copy branches in the run directory when
 *   no LayerFS project is bound.
 *
 * When `workspace.mount` returns a Sandbox-internal path (for example
 * `/workspaces/1`) the LayerFS backend transparently bridges it through a
 * host-accessible staging directory and publishes changes with `fs.apply` +
 * `workspace.commit`, so evaluation and evidence checks always run on the host.
 *
 * The module also owns the workspace inventory (the exact bytes an evaluation
 * is allowed to inspect) and the retained / restored completed-state objects
 * used by cooperative cohorts.
 */
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
/** Harness and provider state that never enters an inventory or a branch. */
export const OMIT = new Set([
    '.auto-research-methods',
    '.method-evaluation',
    '.codex',
    '.claude',
    '.aws',
    '.ssh',
    '.azure',
    '.config',
    '.env',
    '.netrc',
    '.npmrc',
    '.git-credentials',
]);
const SHARED_CONTEXT = 'SHARED_CONTEXT';
const ENV_FILE = /^\.env\./;
const BRANCH_PATTERN = /^ar-[a-z0-9-]+$/;
const MAX_BRANCH_LENGTH = 63;
/** @returns the lowercase hexadecimal SHA-256 of `data`. */
export function sha256(data) {
    return createHash('sha256').update(data).digest('hex');
}
/** @returns the SHA-256 of one file, streamed in 1 MiB blocks. */
export async function digestFile(path) {
    const hash = createHash('sha256');
    await new Promise((resolvePromise, reject) => {
        const stream = createReadStream(path);
        stream.on('error', reject);
        stream.on('data', block => hash.update(block));
        stream.on('end', () => resolvePromise());
    });
    return hash.digest('hex');
}
/** Deterministic JSON (sorted object keys at every depth). */
export function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const record = value;
        const keys = Object.keys(record).sort();
        return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
/** @returns the SHA-256 of the canonical JSON encoding of `value`. */
export function jsonDigest(value) {
    return sha256(canonicalJson(value));
}
/** Deep JSON equality through canonical encoding. */
export function jsonEqual(a, b) {
    return canonicalJson(a) === canonicalJson(b);
}
/** Whether `target` is `root` or strictly inside it. */
export function isContained(root, target) {
    const rel = relative(resolve(root), resolve(target));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
/** @returns the path relative to `root`, using POSIX separators. */
export function relativePosix(root, target) {
    return relative(root, target).split(sep).join('/');
}
function omitDirectory(parentName, name) {
    if (OMIT.has(name))
        return true;
    return parentName === SHARED_CONTEXT && name.startsWith('methods-');
}
function omitFile(name) {
    return OMIT.has(name) || ENV_FILE.test(name);
}
/**
 * Snapshot inventory: relative POSIX path -> SHA-256 for every regular,
 * non-omitted file. Symlinks and non-regular entries are rejected instead of
 * being followed, so a snapshot never captures bytes outside the workspace.
 */
export async function inventory(root) {
    const result = {};
    async function walk(directory) {
        const entries = await fsp.readdir(directory, { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const full = join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error('Snapshot requires materializing symlinks first: ' + full);
            }
            if (entry.isDirectory()) {
                if (omitDirectory(directory.split(sep).at(-1), entry.name))
                    continue;
                await walk(full);
                continue;
            }
            if (entry.isFile()) {
                if (omitFile(entry.name))
                    continue;
                result[relativePosix(root, full)] = await digestFile(full);
                continue;
            }
            throw new Error('Non-regular workspace entry: ' + full);
        }
    }
    await walk(root);
    return result;
}
/** @returns total regular-file bytes represented by `files` under `root`. */
export async function inventoryBytes(root, files) {
    let total = 0;
    for (const name of Object.keys(files)) {
        const stat = await fsp.lstat(join(root, name));
        total += stat.size;
    }
    return total;
}
/** @returns available bytes of the filesystem holding `path` (or its nearest parent). */
export async function freeBytes(path) {
    let cursor = resolve(path);
    while (true) {
        try {
            const stat = await fsp.statfs(cursor);
            return Number(stat.bavail) * Number(stat.bsize);
        }
        catch (error) {
            const code = error.code;
            if (code !== 'ENOENT')
                throw error;
            const parent = dirname(cursor);
            if (parent === cursor)
                throw error;
            cursor = parent;
        }
    }
}
function shouldCopy(sourceRoot, candidate) {
    const rel = relative(sourceRoot, candidate);
    if (rel === '')
        return true;
    const parts = rel.split(sep);
    const name = parts.at(-1) ?? '';
    const parent = parts.length > 1 ? parts.at(-2) : sourceRoot.split(sep).at(-1);
    if (OMIT.has(name))
        return false;
    if (ENV_FILE.test(name))
        return false;
    if (parent === SHARED_CONTEXT && name.startsWith('methods-'))
        return false;
    return true;
}
async function copyTree(sourceRoot, destinationRoot) {
    async function walk(source, destination) {
        await fsp.mkdir(destination, { recursive: true });
        const entries = await fsp.readdir(source, { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const from = join(source, entry.name);
            if (!shouldCopy(sourceRoot, from))
                continue;
            const to = join(destination, entry.name);
            if (entry.isSymbolicLink()) {
                throw new Error('Snapshot requires materializing symlinks first: ' + from);
            }
            if (entry.isDirectory()) {
                await walk(from, to);
                continue;
            }
            if (!entry.isFile())
                throw new Error('Non-regular workspace entry: ' + from);
            await fsp.copyFile(from, to);
            const stat = await fsp.lstat(from);
            await fsp.chmod(to, stat.mode & 0o777);
        }
    }
    await walk(resolve(sourceRoot), resolve(destinationRoot));
}
/**
 * Copy `source` into a new `destination`, verifying that no byte changed during
 * the copy. An existing destination is never overwritten.
 */
export async function snapshot(source, destination) {
    try {
        await fsp.lstat(destination);
        throw new Error('Existing branch is preserved: ' + destination);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const before = await inventory(source);
    const required = await inventoryBytes(source, before);
    const free = await freeBytes(dirname(destination));
    if (required >= free) {
        throw new Error('Insufficient space for an independent branch; existing research preserved');
    }
    await fsp.mkdir(dirname(destination), { recursive: true });
    await copyTree(source, destination);
    const after = await inventory(destination);
    const sourceAfter = await inventory(source);
    if (!jsonEqual(before, after) || !jsonEqual(before, sourceAfter)) {
        throw new Error('Workspace changed during snapshot; branch preserved, not launched');
    }
    return before;
}
/** Merge `source` into an existing directory (LayerFS baseline / staging copy). */
export async function mergeTree(source, destination) {
    const before = await inventory(source);
    await copyTree(source, destination);
    return before;
}
/** Write JSON through a unique temporary sibling and an atomic rename. */
export async function writeJsonAtomic(path, value) {
    await fsp.mkdir(dirname(path), { recursive: true });
    // A unique name keeps two concurrent writers of the same artifact (the
    // provider and the runner both write `RESULT.json`) from truncating each
    // other's temporary file.
    const temporary = `${path}.${process.pid}.${randomUUID()}.new`;
    try {
        await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
        await fsp.rename(temporary, path);
    }
    catch (error) {
        await fsp.unlink(temporary).catch(() => { });
        throw error;
    }
}
/** Strip live handles from a row before it is serialized. */
export function publicRow(row) {
    const copy = { ...row };
    delete copy._state;
    delete copy._ownsState;
    delete copy._released;
    return copy;
}
async function ensureNoSymlink(root, parts) {
    let cursor = root;
    for (const part of parts) {
        cursor = join(cursor, part);
        let stat;
        try {
            stat = await fsp.lstat(cursor);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                continue;
            throw error;
        }
        if (stat.isSymbolicLink())
            throw new Error('Completed checkpoint path may not traverse symlinks');
    }
}
/**
 * Store every distinct completed file once in `checkpoint-objects` and record a
 * checkpoint manifest for later restoration.
 *
 * @returns checkpoint path
 */
export async function retainCompletedState(output, row) {
    const workspace = row.workspace;
    const files = await inventory(workspace);
    for (const [name, expected] of Object.entries(row.evaluation?.evidence ?? {})) {
        if (!isContained(workspace, join(workspace, name))) {
            throw new Error('Completed checkpoint evidence outside the workspace');
        }
        const actual = await digestFile(join(workspace, name));
        if (actual !== expected)
            throw new Error('Completed checkpoint evidence drift');
        files[name] = expected;
    }
    const objects = join(output, 'checkpoint-objects');
    await fsp.mkdir(objects, { recursive: true });
    const modes = {};
    for (const name of Object.keys(files).sort()) {
        const expected = files[name];
        if (expected === undefined)
            continue;
        const parts = name.split('/');
        if (isAbsolute(name) || parts.includes('..') || parts.length === 0) {
            throw new Error('Invalid retained checkpoint path');
        }
        await ensureNoSymlink(workspace, parts);
        const path = join(workspace, name);
        if (!isContained(workspace, path))
            throw new Error('Retained checkpoint escapes the workspace');
        const stat = await fsp.lstat(path);
        if (!stat.isFile())
            throw new Error('Completed checkpoint evidence is not a regular file');
        if (await digestFile(path) !== expected)
            throw new Error('Completed checkpoint evidence drift');
        modes[name] = stat.mode & 0o777;
        const object = join(objects, expected);
        let exists = true;
        try {
            await fsp.access(object);
        }
        catch {
            exists = false;
        }
        if (!exists) {
            await fsp.copyFile(path, object);
            await fsp.chmod(object, 0o444);
        }
        if (await digestFile(object) !== expected)
            throw new Error('Checkpoint object changed');
    }
    const checkpoint = join(output, `${row.id}-completed-state.json`);
    const saved = { row: publicRow(row), files, modes };
    await writeJsonAtomic(checkpoint, saved);
    return checkpoint;
}
/**
 * Restore an independently evaluated completed state into a separate retained
 * directory when its mutable successor is incomplete.
 *
 * @returns the restored row
 */
export async function restoreCompletedState(output, checkpoint, failedRow) {
    const saved = JSON.parse(await fsp.readFile(checkpoint, 'utf8'));
    const row = { ...saved.row };
    const folder = join(output, `${failedRow.id}-last-completed`);
    await fsp.mkdir(folder, { recursive: true });
    const workspace = join(folder, 'workspace');
    // A previous restore of the same row leaves files the new checkpoint may not
    // contain; start from an empty directory so the restored tree is exactly the
    // evaluated one.
    await fsp.rm(workspace, { recursive: true, force: true });
    await fsp.mkdir(workspace, { recursive: true });
    for (const [name, expected] of Object.entries(saved.files)) {
        const parts = name.split('/');
        if (isAbsolute(name) || parts.includes('..') || parts.length === 0) {
            throw new Error('Invalid retained checkpoint path');
        }
        const object = join(output, 'checkpoint-objects', expected);
        if (await digestFile(object) !== expected) {
            throw new Error('Completed checkpoint object drift');
        }
        const target = join(workspace, name);
        await fsp.mkdir(dirname(target), { recursive: true });
        await fsp.copyFile(object, target);
        await fsp.chmod(target, saved.modes[name] ?? 0o644);
    }
    const actual = await inventory(workspace);
    if (jsonDigest(actual) !== row.evaluation?.workspace_manifest_sha256) {
        throw new Error('Restored completed state differs from evaluated state');
    }
    row.id = folder.split(sep).at(-1) ?? row.id;
    row.workspace = workspace;
    row.retained_completed_id = saved.row.id;
    row.incomplete_successor = failedRow.id;
    row.pending_workspace = failedRow.workspace;
    row.completed_state_sha256 = await digestFile(checkpoint);
    await writeJsonAtomic(join(folder, 'RESULT.json'), row);
    return {
        ...row,
        _state: { id: row.id, backend: 'snapshot', path: workspace, branch: null },
        _ownsState: true,
    };
}
/** Full-copy branch backend used when no LayerFS project is bound. */
export class SnapshotBackend {
    name = 'snapshot';
    output;
    runId;
    constructor({ output, runId = 'run' }) {
        this.output = output;
        this.runId = runId;
    }
    async baseline(source, id) {
        const path = join(this.output, id, 'workspace');
        await snapshot(source, path);
        return { id, backend: this.name, path, branch: null };
    }
    async fork(parent, id) {
        if (!parent)
            throw new Error('Snapshot branch requires a parent workspace');
        const path = join(this.output, id, 'workspace');
        await snapshot(parent.path, path);
        return { id, backend: this.name, path, branch: null };
    }
    async commit() { }
    async release() { }
    async retainCompletedState(row) {
        return retainCompletedState(this.output, row);
    }
    async restoreCompletedState(checkpoint, failedRow) {
        return restoreCompletedState(this.output, checkpoint, failedRow);
    }
}
/** Sanitize a value into a Docker/LayerFS-safe name fragment. */
export function branchSafe(value, max = 40) {
    const safe = String(value)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return safe.slice(0, max) || 'branch';
}
/** The refusal's code, or `''` for a plain error. */
function refusalCode(error) {
    if (error === null || typeof error !== 'object')
        return '';
    const code = error.code;
    return typeof code === 'string' ? code : '';
}
/** Attach a LayerFS-style refusal code to a local error. */
function codedError(message, code) {
    return Object.assign(new Error(message), { code });
}
/**
 * Whether `fs.read` refused a file because it is not UTF-8 text.
 *
 * A binary adopted file has no text representation to stage, but it is not a
 * lost file: `workspace.exec` can copy the exact bytes, or the file is reported
 * as skipped and never removed from the branch.
 */
export function isSkippableAdoptedFile(error) {
    const code = refusalCode(error);
    if (code === 'Binary' || code === 'BinaryFile' || code === 'NotText')
        return true;
    const message = error === null || typeof error !== 'object'
        ? typeof error === 'string' ? error : ''
        : String(error.message ?? '');
    return /\bbinary\b|not (?:utf-?8|text)/i.test(message);
}
/** Quote a path for a POSIX shell command. */
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
/**
 * Whether a commit/unmount refusal only means the mount is behind its branch.
 *
 * `fs.apply` creates a commit on the branch, so right after publishing the
 * mount handle is one commit behind (`headMovedSinceMount`) or its overlay
 * necessarily differs (`Dirty`); the bytes are already safe on the branch.
 */
export function isStaleMountRefusal(error) {
    const code = refusalCode(error);
    if (['headMovedSinceMount', 'HeadMovedSinceMount', 'UpToDate', 'AlreadyUpToDate', 'Dirty', 'StaleMount'].includes(code)) {
        return true;
    }
    const message = error === null || typeof error !== 'object'
        ? typeof error === 'string' ? error : ''
        : String(error.message ?? '');
    return /head moved since mount|already up[- ]to[- ]date|up[- ]to[- ]date|dirty|stale mount/i.test(message);
}
/**
 * Whether a refusal means the LayerFS project does not exist yet or its `main`
 * branch carries no usable state, so `project.init(source)` can recover.
 *
 * The live and simulated bindings use the same codes (`NoSuchProject`,
 * `NoSuchBranch`, `NoSuchCommit`); message hints cover SDK versions that wrap
 * the refusal. Codes that mean "the project is there but unusable" are never
 * treated as missing.
 */
export function isMissingProjectOrMain(error) {
    const code = refusalCode(error);
    if (['NoSuchProject', 'NoSuchBranch', 'NoSuchCommit', 'NoSuchLayer'].includes(code))
        return true;
    if (['Exists', 'ReadOnly', 'Conflict', 'Busy', 'InvalidInput', 'NoSuchPath', 'Unsupported'].includes(code))
        return false;
    const message = error === null || typeof error !== 'object'
        ? ''
        : String(error.message ?? '');
    return /project .{0,200}does not exist|\bno (simulated )?(layerfs )?project\b|main (branch )?(does not exist|has no|is empty)|NoSuchProject|NoSuchBranch/i.test(message);
}
/** Whether `project.init` refused because the project already exists. */
function isExistingProject(error) {
    const code = refusalCode(error);
    if (code === 'Exists')
        return true;
    const message = error === null || typeof error !== 'object'
        ? ''
        : String(error.message ?? '');
    return /\bexists\b|already initialized/i.test(message);
}
/**
 * Whether a failed `branch.fork(_, 'main')` may mean the project is not
 * initialized yet.
 *
 * The ported macOS SDK reports a missing Store file as a plain `Failed` OS
 * error instead of `NoSuchProject`, so this is deliberately permissive: only
 * refusals that describe a different problem are excluded, and the caller
 * retries `project.init` + fork for everything else.
 */
export function mayNeedProjectInit(error) {
    if (isMissingProjectOrMain(error))
        return true;
    const code = refusalCode(error);
    if (['Busy', 'InvalidInput', 'Unsupported', 'ReadOnly'].includes(code))
        return false;
    const message = error === null || typeof error !== 'object'
        ? ''
        : String(error.message ?? '');
    if (/invalid.*branch name|not a valid name/i.test(message))
        return false;
    return true;
}
/**
 * Whether a LayerFS call failed for a reason that a short retry can fix.
 *
 * Two families are transient:
 * - `Busy`: another writer holds the Store/branch.
 * - Sandbox daemon / Store container startup: on OrbStack the published port
 *   starts accepting connections about half a second after `docker start`, so
 *   the first mount or Store call can be refused while the daemon is still
 *   binding. There is no user-visible failure to act on, only a delay.
 */
export function isTransientLayerfsError(error) {
    if (error === null || typeof error !== 'object') {
        return typeof error === 'string' && TRANSIENT_MESSAGE.test(error);
    }
    const candidate = error;
    if (candidate.code === 'Busy'
        || candidate.code === 'ECONNREFUSED'
        || candidate.code === 'ECONNRESET'
        || candidate.code === 'EPIPE')
        return true;
    const message = String(candidate.message ?? '');
    if (TRANSIENT_MESSAGE.test(message))
        return true;
    if (/busy/i.test(message))
        return true;
    // A wrapped cause (undici/`node:net` errors) carries the real reason.
    const cause = candidate.cause;
    if (cause && cause !== error)
        return isTransientLayerfsError(cause);
    return false;
}
/** Socket-level startup refusals that a retry can outlast. */
const TRANSIENT_MESSAGE = new RegExp([
    'ECONNREFUSED',
    'ECONNRESET',
    'EPIPE',
    'Connection refused',
    'socket hang up',
    'failed to connect to daemon',
    'the Store container .* worker did not answer',
    'the Store container .* has not started',
    'connect ENOENT',
].join('|'), 'i');
/**
 * Retry a LayerFS call that refused for a transient reason, using exponential
 * backoff. An OrbStack Sandbox daemon publishes its port about half a second
 * after the container starts, so the default budget (6 retries, ~9.5 s of
 * backoff) covers a real cold start while still failing loud.
 */
export async function withBusyRetry(fn, options = {}) {
    const retries = options.retries ?? 6;
    const baseDelayMs = options.baseDelayMs ?? 150;
    const delay = options.delay ?? ((milliseconds) => new Promise(resolvePromise => {
        const timer = setTimeout(resolvePromise, milliseconds);
        timer.unref?.();
    }));
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        }
        catch (error) {
            if (attempt >= retries || !isTransientLayerfsError(error))
                throw error;
            await delay(baseDelayMs * 2 ** attempt);
            attempt += 1;
        }
    }
}
/**
 * LayerFS copy-on-write branch backend.
 *
 * `ownsClient` is false whenever the client was injected by the host (for
 * example `ctx.layerfs.client`), so `close()` never tears down a shared client.
 */
export class LayerFSBackend {
    name = 'layerfs';
    client;
    operator;
    project;
    output;
    runId;
    logger;
    syncBaseline;
    ownsClient;
    retryBaseDelayMs;
    /** Close of the client `loadLayerfs` built, which also restores the environment. */
    releaseEnvironment;
    /** Re-assert this backend's LayerFS environment lease before each SDK call. */
    activateEnvironment;
    constructor(options) {
        const { client } = options;
        if (typeof client?.branch?.fork !== 'function' || typeof client?.workspace?.mount !== 'function') {
            throw new Error('LayerFS backend requires branch.fork and workspace.mount');
        }
        this.client = client;
        this.operator = options.operator ?? null;
        this.project = options.project ?? 'auto-research';
        this.output = options.output;
        this.runId = options.runId ?? 'run';
        this.logger = options.logger ?? null;
        this.syncBaseline = options.syncBaseline ?? true;
        this.ownsClient = options.ownsClient ?? false;
        this.retryBaseDelayMs = options.retryBaseDelayMs ?? 150;
        this.releaseEnvironment = options.releaseEnvironment ?? null;
        this.activateEnvironment = options.activateEnvironment ?? null;
    }
    /** @returns a branch name that always fits Docker's 63-character limit. */
    branchName(id) {
        return `ar-${branchSafe(this.runId, 12)}-${branchSafe(id, 44)}`;
    }
    retry(fn) {
        return withBusyRetry(() => {
            // Another batch in this process may have released (or replaced) the
            // LayerFS environment since the previous call; this batch's SDK calls
            // must still see its own binding.
            this.activateEnvironment?.();
            return fn();
        }, { retries: 6, baseDelayMs: this.retryBaseDelayMs });
    }
    /**
     * Unmount a workspace whose preparation failed and remove any host staging
     * copy. Cleanup failures are logged, never allowed to mask the original
     * error.
     */
    async discardMount(mount, stagingPath) {
        try {
            const unmount = this.client.workspace?.unmount;
            if (mount && typeof unmount === 'function') {
                await this.retry(() => unmount.call(this.client.workspace, mount, true));
            }
        }
        catch (error) {
            this.logger?.warn?.(`[auto-research] failed to unmount a partially prepared workspace: ${error.message}`);
        }
        if (!stagingPath)
            return;
        try {
            await fsp.rm(stagingPath, { recursive: true, force: true });
        }
        catch (error) {
            this.logger?.warn?.(`[auto-research] failed to remove staging ${stagingPath}: ${error.message}`);
        }
    }
    /**
     * Remount a staged branch after its HEAD moved (baseline publish / Sandbox
     * commit), so the Sandbox view and the host staging copy describe the same
     * branch state.
     */
    async remountStaging(state) {
        const handle = state.handle;
        const branch = state.branch;
        if (!handle || !branch)
            return;
        const unmount = this.client.workspace?.unmount;
        if (typeof unmount === 'function') {
            await this.retry(() => unmount.call(this.client.workspace, handle, true));
        }
        state.handle = null;
        const mount = await this.retry(() => {
            const method = this.client.workspace?.mount;
            if (typeof method !== 'function')
                throw new Error('LayerFS client has no workspace.mount');
            return method.call(this.client.workspace, branch);
        });
        const raw = mount?.path ?? mount?.workspace?.path;
        if (typeof raw !== 'string' || raw.length === 0) {
            await this.discardMount(mount, null);
            throw new Error('LayerFS workspace.mount returned no path');
        }
        state.handle = mount;
        state.sandboxPath = raw;
    }
    async mountBranch(branch, id, sourcePath) {
        const mount = await this.retry(() => {
            const method = this.client.workspace?.mount;
            if (typeof method !== 'function')
                throw new Error('LayerFS client has no workspace.mount');
            return method.call(this.client.workspace, branch);
        });
        const raw = mount?.path ?? mount?.workspace?.path;
        if (typeof raw !== 'string' || raw.length === 0) {
            await this.discardMount(mount, null);
            throw new Error('LayerFS workspace.mount returned no path');
        }
        const host = await hostDirectory(raw);
        if (host) {
            return {
                branch,
                mount,
                path: host,
                sandboxPath: typeof mount.sandbox === 'string' ? raw : null,
                staging: false,
            };
        }
        // A Sandbox-internal mount (/workspaces/N) is not visible on the host.
        // Stage a host copy so evaluation, evidence checks and one-shot CLI
        // workers all operate on real files, then publish changes back.
        const staging = join(this.output, id, 'workspace');
        try {
            await fsp.mkdir(staging, { recursive: true });
            if (sourcePath && resolve(sourcePath) !== resolve(staging))
                await mergeTree(sourcePath, staging);
        }
        catch (error) {
            await this.discardMount(mount, staging);
            throw error;
        }
        return {
            branch,
            mount,
            path: staging,
            sandboxPath: raw,
            staging: true,
        };
    }
    async syncStaging(state, message) {
        const handle = state.handle;
        const branch = state.branch;
        if (!handle || !branch)
            return;
        const after = await inventory(state.path);
        const before = state.stagingInventory ?? {};
        const writes = [];
        // A fresh LayerFS branch holds no directories, and a write refuses when its
        // parent is missing, so create every parent of a new file first.
        const directories = new Set();
        for (const name of Object.keys(after).sort()) {
            if (after[name] === before[name])
                continue;
            const parts = name.split('/');
            for (let depth = 1; depth < parts.length; depth += 1) {
                directories.add(parts.slice(0, depth).join('/'));
            }
            const bytes = await fsp.readFile(join(state.path, name));
            // Text travels as text: the simulator's model stores strings, while the
            // live binding accepts both text and bytes.
            const text = bytes.toString('utf8');
            const content = Buffer.from(text, 'utf8').equals(bytes) ? text : bytes;
            writes.push({ op: 'write', path: '/' + name, content });
        }
        const mkdirs = [...directories]
            .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0))
            .map(name => ({ op: 'mkdir', path: '/' + name }));
        writes.unshift(...mkdirs);
        for (const name of Object.keys(before).sort()) {
            // `Object.hasOwn` so a file literally named `constructor` or `toString`
            // is compared as data, not as an inherited prototype member.
            if (Object.hasOwn(after, name))
                continue;
            // A binary adopted file without a host copy must never be removed from
            // its branch just because the staging directory cannot represent it.
            if ((state.skippedFiles ?? []).includes(name))
                continue;
            writes.push({ op: 'rm', path: '/' + name });
        }
        const fs = this.client.fs;
        let published = false;
        if (writes.length > 0) {
            if (typeof fs?.apply === 'function') {
                await this.retry(() => fs.apply(branch, writes, message));
                // `fs.apply` already created a commit on `branch`, which moves the
                // branch HEAD ahead of this mount's handle.
                published = true;
            }
            else if (typeof fs?.write === 'function' || typeof fs?.rm === 'function') {
                for (const change of writes) {
                    if (change.op === 'mkdir' && typeof fs.mkdir === 'function') {
                        await this.retry(() => fs
                            .mkdir(branch, change.path));
                    }
                    else if (change.op === 'write' && typeof fs.write === 'function') {
                        await this.retry(() => fs.write(branch, change.path, change.content ?? new Uint8Array()));
                        published = true;
                    }
                    else if (change.op === 'rm' && typeof fs.rm === 'function') {
                        await this.retry(() => fs.rm(branch, change.path));
                        published = true;
                    }
                }
            }
            else {
                this.logger?.warn?.('[auto-research] LayerFS mount is Sandbox-internal and the client exposes no fs.apply/fs.write; changes stay staged on the host');
            }
        }
        if (typeof this.client.workspace?.commit === 'function') {
            try {
                await this.retry(() => this.client.workspace.commit(handle, message));
            }
            catch (error) {
                // When `fs.apply`/`fs.write` already published the exact bytes, the
                // mount's own overlay is behind the branch HEAD (or the mount is dirty
                // by construction). That refusal is not a lost write.
                if (!published || !isStaleMountRefusal(error))
                    throw error;
                this.logger?.info?.(`[auto-research] branch ${branch} already holds the published bytes; skipping the stale mount commit (${refusalCode(error) || 'headMovedSinceMount'})`);
            }
        }
        state.stagingInventory = after;
    }
    async materializeBranch(branch, destination, mount = null, sandboxPath = null) {
        const skipped = [];
        const fs = this.client.fs;
        if (typeof fs?.list !== 'function' || typeof fs?.read !== 'function') {
            this.logger?.warn?.('[auto-research] cannot materialize a Sandbox-internal adopted branch: client.fs is unavailable');
            return skipped;
        }
        const files = await listBranchFiles(fs, branch);
        for (const name of files) {
            const relative = name.replace(/^\/+/, '');
            const target = join(destination, relative);
            try {
                const text = await this.readBranchFile(fs, branch, name);
                if (typeof text !== 'string')
                    continue;
                await fsp.mkdir(dirname(target), { recursive: true });
                await fsp.writeFile(target, text);
            }
            catch (error) {
                const truncated = refusalCode(error) === 'LineTruncated';
                if (!truncated && !isSkippableAdoptedFile(error)) {
                    this.logger?.warn?.(`[auto-research] skipped non-text adopted file ${name}: ${error.message}`);
                    continue;
                }
                const exec = this.client.workspace?.exec;
                if (mount && sandboxPath && typeof exec === 'function') {
                    try {
                        // `fs.read` cannot represent a binary file (or a line over 48 KiB),
                        // but the exact bytes are still inside the mounted Sandbox.
                        const source = `${sandboxPath.replace(/\/+$/, '')}/${relative}`;
                        const command = `sh -c 'base64 < "$1"' -- ${shellQuote(source)}`;
                        const result = await this.retry(() => exec.call(this.client.workspace, mount, command));
                        const stdout = typeof result === 'string'
                            ? result
                            : result?.stdout;
                        const exitCode = typeof result === 'object' && result !== null
                            ? result.exitCode
                            : undefined;
                        if (typeof exitCode === 'number' && exitCode !== 0) {
                            throw new Error(`workspace.exec exited ${exitCode}`);
                        }
                        let bytes;
                        if (typeof stdout === 'string')
                            bytes = Buffer.from(stdout, 'base64');
                        else if (stdout instanceof Uint8Array)
                            bytes = Buffer.from(stdout);
                        else
                            throw new Error('workspace.exec returned no stdout');
                        await fsp.mkdir(dirname(target), { recursive: true });
                        await fsp.writeFile(target, bytes);
                        continue;
                    }
                    catch (execError) {
                        this.logger?.warn?.(`[auto-research] workspace.exec could not copy ${name}: ${execError.message}`);
                    }
                }
                if (truncated) {
                    throw codedError(`LayerFS fs.read truncated a line > 48 KiB in ${name} and workspace.exec is unavailable`, 'LineTruncated');
                }
                // Never emit an `rm` for this path: the adopted branch still holds it.
                skipped.push(relative);
                this.logger?.warn?.(`[auto-research] kept binary adopted file ${name} on the branch without a host copy`);
            }
        }
        return skipped;
    }
    /**
     * Read one branch file completely.
     *
     * `fs.read` returns at most 2000 lines / 48 KiB per call and reports the next
     * `nextLine` cursor; a single call would truncate a large adopted file.
     */
    async readBranchFile(fs, branch, name) {
        const read = fs.read;
        let line;
        let text = '';
        let chunks = 0;
        while (chunks < 10_000) {
            chunks += 1;
            const value = line === undefined ? await read.call(fs, branch, name) : await read.call(fs, branch, name, line);
            if (value !== null && typeof value === 'object'
                && value.lineTruncated === true) {
                throw codedError(`LayerFS fs.read truncated a line > 48 KiB in ${name}`, 'LineTruncated');
            }
            const chunk = typeof value === 'string'
                ? value
                : value?.text
                    ?? value?.content;
            if (typeof chunk !== 'string')
                return text === '' ? null : text;
            text += chunk;
            const next = value !== null && typeof value === 'object'
                ? value.nextLine
                : undefined;
            if (typeof next !== 'number' || !Number.isFinite(next))
                return text;
            // Guard against a non-advancing cursor so a stuck SDK cannot loop forever.
            if (line !== undefined && next <= line)
                return text;
            if (line === undefined && next <= 0)
                return text;
            line = next;
        }
        return text;
    }
    /**
     * The LayerFS home a client was built for, when the SDK exposes it.
     *
     * `project.init` records the project as a directory directly under the home,
     * and it refuses a name that is already there, so this is the one
     * non-mutating existence probe available before any Store call.
     */
    homeDirectory() {
        const options = this.client.options;
        const home = options?.home;
        return typeof home === 'string' && home.length > 0 ? home : null;
    }
    /** Whether the project entry exists: true/false, or null when it cannot be told. */
    async projectInitialized() {
        // A Windows/WSL binding resolves its Store through the worker endpoint,
        // not this macOS home directory; probing it would be a false negative.
        const endpoint = this.client.options?.deploy?.wslEndpoint;
        if (endpoint)
            return null;
        const home = this.homeDirectory();
        if (!home)
            return null;
        const entry = join(home, this.project);
        try {
            const stat = await fsp.stat(entry);
            if (!stat.isDirectory())
                return false;
            // `project.init` refuses an existing name, and an interrupted init can
            // leave an empty directory that is not a project.
            const entries = await fsp.readdir(entry);
            if (entries.length === 0) {
                await fsp.rmdir(entry).catch(() => { });
                return false;
            }
            return true;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return false;
            return null;
        }
    }
    async initializeProject(source) {
        const project = this.client.project;
        if (typeof project?.init !== 'function') {
            throw new Error(`LayerFS project ${this.project} is not initialized and the SDK exposes no project.init; initialize it from ${source} first`);
        }
        await this.retry(() => project.init(source));
        this.logger?.info?.(`[auto-research] initialized LayerFS project ${this.project} from ${source}`);
    }
    /**
     * Create the baseline branch from the project's `main`.
     *
     * A LayerFS home may hold no project yet (a new dsh session, or the first
     * auto-research batch in a checkout). Initializing must come *before* any
     * Store call: on macOS `@dsh-layerfs/host`'s ported binding treats the
     * client's Store as already open once any Store call ran, and Init then
     * tries to open the not-yet-installed Store and refuses `NotFound`. So the
     * project entry is probed on the home directory first, and `project.init`
     * runs only when it is absent.
     *
     * Without a home to probe the fork itself is the probe; a refusal that may
     * mean "not initialized" then gets one `project.init` + fork retry. A
     * project that exists but whose `main` is unusable is reported clearly.
     */
    async forkBaseline(branch, source) {
        const fork = () => {
            const method = this.client.branch?.fork;
            if (typeof method !== 'function')
                throw new Error('LayerFS client has no branch.fork');
            return this.retry(() => method.call(this.client.branch, branch, 'main'));
        };
        const initialized = await this.projectInitialized();
        if (initialized === false) {
            // Another process may have initialized it between the probe and init.
            try {
                await this.initializeProject(source);
            }
            catch (initError) {
                if (!isExistingProject(initError))
                    throw initError;
            }
        }
        try {
            await fork();
            return;
        }
        catch (error) {
            if (!mayNeedProjectInit(error)) {
                if (initialized !== null) {
                    throw new Error(`LayerFS project ${this.project} has no usable main branch: ${error.message}`);
                }
                throw error;
            }
            // A `true`/`null` probe is not proof that `main` is usable (an
            // interrupted init leaves an empty project entry), so always try one
            // `project.init` + fork retry for a refusal that may mean "not ready".
            try {
                await this.initializeProject(source);
            }
            catch (initError) {
                // Another process may have initialized it between the probe and init;
                // anything else leaves `main` unusable, so report both failures.
                if (!isExistingProject(initError)) {
                    throw new Error(`LayerFS project ${this.project} has no usable main branch: ${error.message}; project.init(${source}) failed: ${initError.message}`);
                }
            }
            try {
                await fork();
            }
            catch (retryError) {
                throw new Error(`LayerFS project ${this.project} still has no usable main branch after project.init(${source}): ${retryError.message}`);
            }
        }
    }
    async baseline(source, id, { sync = this.syncBaseline } = {}) {
        const branch = this.branchName(id);
        await this.forkBaseline(branch, source);
        const mounted = await this.mountBranch(branch, id, source);
        const state = {
            id,
            backend: this.name,
            path: mounted.path,
            branch,
            handle: mounted.mount,
            sandboxPath: mounted.sandboxPath,
            staging: mounted.staging,
        };
        try {
            if (!mounted.staging && sync) {
                await mergeTree(source, mounted.path);
            }
            if (mounted.staging) {
                // A fresh LayerFS branch starts from `main`, so its files are the
                // baseline the staged host copy must reconcile against: a file present
                // on `main` and deleted in `source` has to become an explicit `rm`.
                if (sync && this.client.fs) {
                    const existing = await listBranchFiles(this.client.fs, branch);
                    state.stagingInventory = Object.fromEntries(existing.map(name => [name.replace(/^\/+/, ''), '']));
                }
                else {
                    state.stagingInventory = {};
                }
                await this.syncStaging(state, `auto-research: baseline ${id}`);
                // Publishing moved the branch HEAD past this mount, so the Sandbox
                // view at `/workspaces/<n>` would still show the pre-baseline files.
                // Remount the branch so both views agree and a later Sandbox commit
                // is not refused as `headMovedSinceMount`.
                await this.remountStaging(state);
            }
            else if (sync) {
                await this.retry(() => this.client.workspace.commit(mounted.mount, `auto-research: baseline ${id}`));
            }
            return state;
        }
        catch (error) {
            await this.discardMount(state.handle ?? null, mounted.staging ? mounted.path : null);
            throw error;
        }
    }
    async fork(parent, id) {
        if (!parent?.path)
            throw new Error('LayerFS branch requires a parent workspace');
        // A restored completed state (or any retained snapshot) is a plain folder
        // with no mounted branch. Forking it means the same thing as a baseline:
        // a fresh branch off `main` carrying that folder's files — always synced,
        // even when baseline syncing is configured off, because otherwise the child
        // branch would start empty.
        if (!parent.branch)
            return this.baseline(parent.path, id, { sync: true });
        const branch = this.branchName(id);
        // A staged parent is a host copy; a cooperative epoch may have skipped
        // recycling it (`_ownsState === false`), so publish its files to the
        // parent branch before the child branch is created. Without this the child
        // would miss every uncommitted file of the epoch.
        if (parent.staging) {
            await this.commit(parent, { message: `auto-research: publish staged parent before fork ${id}` });
        }
        await this.retry(() => this.client.branch.fork(branch, parent.branch));
        const mounted = await this.mountBranch(branch, id, parent.path);
        try {
            return {
                id,
                backend: this.name,
                path: mounted.path,
                branch,
                handle: mounted.mount,
                sandboxPath: mounted.sandboxPath,
                staging: mounted.staging,
                stagingInventory: await inventory(mounted.path),
            };
        }
        catch (error) {
            await this.discardMount(mounted.mount, mounted.staging ? mounted.path : null);
            throw error;
        }
    }
    async adopt(branch, id) {
        if (typeof branch !== 'string' || branch.length === 0) {
            throw new Error('LayerFS adopt requires a saved branch name');
        }
        if (branch.length > MAX_BRANCH_LENGTH || !BRANCH_PATTERN.test(branch)) {
            throw new Error(`Previous leader branch is not a safe auto-research branch name (expected ${BRANCH_PATTERN.source}, <= ${MAX_BRANCH_LENGTH} chars): ${branch}`);
        }
        const mounted = await this.mountBranch(branch, id, null).catch(error => {
            throw new Error(`Previous leader branch is missing or inaccessible (${branch}): ${error.message}`);
        });
        try {
            const skipped = mounted.staging
                ? await this.materializeBranch(branch, mounted.path, mounted.mount, mounted.sandboxPath)
                : [];
            return {
                id,
                backend: this.name,
                path: mounted.path,
                branch,
                handle: mounted.mount,
                sandboxPath: mounted.sandboxPath,
                staging: mounted.staging,
                stagingInventory: await inventory(mounted.path),
                ...(skipped.length > 0 ? { skippedFiles: skipped } : {}),
            };
        }
        catch (error) {
            await this.discardMount(mounted.mount, mounted.staging ? mounted.path : null);
            throw error;
        }
    }
    /**
     * Fold changes made inside a live Sandbox mount back into the host staging
     * copy before it is evaluated.
     *
     * A worker calls `bash` inside `/workspaces/<n>`; those edits stay in the
     * Sandbox overlay until they are committed. Host edits take precedence: if
     * the staging directory changed, `commit()` is the writer and this returns.
     */
    async reconcile(state) {
        if (!state?.staging || !state.handle || !state.branch)
            return;
        const hostAfter = await inventory(state.path);
        const hostBaseline = state.prelaunchInventory ?? state.stagingInventory ?? {};
        const hostChanged = !jsonEqual(hostAfter, hostBaseline);
        if (hostChanged)
            return;
        const status = this.client.workspace?.status;
        if (typeof status === 'function') {
            let current;
            try {
                current = await this.retry(() => status.call(this.client.workspace, state.handle));
            }
            catch (error) {
                this.logger?.warn?.(`[auto-research] workspace.status unavailable for ${state.id}: ${error.message}`);
                current = null;
            }
            if (current !== null && typeof current === 'object') {
                const record = current;
                const dirtyEntries = Number(record.overlay?.entries ?? record.dirty?.entries ?? 0);
                const dirtyInodes = Number(record.overlay?.inodes ?? record.dirty?.inodes ?? 0);
                const pendingMerge = record.overlay?.pendingMerge === true || record.dirty?.pendingMerge === true;
                const dirtyOverlay = dirtyEntries > 0 || dirtyInodes > 0 || pendingMerge;
                if (dirtyOverlay && typeof this.client.workspace?.commit === 'function') {
                    try {
                        await this.retry(() => this.client.workspace.commit(state.handle, `auto-research: sandbox ${state.id}`));
                    }
                    catch (error) {
                        if (!isStaleMountRefusal(error))
                            throw error;
                    }
                }
                const initialBase = state.handle?.base;
                const headKnownUnchanged = !dirtyOverlay
                    && !record.headMovedSinceMount
                    && typeof initialBase === 'string'
                    && typeof record.branchHead === 'string'
                    && record.branchHead === initialBase
                    && (record.base === undefined || record.base === initialBase);
                if (headKnownUnchanged)
                    return;
            }
        }
        const temporary = join(this.output, `${state.id}-reconcile-${randomUUID()}`);
        try {
            await fsp.mkdir(temporary, { recursive: true });
            const skipped = await this.materializeBranch(state.branch, temporary, state.handle, state.sandboxPath ?? null);
            if (skipped.length > 0) {
                state.skippedFiles = [...new Set([...(state.skippedFiles ?? []), ...skipped])];
            }
            const branchInv = await inventory(temporary);
            const branchBaseline = state.stagingInventory ?? {};
            if (jsonEqual(branchInv, branchBaseline))
                return;
            for (const name of Object.keys(branchBaseline)) {
                if (Object.hasOwn(branchInv, name))
                    continue;
                if ((state.skippedFiles ?? []).includes(name))
                    continue;
                await fsp.rm(join(state.path, name), { force: true });
            }
            for (const name of Object.keys(branchInv).sort()) {
                const target = join(state.path, name);
                await fsp.mkdir(dirname(target), { recursive: true });
                await fsp.copyFile(join(temporary, name), target);
            }
            state.stagingInventory = branchInv;
            state.prelaunchInventory = await inventory(state.path);
        }
        finally {
            await fsp.rm(temporary, { recursive: true, force: true }).catch(() => { });
        }
    }
    async commit(state, { message = 'auto-research: verified state' } = {}) {
        if (!state?.handle)
            return;
        if (state.staging) {
            await this.syncStaging(state, message);
            return;
        }
        await this.retry(() => {
            const method = this.client.workspace?.commit;
            if (typeof method !== 'function')
                return Promise.resolve();
            return method.call(this.client.workspace, state.handle, message);
        });
    }
    async release(state, { discard = false } = {}) {
        if (!state?.handle)
            return;
        const unmount = (drop) => this.retry(() => {
            const method = this.client.workspace?.unmount;
            if (typeof method !== 'function')
                return Promise.resolve();
            return method.call(this.client.workspace, state.handle, drop);
        });
        try {
            await unmount(discard);
        }
        catch (error) {
            // A staged (Sandbox-internal) workspace gets its files through
            // `fs.apply`, so its own overlay always differs from its mount base —
            // and the branch HEAD has moved past the handle — even after the branch
            // holds exactly those bytes. The branch is the record; the sandbox
            // overlay is dropped rather than refusing to unmount.
            if (discard || !state.staging || !isStaleMountRefusal(error))
                throw error;
            this.logger?.info?.('[auto-research] staged workspace overlay differs from its published branch; unmounting with discard');
            await unmount(true);
        }
    }
    async close() {
        if (!this.ownsClient)
            return;
        // `loadLayerfs` returns a close that releases the SDK client and the
        // environment patch it published, in one place.
        if (this.releaseEnvironment) {
            await this.releaseEnvironment();
            return;
        }
        await this.client.close?.();
    }
    async retainCompletedState(row) {
        // A verified epoch has to reach its own branch before the next epoch
        // mutates the same workspace in place.
        if (row._state?.handle && row._state.branch) {
            await this.commit(row._state, { message: `auto-research: verified ${row.id}` });
        }
        return retainCompletedState(this.output, row);
    }
    async restoreCompletedState(checkpoint, failedRow) {
        const restored = await restoreCompletedState(this.output, checkpoint, failedRow);
        // A restored folder has no branch; give it one so `LATEST.json` never
        // records `leader_branch: null` for a LayerFS run.
        const branchState = await this.baseline(restored.workspace, `${failedRow.id}-last-completed`, { sync: true });
        restored.workspace = branchState.path;
        restored._state = branchState;
        restored._ownsState = true;
        await writeJsonAtomic(join(this.output, failedRow.id, 'RESULT.json'), publicRow(restored));
        return restored;
    }
}
/** Whether a mount path exists directly on the host filesystem. */
async function hostDirectory(path) {
    if (!isAbsolute(path))
        return null;
    try {
        const stat = await fsp.stat(path);
        return stat.isDirectory() ? path : null;
    }
    catch {
        return null;
    }
}
/** List every file path (absolute, `/`-rooted) in a LayerFS branch. */
async function listBranchFiles(fs, branch) {
    const files = [];
    const list = fs.list;
    if (typeof list !== 'function')
        return files;
    const walk = async (path) => {
        let pagePos = 0;
        while (true) {
            const page = await list(branch, path, 1000, pagePos);
            const items = Array.isArray(page)
                ? page
                : page?.items;
            if (!Array.isArray(items) || items.length === 0)
                return;
            for (const raw of items) {
                const name = typeof raw.name === 'string' ? raw.name : typeof raw.path === 'string' ? raw.path : null;
                if (!name)
                    continue;
                const full = path === '/' ? `/${name.replace(/^\/+/, '')}` : `${path}/${name.replace(/^\/+/, '')}`;
                const type = String(raw.type ?? raw.kind ?? '');
                const directory = raw.isDirectory === true || type === 'directory' || type === 'dir';
                if (directory)
                    await walk(full);
                else
                    files.push(full);
            }
            if (!page?.hasMore)
                return;
            const nextPagePos = page?.nextPagePos;
            // An explicit cursor wins; otherwise advance by the page we just read,
            // and never let a non-advancing cursor loop forever.
            pagePos = typeof nextPagePos === 'number' && nextPagePos > pagePos
                ? nextPagePos
                : pagePos + items.length;
        }
    };
    await walk('/');
    return files;
}
/** Common facade used by the runner. */
export class WorkspaceManager {
    backend;
    output;
    constructor(backend, { output } = {}) {
        this.backend = backend;
        this.output = output;
    }
    get kind() {
        return this.backend.name;
    }
    async baseline(source, id) {
        return this.backend.baseline(source, id);
    }
    async fork(parent, id) {
        return this.backend.fork(parent, id);
    }
    async adopt(branch, id) {
        if (typeof this.backend.adopt !== 'function') {
            throw new Error('This workspace backend cannot adopt an existing branch');
        }
        return this.backend.adopt(branch, id);
    }
    async commit(state, options) {
        return this.backend.commit(state, options);
    }
    async release(state, options) {
        return this.backend.release(state, options);
    }
    async retainCompletedState(row) {
        return this.backend.retainCompletedState(row);
    }
    async restoreCompletedState(checkpoint, failedRow) {
        return this.backend.restoreCompletedState(checkpoint, failedRow);
    }
    async reconcile(state) {
        if (typeof this.backend.reconcile !== 'function')
            return;
        await this.backend.reconcile(state);
    }
    async close() {
        await this.backend.close?.();
    }
}
/** Every `DSH_LAYERFS_*` name a `dsh` session may publish. */
export const LAYERFS_ENV_KEYS = [
    'DSH_LAYERFS_PROJECT',
    'DSH_LAYERFS_SDK',
    'DSH_LAYERFS_OPERATOR',
    'DSH_LAYERFS_CLI',
    'DSH_LAYERFS_SKILL',
    'DSH_LAYERFS_HOME',
    'DSH_LAYERFS_STORE_PATH',
    'DSH_LAYERFS_DOCKER',
    'DSH_LAYERFS_IMAGE',
    'DSH_LAYERFS_VOLUME',
    'DSH_LAYERFS_DAEMON',
    'DSH_LAYERFS_CONTAINER_PREFIX',
    'DSH_LAYERFS_DAEMON_HOST',
    'DSH_LAYERFS_STORE_CONTAINER',
    'DSH_LAYERFS_BUNDLE',
    'DSH_LAYERFS_WSL_ENDPOINT',
    'DSH_LAYERFS_TRACE',
    'DSH_LAYERFS_TRACE_STEP',
    'DSH_LAYERFS_TRACE_START',
];
/**
 * Names the SDK reads either bare (`LAYERFS_<NAME>`, preferred) or with the
 * `DSH_` prefix. A session publication must win over a stale bare value, so
 * `loadLayerfs` mirrors both names while a client is alive.
 */
const SDK_DEPLOYMENT_NAMES = [
    'HOME',
    'STORE_PATH',
    'DOCKER',
    'IMAGE',
    'VOLUME',
    'DAEMON',
    'CONTAINER_PREFIX',
    'DAEMON_HOST',
    'STORE_CONTAINER',
    'BUNDLE',
    'WSL_ENDPOINT',
    'TRACE',
    'TRACE_STEP',
    'TRACE_START',
];
/** Setting field -> `DSH_LAYERFS_*` name, shared by resolution and publication. */
const LAYERFS_SETTING_KEYS = [
    ['project', 'DSH_LAYERFS_PROJECT'],
    ['sdk', 'DSH_LAYERFS_SDK'],
    ['operator', 'DSH_LAYERFS_OPERATOR'],
    ['cli', 'DSH_LAYERFS_CLI'],
    ['skill', 'DSH_LAYERFS_SKILL'],
    ['home', 'DSH_LAYERFS_HOME'],
    ['storePath', 'DSH_LAYERFS_STORE_PATH'],
    ['docker', 'DSH_LAYERFS_DOCKER'],
    ['image', 'DSH_LAYERFS_IMAGE'],
    ['volume', 'DSH_LAYERFS_VOLUME'],
    ['daemon', 'DSH_LAYERFS_DAEMON'],
    ['containerPrefix', 'DSH_LAYERFS_CONTAINER_PREFIX'],
    ['daemonHost', 'DSH_LAYERFS_DAEMON_HOST'],
    ['storeContainer', 'DSH_LAYERFS_STORE_CONTAINER'],
    ['bundle', 'DSH_LAYERFS_BUNDLE'],
    ['wslEndpoint', 'DSH_LAYERFS_WSL_ENDPOINT'],
    ['trace', 'DSH_LAYERFS_TRACE'],
    ['traceStep', 'DSH_LAYERFS_TRACE_STEP'],
    ['traceStart', 'DSH_LAYERFS_TRACE_START'],
];
/**
 * Resolve LayerFS deployment settings from explicit config or the session's
 * `DSH_LAYERFS_*` environment (the same names `ctx.shellEnv` exposes).
 *
 * An explicitly configured field always wins, including an explicit `null`;
 * the session environment only fills the fields the config leaves undefined.
 * Returns null when no project or SDK is configured.
 */
export function resolveLayerfsConfig(env = process.env, explicit = undefined) {
    if (explicit === false)
        return null;
    const extra = explicit && typeof explicit === 'object' ? explicit : {};
    const read = (key) => {
        const value = env[key];
        return typeof value === 'string' && value.length > 0 ? value : undefined;
    };
    const pick = (field, envKey) => {
        const value = extra[field];
        if (value !== undefined)
            return typeof value === 'string' && value.length > 0 ? value : null;
        return read(envKey) ?? null;
    };
    const project = pick('project', 'DSH_LAYERFS_PROJECT');
    const sdk = pick('sdk', 'DSH_LAYERFS_SDK');
    if (!project || !sdk)
        return null;
    const settings = {
        project,
        sdk,
        operator: pick('operator', 'DSH_LAYERFS_OPERATOR'),
        cli: pick('cli', 'DSH_LAYERFS_CLI'),
        skill: pick('skill', 'DSH_LAYERFS_SKILL'),
        storePath: pick('storePath', 'DSH_LAYERFS_STORE_PATH'),
        home: pick('home', 'DSH_LAYERFS_HOME'),
        trace: pick('trace', 'DSH_LAYERFS_TRACE'),
        traceStep: pick('traceStep', 'DSH_LAYERFS_TRACE_STEP'),
        docker: pick('docker', 'DSH_LAYERFS_DOCKER'),
        image: pick('image', 'DSH_LAYERFS_IMAGE'),
        volume: pick('volume', 'DSH_LAYERFS_VOLUME'),
        daemon: pick('daemon', 'DSH_LAYERFS_DAEMON'),
        containerPrefix: pick('containerPrefix', 'DSH_LAYERFS_CONTAINER_PREFIX'),
        daemonHost: pick('daemonHost', 'DSH_LAYERFS_DAEMON_HOST'),
        storeContainer: pick('storeContainer', 'DSH_LAYERFS_STORE_CONTAINER'),
        bundle: pick('bundle', 'DSH_LAYERFS_BUNDLE'),
        wslEndpoint: pick('wslEndpoint', 'DSH_LAYERFS_WSL_ENDPOINT'),
        traceStart: pick('traceStart', 'DSH_LAYERFS_TRACE_START'),
        syncBaseline: extra.syncBaseline ?? true,
    };
    return settings;
}
/**
 * Build the non-secret `DSH_LAYERFS_*` environment handed to workers.
 *
 * Ambient session values seed the result, then resolved settings overwrite
 * every non-empty field so an explicit `config.layerfs` binding wins. The
 * optional `explicit` binding is applied last, which also lets an explicit
 * `null` suppress an ambient value.
 */
export function layerfsEnvironment(env = process.env, settings = null, explicit = undefined) {
    const result = {};
    for (const key of LAYERFS_ENV_KEYS) {
        const value = env[key];
        if (typeof value === 'string' && value.length > 0)
            result[key] = value;
    }
    if (settings) {
        for (const [field, key] of LAYERFS_SETTING_KEYS) {
            const value = settings[field];
            if (typeof value === 'string' && value.length > 0)
                result[key] = value;
        }
    }
    if (explicit && typeof explicit === 'object') {
        for (const [field, key] of LAYERFS_SETTING_KEYS) {
            const value = explicit[field];
            if (value === undefined)
                continue;
            if (typeof value === 'string' && value.length > 0)
                result[key] = value;
            else
                delete result[key];
        }
    }
    return result;
}
/** `DSH_LAYERFS_*` trace keys that describe one call, never a worker. */
export const LAYERFS_TRACE_KEYS = [
    'DSH_LAYERFS_TRACE',
    'DSH_LAYERFS_TRACE_STEP',
    'DSH_LAYERFS_TRACE_START',
];
/**
 * Drop the transient SDK trace keys from a copied environment.
 *
 * The coordinator's `shellEnv` carries `DSH_LAYERFS_TRACE` and a
 * `DSH_LAYERFS_TRACE_STEP` naming *its* call. A worker that inherited those
 * would append its SDK calls to the coordinator's trace file under a stale step
 * id, corrupting both records; the worker's own `ctx.shellEnv` execution sets
 * them correctly instead.
 */
export function withoutLayerfsTrace(environment) {
    const result = { ...environment };
    for (const key of LAYERFS_TRACE_KEYS)
        delete result[key];
    return result;
}
/**
 * Resolve the environment contributed by `ctx.shellEnv` (the same service
 * `@dsh-layerfs/host` binds). Host versions expose contributors, `resolve`,
 * `snapshot` or a plain `env`; all shapes are handled and merged.
 */
export async function resolveShellEnvironment(ctx, agent) {
    // A Cordis context throws when an un-injected service is read as a
    // property, so `get(name)` is the only safe lookup; the property form is a
    // fallback for host snapshots that ignore `inject`.
    let service;
    if (typeof ctx.get === 'function') {
        try {
            service = ctx.get('shellEnv');
        }
        catch {
            service = undefined;
        }
    }
    if (!service) {
        try {
            service = ctx.shellEnv;
        }
        catch {
            service = undefined;
        }
    }
    if (!service || typeof service !== 'object')
        return {};
    // `dsh`'s `ShellEnvRegistry.collect(execution)` is a `ToolExecution`: its
    // contributors read `execution.rootCallId ?? execution.callId` (for example
    // `@dsh-layerfs/host` labels the SDK trace step with it). A malformed
    // execution would publish `DSH_LAYERFS_TRACE_STEP: "undefined"`, so a
    // complete synthetic execution is always supplied.
    const execution = { agent, callId: SHELL_ENV_CALL_ID, rootCallId: SHELL_ENV_CALL_ID };
    const merged = {};
    const absorb = (value) => {
        if (!value || typeof value !== 'object')
            return;
        for (const [key, entry] of Object.entries(value)) {
            if (typeof entry === 'string')
                merged[key] = entry;
            else if (entry === null || entry === undefined)
                delete merged[key];
        }
    };
    if (service.env && typeof service.env === 'object')
        absorb(service.env);
    for (const method of ['collect', 'resolve', 'snapshot']) {
        const fn = service[method];
        if (typeof fn === 'function') {
            try {
                absorb(await fn.call(service, execution));
            }
            catch {
                // A host without this contributor style simply contributes nothing.
            }
        }
    }
    const contributors = service.contributors ?? service.sources;
    if (Array.isArray(contributors)) {
        for (const contributor of contributors) {
            if (typeof contributor === 'function') {
                try {
                    absorb(await contributor(execution));
                }
                catch {
                    // Ignore a contributor that cannot resolve for this agent.
                }
                continue;
            }
            if (!contributor || typeof contributor !== 'object')
                continue;
            absorb(contributor);
            for (const method of ['contribute', 'resolve', 'snapshot', 'env']) {
                const fn = contributor[method];
                if (typeof fn === 'function') {
                    try {
                        absorb(await fn.call(contributor, execution));
                    }
                    catch {
                        // Ignore a contributor that cannot resolve for this agent.
                    }
                }
                else if (method === 'env' && fn && typeof fn === 'object') {
                    absorb(fn);
                }
            }
        }
    }
    const result = {};
    for (const [key, value] of Object.entries(merged)) {
        if (typeof value === 'string')
            result[key] = value;
    }
    return result;
}
/** The synthetic tool-call id used for a session-wide environment snapshot. */
export const SHELL_ENV_CALL_ID = 'auto-research-env';
function moduleUrl(specifier) {
    if (specifier.startsWith('file:') || specifier.startsWith('node:'))
        return specifier;
    if (isAbsolute(specifier) || specifier.startsWith('.'))
        return pathToFileURL(resolve(specifier)).href;
    return specifier;
}
/**
 * Deployment values as the `DSH_LAYERFS_*` environment `@dsh-layerfs/host`
 * publishes for a session, keyed without the prefix.
 */
export function layerfsDeployment(settings) {
    const values = {
        PROJECT: settings.project,
        SDK: settings.sdk,
        OPERATOR: settings.operator,
        CLI: settings.cli,
        SKILL: settings.skill,
        HOME: settings.home,
        STORE_PATH: settings.storePath,
        DOCKER: settings.docker,
        IMAGE: settings.image,
        VOLUME: settings.volume,
        DAEMON: settings.daemon,
        CONTAINER_PREFIX: settings.containerPrefix,
        DAEMON_HOST: settings.daemonHost,
        STORE_CONTAINER: settings.storeContainer,
        BUNDLE: settings.bundle,
        WSL_ENDPOINT: settings.wslEndpoint,
        TRACE: settings.trace,
        TRACE_STEP: settings.traceStep,
        TRACE_START: settings.traceStart,
    };
    const result = {};
    for (const [name, value] of Object.entries(values)) {
        if (typeof value === 'string' && value.length > 0)
            result[name] = value;
    }
    return result;
}
/**
 * Per-target lease stacks.
 *
 * Two research batches may run in one process with different LayerFS
 * bindings. A naive save/restore map lets the first batch's release clobber
 * the second batch's variables. A stack keeps each key correct for every live
 * lease and restores the true baseline only when the last lease ends.
 */
const ENVIRONMENT_LEASES = new WeakMap();
function environmentMap(target) {
    let map = ENVIRONMENT_LEASES.get(target);
    if (!map) {
        map = new Map();
        ENVIRONMENT_LEASES.set(target, map);
    }
    return map;
}
/**
 * Set `patch` on `target` until the returned lease is released.
 *
 * A patch value of `undefined` only *observes* the key: it establishes a lease
 * (so a concurrent release cannot restore over it) without changing the value.
 * `activate()` re-asserts this lease's own values, which lets a caller keep its
 * binding active across another caller's release. Releasing a lease while
 * another one is live makes that other lease's newest value active again, and
 * the true baseline is restored only when the last lease ends.
 */
export function applyEnvironmentPatch(patch, target) {
    const id = Symbol('environment-lease');
    const leases = environmentMap(target);
    const touched = [];
    const values = new Map();
    for (const [key, value] of patch) {
        let entry = leases.get(key);
        if (!entry) {
            entry = { baseline: typeof target[key] === 'string' ? target[key] : undefined, stack: [] };
            leases.set(key, entry);
        }
        if (!touched.includes(key))
            touched.push(key);
        if (value !== undefined) {
            const top = entry.stack.at(-1);
            if (top?.id === id)
                top.value = value;
            else
                entry.stack.push({ id, value });
            values.set(key, value);
            target[key] = value;
        }
        else {
            // Observe-only lease: keep the current effective value visible to the
            // stack so a concurrent release cannot restore the baseline over it.
            const top = entry.stack.at(-1);
            if (top?.id !== id) {
                entry.stack.push({ id, value: typeof target[key] === 'string' ? target[key] : undefined });
            }
        }
    }
    const activate = () => {
        // Re-assert *this* lease's values: another batch may have changed the
        // process environment while this one was between SDK calls.
        for (const [key, value] of values)
            target[key] = value;
    };
    const release = (() => {
        for (const key of touched) {
            const entry = leases.get(key);
            if (!entry)
                continue;
            const index = entry.stack.findIndex(lease => lease.id === id);
            if (index >= 0)
                entry.stack.splice(index, 1);
            if (entry.stack.length > 0) {
                // Another batch is still running: its newest value becomes active.
                const top = entry.stack.at(-1);
                if (top.value === undefined)
                    delete target[key];
                else
                    target[key] = top.value;
                continue;
            }
            if (entry.baseline === undefined)
                delete target[key];
            else
                target[key] = entry.baseline;
            leases.delete(key);
        }
    });
    release.activate = activate;
    return release;
}
function layerfsEnvironmentPatch(settings) {
    const deployment = layerfsDeployment(settings);
    const patch = [];
    for (const [name, value] of Object.entries(deployment)) {
        patch.push([`DSH_LAYERFS_${name}`, value]);
        if (SDK_DEPLOYMENT_NAMES.includes(name))
            patch.push([`LAYERFS_${name}`, value]);
    }
    return patch;
}
/**
 * Publish one session's LayerFS binding on `process.env` until the returned
 * lease is released.
 *
 * The SDK constructor, its ported entry (`@dsh-layerfs/host/src/port/sdk.js`,
 * which reads `DSH_LAYERFS_BUNDLE` at import time) and its ported native
 * binding (`.../port/binding.js`, which reads `DSH_LAYERFS_STORE_CONTAINER`
 * and `DSH_LAYERFS_BUNDLE` on every call) all take deployment settings from
 * the process environment. A `dsh` session publishes them through
 * `ctx.shellEnv` instead, so they have to be mirrored here — and kept until
 * the client closes, never only around construction. Both the `DSH_LAYERFS_`
 * and the bare `LAYERFS_` spelling are set, because the SDK prefers the bare
 * one and a stale bare value would otherwise silently win.
 */
export function applyLayerfsEnvironment(settings, target = process.env) {
    return applyEnvironmentPatch(layerfsEnvironmentPatch(settings), target);
}
/**
 * Import the LayerFS SDK and construct its client and optional operator.
 *
 * The resolved binding is published on `process.env` for the whole lifetime
 * of the returned client (release it with `close`), because the ported macOS
 * SDK reads its Store container and bundle from the environment at import
 * time and on every call.
 */
export async function loadLayerfs(settings) {
    // The SDK entry chooses its own native binding at import time; `LAYERFS_NATIVE`
    // is leased (not written) so closing one client cannot restore a stale value
    // over a concurrent client.
    const releaseSettings = applyEnvironmentPatch([
        ...layerfsEnvironmentPatch(settings),
        ['LAYERFS_NATIVE', process.env.LAYERFS_NATIVE],
    ], process.env);
    const release = () => {
        releaseSettings();
    };
    let client;
    try {
        const sdk = await import(__rewriteRelativeImportExtension(moduleUrl(settings.sdk)));
        const LayerFS = (sdk.LayerFS ?? sdk.default?.LayerFS);
        if (typeof LayerFS !== 'function') {
            throw new Error('LayerFS SDK does not export LayerFS: ' + settings.sdk);
        }
        const options = {};
        if (settings.storePath)
            options.storePath = settings.storePath;
        if (settings.home)
            options.home = settings.home;
        if (settings.trace)
            options.trace = settings.trace;
        if (settings.traceStep)
            options.traceStep = settings.traceStep;
        client = new LayerFS(settings.project, options);
        // The SDK snapshots deployment from the environment when constructed; the
        // client's own options stay authoritative for later calls, so normalise
        // them as well (a host-injected client has none).
        const clientOptions = client.options;
        if (clientOptions) {
            const deploy = { ...(clientOptions.deploy ?? {}) };
            const deployment = {
                docker: settings.docker,
                image: settings.image,
                volume: settings.volume,
                daemon: settings.daemon,
                containerPrefix: settings.containerPrefix,
                daemonHost: settings.daemonHost,
                storeContainer: settings.storeContainer,
                bundle: settings.bundle,
                wslEndpoint: settings.wslEndpoint,
            };
            for (const [key, value] of Object.entries(deployment)) {
                if (typeof value === 'string' && value.length > 0)
                    deploy[key] = value;
            }
            clientOptions.deploy = deploy;
        }
        let operator = null;
        if (settings.operator) {
            const module = await import(__rewriteRelativeImportExtension(moduleUrl(settings.operator)));
            const LayerFSOperator = (module.LayerFSOperator ?? module.default?.LayerFSOperator);
            if (typeof LayerFSOperator === 'function')
                operator = new LayerFSOperator(client);
        }
        const close = async () => {
            try {
                await client?.close?.();
            }
            finally {
                release();
            }
        };
        return { client, operator, close, activate: releaseSettings.activate };
    }
    catch (error) {
        // A client constructed before the operator failed to load still owns a
        // Store/native handle: close it before the environment is released.
        try {
            await client?.close?.();
        }
        catch {
            // The original failure is the one worth reporting.
        }
        release();
        throw error;
    }
}
/**
 * Build the workspace manager, preferring LayerFS when bound.
 */
export async function createWorkspaceManager({ output, runId, config = {}, env = process.env, layerfs = undefined, }) {
    // `config.layerfs: false` is an explicit opt-out: it must win over a
    // host-injected binding and over ambient DSH_LAYERFS_* variables.
    if (config.layerfs === false || config.workspaceBackend === 'snapshot') {
        return new WorkspaceManager(new SnapshotBackend({ output, runId }), { output });
    }
    const configured = config.layerfs && typeof config.layerfs === 'object' ? config.layerfs : null;
    if (layerfs?.client) {
        const backend = new LayerFSBackend({
            client: layerfs.client,
            ...(layerfs.operator !== undefined ? { operator: layerfs.operator } : {}),
            project: layerfs.project ?? configured?.project ?? 'auto-research',
            output,
            runId,
            syncBaseline: configured?.syncBaseline ?? true,
            ownsClient: false,
        });
        return new WorkspaceManager(backend, { output });
    }
    const settings = resolveLayerfsConfig(env, configured ?? undefined);
    if (settings) {
        const loaded = await loadLayerfs(settings);
        const backend = new LayerFSBackend({
            client: loaded.client,
            operator: loaded.operator,
            project: settings.project,
            output,
            runId,
            syncBaseline: settings.syncBaseline,
            ownsClient: true,
            releaseEnvironment: loaded.close,
            activateEnvironment: loaded.activate,
        });
        return new WorkspaceManager(backend, { output });
    }
    if (config.workspaceBackend === 'layerfs') {
        throw new Error("workspaceBackend is 'layerfs' but no LayerFS project or SDK is configured");
    }
    return new WorkspaceManager(new SnapshotBackend({ output, runId }), { output });
}
/**
 * Resolve the optional compact research seed named by `plan.workspace`.
 * It must be a regular, symlink-free subdirectory inside `root`.
 */
export async function selectPlanWorkspace(root, plan) {
    const requested = plan?.workspace;
    if (requested === undefined || requested === null)
        return root;
    if (typeof requested !== 'string' || requested.length === 0) {
        throw new Error('Plan workspace must be a nonempty relative directory');
    }
    if (isAbsolute(requested)) {
        throw new Error('Plan workspace must be strictly contained in the assigned checkout');
    }
    const parts = requested.split(/[\\/]/).filter(Boolean);
    if (parts.length === 0 || parts.includes('..') || parts.includes('.auto-research-methods')) {
        throw new Error('Plan workspace must be a regular compact subdirectory, not prior runtime');
    }
    await ensureNoSymlink(root, parts);
    const chosen = await fsp.realpath(join(root, ...parts));
    const realRoot = await fsp.realpath(root);
    if (chosen === realRoot || !isContained(realRoot, chosen)) {
        throw new Error('Plan workspace must be a regular compact subdirectory, not prior runtime');
    }
    const stat = await fsp.stat(chosen);
    if (!stat.isDirectory())
        throw new Error('Plan workspace must be a directory');
    return chosen;
}
//# sourceMappingURL=layerfs-workspace.js.map