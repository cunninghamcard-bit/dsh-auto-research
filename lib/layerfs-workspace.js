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
    '.agents',
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
/** Manifest value prefix for a symlink: `symlink:<link text>`. */
export const SYMLINK = 'symlink:';
/** @returns whether a manifest value records a symlink rather than a content hash. */
export function isLinkEntry(value) {
    return value !== undefined && value.startsWith(SYMLINK);
}
/**
 * Snapshot inventory: relative POSIX path -> SHA-256 for every regular,
 * non-omitted file, and `symlink:<link text>` for every symlink. Links are
 * recorded, never followed, so a snapshot never captures bytes outside the
 * workspace. Other non-regular entries are rejected.
 */
export async function inventory(root) {
    const result = {};
    async function walk(directory) {
        const entries = await fsp.readdir(directory, { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const full = join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                if (omitFile(entry.name) || omitDirectory(directory.split(sep).at(-1), entry.name))
                    continue;
                result[relativePosix(root, full)] = SYMLINK + await fsp.readlink(full);
                continue;
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
/** @returns the sorted paths whose manifest value differs between `before` and `after`. */
export function changedPaths(before, after) {
    const names = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...names].filter(name => before[name] !== after[name]).sort();
}
/** @returns the bytes of `count` full host copies of the tree at `path`. */
export async function hostCopyBytes(path, count) {
    return (await inventoryBytes(path, await inventory(path))) * count;
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
                await fsp.symlink(await fsp.readlink(from), to);
                continue;
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
    return copy;
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
    // Links are recorded by their text and recreated on restore; only regular
    // files go into `checkpoint-objects`.
    const links = {};
    for (const [name, value] of Object.entries(files)) {
        if (!isLinkEntry(value))
            continue;
        links[name] = value.slice(SYMLINK.length);
        delete files[name];
    }
    for (const name of Object.keys(files).sort()) {
        const expected = files[name];
        if (expected === undefined)
            continue;
        const parts = name.split('/');
        if (isAbsolute(name) || parts.includes('..') || parts.length === 0) {
            throw new Error('Invalid retained checkpoint path');
        }
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
    const saved = { row: publicRow(row), files, modes, links };
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
    // Checkpoints written before links were recorded have no `links`.
    for (const [name, link] of Object.entries(saved.links ?? {})) {
        const parts = name.split('/');
        if (isAbsolute(name) || parts.includes('..') || parts.length === 0) {
            throw new Error('Invalid retained checkpoint path');
        }
        const target = join(workspace, name);
        await fsp.mkdir(dirname(target), { recursive: true });
        await fsp.symlink(link, target);
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
    async estimateForkBytes(parent, count) {
        return hostCopyBytes(parent.path, count);
    }
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
 * Whether `fs.read` refused a file because it is not UTF-8 text (`Binary`).
 *
 * A binary adopted file has no text representation to stage, but it is not a
 * lost file: `workspace.exec` can copy the exact bytes, or the file is reported
 * as skipped and never removed from the branch.
 */
export function isSkippableAdoptedFile(error) {
    return refusalCode(error) === 'Binary';
}
/** Quote a path for a POSIX shell command. */
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
/**
 * Whether a commit/unmount refusal of a staged mount only means its overlay
 * differs from the branch it was published to.
 *
 * `fs.apply` writes the branch directly, so the mount's own overlay then
 * disagrees with the moved head: `workspace.commit` refuses with `Conflict`
 * and `workspace.unmount` with `Dirty`. The bytes are already on the branch.
 */
export function isStaleMountRefusal(error) {
    const code = refusalCode(error);
    return code === 'Conflict' || code === 'Dirty';
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
 * LayerFS copy-on-write branch backend (`@layerfs/agent` 1.1).
 *
 * Every Workspace mounts in a Sandbox this backend made with
 * `sandbox.create()`; a Sandbox that closed itself or holds 16 Workspaces is
 * replaced on the next mount. `ownsClient` is false whenever the client was
 * injected by the host (for example `config.layerfs.client`), so `close()`
 * never tears down a shared client.
 */
export class LayerFSBackend {
    name = 'layerfs';
    client;
    project;
    output;
    runId;
    logger;
    syncBaseline;
    ownsClient;
    retryBaseDelayMs;
    /** The Sandbox new Workspaces mount in, shared by concurrent mounts. */
    sandbox = null;
    constructor(options) {
        this.client = options.client;
        this.project = options.project ?? 'auto-research';
        this.output = options.output;
        this.runId = options.runId ?? 'run';
        this.logger = options.logger ?? null;
        this.syncBaseline = options.syncBaseline ?? true;
        this.ownsClient = options.ownsClient ?? false;
        this.retryBaseDelayMs = options.retryBaseDelayMs ?? 150;
    }
    /** @returns a branch name that always fits Docker's 63-character limit. */
    branchName(id) {
        return `ar-${branchSafe(this.runId, 12)}-${branchSafe(id, 44)}`;
    }
    retry(fn) {
        return withBusyRetry(fn, { retries: 6, baseDelayMs: this.retryBaseDelayMs });
    }
    /**
     * Mount `branch` in this backend's Sandbox. A Sandbox closes itself two
     * minutes after its last Workspace, and holds at most 16: either refusal
     * makes one new Sandbox and one more mount.
     */
    async mount(branch) {
        for (let attempt = 0;; attempt += 1) {
            const current = this.sandbox ??= this.retry(() => this.client.sandbox.create()).then(made => made.sandbox);
            let sandbox;
            try {
                sandbox = await current;
            }
            catch (error) {
                if (this.sandbox === current)
                    this.sandbox = null;
                throw error;
            }
            try {
                const mounted = await this.retry(() => this.client.workspace.mount(sandbox, branch));
                return { sandbox: mounted.sandbox, path: mounted.path };
            }
            catch (error) {
                const code = refusalCode(error);
                if (attempt > 0 || (code !== 'NoSuchSandbox' && code !== 'Capacity'))
                    throw error;
                if (this.sandbox === current)
                    this.sandbox = null;
            }
        }
    }
    /**
     * Unmount a workspace whose preparation failed and remove any host staging
     * copy. Cleanup failures are logged, never allowed to mask the original
     * error.
     */
    async discardMount(mount, stagingPath) {
        try {
            if (mount)
                await this.retry(() => this.client.workspace.unmount(mount, true));
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
        await this.retry(() => this.client.workspace.unmount(handle, true));
        state.handle = null;
        const mount = await this.mount(branch);
        state.handle = mount;
        state.sandboxPath = mount.path;
    }
    async mountBranch(branch, id, sourcePath) {
        const mount = await this.mount(branch);
        const host = await hostDirectory(mount.path);
        if (host) {
            return { branch, mount, path: host, sandboxPath: mount.path, staging: false };
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
        return { branch, mount, path: staging, sandboxPath: mount.path, staging: true };
    }
    async syncStaging(state, message) {
        const handle = state.handle;
        const branch = state.branch;
        if (!handle || !branch)
            return;
        const after = await inventory(state.path);
        const before = state.stagingInventory ?? {};
        const changes = [];
        // `mkdir` makes every missing parent and leaves an existing folder alone.
        const directories = new Set();
        for (const name of Object.keys(after).sort()) {
            if (after[name] === before[name])
                continue;
            if (isLinkEntry(after[name])) {
                // `fs.apply` writes no symlink: keep it on the host copy and never
                // treat its absence on the branch as a deletion.
                if (!(state.skippedFiles ?? []).includes(name)) {
                    state.skippedFiles = [...(state.skippedFiles ?? []), name];
                    this.logger?.warn?.(`[auto-research] symlink ${name} stays in the host staging copy; LayerFS fs.apply cannot write links`);
                }
                continue;
            }
            if (name.includes('/'))
                directories.add(name.slice(0, name.lastIndexOf('/')));
            // Text travels as text (the simulator stores strings), anything else as bytes.
            const bytes = await fsp.readFile(join(state.path, name));
            const text = bytes.toString('utf8');
            changes.push(Buffer.from(text, 'utf8').equals(bytes)
                ? { op: 'write', path: '/' + name, content: text }
                : { op: 'write', path: '/' + name, bytes });
        }
        changes.unshift(...[...directories].sort().map(name => ({ op: 'mkdir', path: '/' + name })));
        for (const name of Object.keys(before).sort()) {
            // `Object.hasOwn` so a file literally named `constructor` or `toString`
            // is compared as data, not as an inherited prototype member.
            if (Object.hasOwn(after, name))
                continue;
            // A binary adopted file without a host copy must never be removed from
            // its branch just because the staging directory cannot represent it.
            if ((state.skippedFiles ?? []).includes(name))
                continue;
            // A link was never published, so there is nothing to remove.
            if (isLinkEntry(before[name]))
                continue;
            changes.push({ op: 'rm', path: '/' + name });
        }
        if (changes.length > 0) {
            await this.retry(() => this.client.fs.apply(branch, changes, message));
        }
        state.stagingInventory = after;
    }
    async materializeBranch(branch, destination, mount = null) {
        const skipped = [];
        for (const name of await listBranchFiles(this.client, branch)) {
            const relative = name.replace(/^\/+/, '');
            const target = join(destination, relative);
            try {
                const text = await this.readBranchFile(branch, name);
                await fsp.mkdir(dirname(target), { recursive: true });
                await fsp.writeFile(target, text);
            }
            catch (error) {
                const truncated = refusalCode(error) === 'LineTruncated';
                if (!truncated && !isSkippableAdoptedFile(error))
                    throw error;
                if (mount) {
                    try {
                        // `fs.read` cannot represent a binary file (or a line over 48 KiB),
                        // but the exact bytes are still inside the mounted Sandbox.
                        const source = `${mount.path.replace(/\/+$/, '')}/${relative}`;
                        const command = `sh -c 'base64 < "$1"' -- ${shellQuote(source)}`;
                        const result = await this.retry(() => this.client.workspace.exec(mount, command));
                        if (result.exitCode !== 0)
                            throw new Error(`workspace.exec exited ${String(result.exitCode)}`);
                        if (typeof result.stdout !== 'string')
                            throw new Error('workspace.exec returned no stdout');
                        await fsp.mkdir(dirname(target), { recursive: true });
                        await fsp.writeFile(target, Buffer.from(result.stdout, 'base64'));
                        continue;
                    }
                    catch (execError) {
                        this.logger?.warn?.(`[auto-research] workspace.exec could not copy ${name}: ${execError.message}`);
                    }
                }
                if (truncated) {
                    throw codedError(`LayerFS fs.read truncated a line > 48 KiB in ${name} and workspace.exec could not copy it`, 'LineTruncated');
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
    async readBranchFile(branch, name) {
        let line = 1;
        let text = '';
        while (true) {
            const value = await this.retry(() => this.client.fs.read(branch, name, line));
            if (value.lineTruncated === true) {
                throw codedError(`LayerFS fs.read truncated a line > 48 KiB in ${name}`, 'LineTruncated');
            }
            text += value.text;
            const next = value.nextLine;
            if (typeof next !== 'number' || next <= line)
                return text;
            line = next;
        }
    }
    /** Create the baseline branch from the project's `main`. */
    async forkBaseline(branch) {
        try {
            await this.retry(() => this.client.branch.fork(branch, 'main'));
        }
        catch (error) {
            if (refusalCode(error) !== 'NoSuchProject')
                throw error;
            throw new Error(`LayerFS project ${this.project} does not exist; import the checkout in dsh (project chip → Import project…) first`);
        }
    }
    async baseline(source, id, { sync = this.syncBaseline } = {}) {
        const branch = this.branchName(id);
        await this.forkBaseline(branch);
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
                state.stagingInventory = sync
                    ? Object.fromEntries((await listBranchFiles(this.client, branch)).map(name => [name.replace(/^\/+/, ''), '']))
                    : {};
                await this.syncStaging(state, `auto-research: baseline ${id}`);
                // Publishing moved the branch HEAD past this mount, so the Sandbox
                // view at `/workspaces/<n>` would still show the pre-baseline files.
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
                ? await this.materializeBranch(branch, mounted.path, mounted.mount)
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
     * Settle a staged branch's two writable views before evaluation.
     *
     * The host staging copy is the authoritative writer; the Sandbox mount at
     * `/workspaces/<n>` is for execution. A worker that edits the Sandbox anyway
     * leaves changes in its Workspace. This commits them into the branch
     * history first, whatever the host did, so they are never dropped, then
     * compares both sides with the inventory the staging copy started from:
     *
     * - neither changed: `unchanged`
     * - Sandbox only: fold the branch into the host copy, `folded`
     * - host only: `host`; `commit()` publishes it
     * - both: `conflict`; the host diff is still published by `commit()`, so
     *   both sides stay in the branch history, and the row is invalid because
     *   the evaluated host copy is not the branch state.
     */
    async reconcile(state) {
        const unchanged = { outcome: 'unchanged', conflicts: [] };
        if (!state?.staging || !state.handle || !state.branch)
            return unchanged;
        const hostBaseline = state.prelaunchInventory ?? state.stagingInventory ?? {};
        const hostChanged = changedPaths(hostBaseline, await inventory(state.path));
        const sandbox = await this.sandboxChanges(state);
        if (sandbox === null || sandbox.changed.length === 0) {
            return hostChanged.length > 0 ? { outcome: 'host', conflicts: [] } : unchanged;
        }
        if (hostChanged.length > 0) {
            const sandboxChanged = new Set(sandbox.changed);
            return { outcome: 'conflict', conflicts: hostChanged.filter(name => sandboxChanged.has(name)) };
        }
        const baseline = state.stagingInventory ?? {};
        for (const name of Object.keys(baseline)) {
            if (Object.hasOwn(sandbox.files, name))
                continue;
            if ((state.skippedFiles ?? []).includes(name))
                continue;
            // Links are never published, so a branch without one has not deleted it.
            if (isLinkEntry(baseline[name]))
                continue;
            await fsp.rm(join(state.path, name), { force: true });
        }
        for (const name of Object.keys(sandbox.files).sort()) {
            const target = join(state.path, name);
            await fsp.mkdir(dirname(target), { recursive: true });
            await fsp.copyFile(join(sandbox.directory, name), target);
        }
        await fsp.rm(sandbox.directory, { recursive: true, force: true });
        state.stagingInventory = sandbox.files;
        state.prelaunchInventory = await inventory(state.path);
        return { outcome: 'folded', conflicts: [] };
    }
    /**
     * Commit a changed Sandbox Workspace and report what the branch now holds
     * that the staging copy did not start from.
     *
     * @returns null when the Sandbox's daemon reports the Workspace unchanged and
     *   its branch head unmoved; otherwise the changed paths and a materialized
     *   copy of the branch (the caller removes `directory`).
     */
    async sandboxChanges(state) {
        const handle = state.handle;
        const page = await this.retry(() => this.client.sandbox.list_workspaces(handle.sandbox));
        const record = page.items.find(item => item.path === handle.path);
        if (record?.changed === false && record.headMovedSinceMount === false)
            return null;
        if (record?.changed !== false) {
            // A refused commit throws: the changes are not in the branch history
            // yet, and the remount below would discard them.
            const result = await this.retry(() => this.client.workspace.commit(handle, `auto-research: sandbox ${state.id}`));
            // The branch head moved; the later `commit()` needs a current mount.
            if (result.kind === 'Committed')
                await this.remountStaging(state);
        }
        const directory = join(this.output, `${state.id}-reconcile-${randomUUID()}`);
        try {
            await fsp.mkdir(directory, { recursive: true });
            const skipped = await this.materializeBranch(state.branch, directory, state.handle ?? null);
            if (skipped.length > 0) {
                state.skippedFiles = [...new Set([...(state.skippedFiles ?? []), ...skipped])];
            }
            const files = await inventory(directory);
            const baseline = state.stagingInventory ?? {};
            // Paths the branch cannot hold (links, unreadable binaries) are not
            // Sandbox changes.
            const changed = changedPaths(baseline, files)
                .filter(name => !isLinkEntry(baseline[name]) && !(state.skippedFiles ?? []).includes(name));
            if (changed.length === 0)
                await fsp.rm(directory, { recursive: true, force: true });
            return { changed, files, directory };
        }
        catch (error) {
            await fsp.rm(directory, { recursive: true, force: true }).catch(() => { });
            throw error;
        }
    }
    /**
     * A host-accessible LayerFS mount is copy-on-write and adds nothing up
     * front; a staged mount (or a non-LayerFS parent) is copied to the host.
     */
    async estimateForkBytes(parent, count) {
        if (parent.branch && !parent.staging)
            return 0;
        return hostCopyBytes(parent.path, count);
    }
    async commit(state, { message = 'auto-research: verified state' } = {}) {
        if (!state?.handle)
            return;
        if (state.staging) {
            await this.syncStaging(state, message);
            return;
        }
        const handle = state.handle;
        await this.retry(() => this.client.workspace.commit(handle, message));
    }
    async release(state, { discard = false } = {}) {
        if (!state?.handle)
            return;
        const handle = state.handle;
        const unmount = (drop) => this.retry(() => this.client.workspace.unmount(handle, drop));
        try {
            await unmount(discard);
        }
        catch (error) {
            // A staged workspace gets its files through `fs.apply`, so the branch
            // HEAD has moved past its mount even when the branch holds exactly
            // those bytes. The branch is the record; the Sandbox view is dropped
            // rather than refusing to unmount.
            if (discard || !state.staging || !isStaleMountRefusal(error))
                throw error;
            this.logger?.info?.('[auto-research] staged workspace differs from its published branch; unmounting with discard');
            await unmount(true);
        }
    }
    async close() {
        if (this.ownsClient)
            await this.client.close();
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
async function listBranchFiles(client, branch) {
    const files = [];
    const walk = async (path) => {
        let pagePos = 0;
        while (true) {
            const page = await client.fs.list(branch, path, 1000, pagePos);
            for (const item of page.items) {
                const full = path === '/' ? `/${item.name}` : `${path}/${item.name}`;
                if (item.type === 'dir' || item.type === 'directory')
                    await walk(full);
                else if (item.type === 'file')
                    files.push(full);
            }
            if (!page.hasMore || page.items.length === 0)
                return;
            pagePos += page.items.length;
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
            return { outcome: 'unchanged', conflicts: [] };
        return this.backend.reconcile(state);
    }
    async estimateForkBytes(parent, count) {
        return this.backend.estimateForkBytes(parent, count);
    }
    async close() {
        await this.backend.close?.();
    }
}
/** Every `DSH_LAYERFS_*` name `@dsh-layerfs/host` publishes for a session. */
export const LAYERFS_ENV_KEYS = [
    'DSH_LAYERFS_PROJECT',
    'DSH_LAYERFS_SDK',
    'DSH_LAYERFS_BACKEND',
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
    'DSH_LAYERFS_WORKER_ENDPOINT',
    'DSH_LAYERFS_TRACE',
    'DSH_LAYERFS_TRACE_STEP',
    'DSH_LAYERFS_TRACE_START',
];
/** Setting field -> `DSH_LAYERFS_*` name, shared by resolution and publication. */
const LAYERFS_SETTING_KEYS = [
    ['project', 'DSH_LAYERFS_PROJECT'],
    ['sdk', 'DSH_LAYERFS_SDK'],
    ['backend', 'DSH_LAYERFS_BACKEND'],
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
    ['workerEndpoint', 'DSH_LAYERFS_WORKER_ENDPOINT'],
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
    const pick = (field, envKey) => {
        const value = extra[field] !== undefined ? extra[field] : env[envKey];
        return typeof value === 'string' && value.length > 0 ? value : null;
    };
    const settings = Object.fromEntries(LAYERFS_SETTING_KEYS.map(([field, key]) => [field, pick(field, key)]));
    if (!settings.project || !settings.sdk)
        return null;
    return { ...settings, syncBaseline: extra.syncBaseline ?? true };
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
 * The environment `ctx.shellEnv` (`ShellEnvRegistry.collect`) gives a shell
 * call of `agent`. `@dsh-layerfs/host` contributes the session's
 * `DSH_LAYERFS_*` binding here. Contributors read
 * `execution.rootCallId ?? execution.callId`, so both are set.
 */
export function resolveShellEnvironment(shellEnv, agent) {
    if (!shellEnv)
        return {};
    return { ...shellEnv.collect({ agent, callId: SHELL_ENV_CALL_ID, rootCallId: SHELL_ENV_CALL_ID }) };
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
/** The `LAYERFS_*` names `LayerFS.open` reads, and the settings that fill them. */
const SDK_ENVIRONMENT = [
    ['LAYERFS_HOME', 'home'],
    ['LAYERFS_STORE_PATH', 'storePath'],
    ['LAYERFS_DOCKER', 'docker'],
    ['LAYERFS_IMAGE', 'image'],
    ['LAYERFS_VOLUME', 'volume'],
    ['LAYERFS_DAEMON', 'daemon'],
    ['LAYERFS_CONTAINER_PREFIX', 'containerPrefix'],
    ['LAYERFS_DAEMON_HOST', 'daemonHost'],
    ['LAYERFS_WORKER_ENDPOINT', 'workerEndpoint'],
    ['LAYERFS_TRACE', 'trace'],
];
/** Opens run one at a time: each one owns `process.env`'s `LAYERFS_*` names while it reads them. */
let opening = Promise.resolve();
/**
 * Open the session's LayerFS project with the SDK it names.
 *
 * `LayerFS.open` takes no options: it reads its deployment from `LAYERFS_*`
 * once, while the client is made. A `dsh` session publishes the binding as
 * `DSH_LAYERFS_*` through `ctx.shellEnv`, so the names are set on
 * `process.env` around the open and restored right after it.
 */
export async function loadLayerfs(settings) {
    const open = opening.then(async () => {
        const saved = SDK_ENVIRONMENT.map(([name]) => [name, process.env[name]]);
        for (const [name, field] of SDK_ENVIRONMENT) {
            const value = settings[field];
            if (typeof value === 'string' && value.length > 0)
                process.env[name] = value;
            else
                delete process.env[name];
        }
        try {
            const sdk = await import(__rewriteRelativeImportExtension(moduleUrl(settings.sdk)));
            if (typeof sdk.LayerFS?.open !== 'function') {
                throw new Error('LayerFS SDK does not export LayerFS.open: ' + settings.sdk);
            }
            return await sdk.LayerFS.open(settings.project);
        }
        finally {
            for (const [name, value] of saved) {
                if (value === undefined)
                    delete process.env[name];
                else
                    process.env[name] = value;
            }
        }
    });
    opening = open.catch(() => { });
    return open;
}
/**
 * Concrete `WorkspaceBackendFactory` for LayerFS copy-on-write branches.
 *
 * Returns `null` when LayerFS is opted out (`config.layerfs: false`) or no
 * LayerFS project/SDK is bound.
 */
export class LayerFSWorkspaceFactory {
    name = 'layerfs';
    priority = 100;
    async create({ output, runId, config = {}, env = process.env, layerfs = undefined, }) {
        if (config.layerfs === false)
            return null;
        const configured = config.layerfs && typeof config.layerfs === 'object' ? config.layerfs : null;
        if (layerfs?.client) {
            return new LayerFSBackend({
                client: layerfs.client,
                project: layerfs.project ?? configured?.project ?? 'auto-research',
                output,
                runId,
                syncBaseline: configured?.syncBaseline ?? true,
                ownsClient: false,
            });
        }
        const settings = resolveLayerfsConfig(env, configured ?? undefined);
        if (!settings)
            return null;
        return new LayerFSBackend({
            client: await loadLayerfs(settings),
            project: settings.project,
            output,
            runId,
            syncBaseline: settings.syncBaseline,
            ownsClient: true,
        });
    }
}
/**
 * Resolve the optional compact research seed named by `plan.workspace`.
 * It must resolve to a directory strictly inside `root`.
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