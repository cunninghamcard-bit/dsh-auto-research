/**
 * `SubagentProvider` named `auto-research`.
 *
 * One activation runs one complete research Batch. Setup failures reject
 * `start()` before publication; after the handle is returned, every terminal
 * outcome settles through `result` (never a rejection), as the seam requires.
 */
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { createWorkspaceManager, inventory, isContained, jsonEqual, layerfsEnvironment, resolveLayerfsConfig, resolveShellEnvironment, selectPlanWorkspace, withoutLayerfsTrace, writeJsonAtomic, } from './layerfs-workspace.js';
import { FrozenEvaluator } from './evaluator.js';
import { ResearchStoppedError, Runner } from './runner.js';
/** Out-of-process capability advertisement: no parent-enforced start features. */
export const NO_START_CAPABILITIES = Object.freeze({
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
});
const MAX_DIAGNOSTIC_BYTES = 4096;
const DIAGNOSTIC_SUFFIX = '\n[diagnostic truncated]';
const PREFERRED_WORKERS = ['claude-code', 'codex', 'acp', 'dsh-sdk', 'spawn'];
/** Normalize plugin config (also used by the Cordis standard schema). */
export function resolveConfig(input = {}) {
    const config = input && typeof input === 'object' && !Array.isArray(input)
        ? input
        : {};
    if (config.rounds !== undefined)
        requirePositiveInteger(config.rounds, 'rounds');
    if (config.branches !== undefined)
        requirePositiveInteger(config.branches, 'branches');
    for (const key of ['explorationMinutes', 'exploitationMinutes', 'sharingIntervalMinutes']) {
        if (config[key] !== undefined)
            requirePositiveNumber(config[key], key);
    }
    for (const key of ['rsiTop', 'forkAndFlush', 'shareContext']) {
        if (config[key] !== undefined && typeof config[key] !== 'boolean') {
            throw new Error(`${key} must be a boolean`);
        }
    }
    if (config.workspaceBackend !== undefined
        && config.workspaceBackend !== 'auto'
        && config.workspaceBackend !== 'layerfs'
        && config.workspaceBackend !== 'snapshot') {
        throw new Error("workspaceBackend must be 'auto', 'layerfs' or 'snapshot'");
    }
    for (const key of ['providerName', 'planPath', 'workerProvider']) {
        if (config[key] !== undefined)
            requireNonEmptyString(config[key], key);
    }
    const resolved = {
        providerName: config.providerName ?? 'auto-research',
        planPath: config.planPath ?? '.auto-research-methods/plan.json',
        rounds: config.rounds ?? 1,
        branches: config.branches ?? 4,
        explorationMinutes: config.explorationMinutes ?? 30,
        exploitationMinutes: config.exploitationMinutes ?? 30,
        rsiTop: config.rsiTop ?? false,
        forkAndFlush: config.forkAndFlush ?? false,
        shareContext: config.shareContext ?? false,
        sharingIntervalMinutes: config.sharingIntervalMinutes ?? 10,
        workerEnv: config.workerEnv ?? {},
    };
    if (config.workerProvider !== undefined)
        resolved.workerProvider = config.workerProvider;
    if (config.workspaceBackend !== undefined)
        resolved.workspaceBackend = config.workspaceBackend;
    if (config.layerfs !== undefined)
        resolved.layerfs = config.layerfs;
    if (config.plan !== undefined)
        resolved.plan = config.plan;
    return resolved;
}
function requirePositiveInteger(value, name) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
    }
}
function requirePositiveNumber(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error(`${name} must be a positive finite number`);
    }
}
function requireNonEmptyString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} must be a non-empty string`);
    }
}
/** Extract the standalone user text from a `ContentBlock[]` or string. */
export function extractPromptText(prompt) {
    if (typeof prompt === 'string')
        return prompt;
    if (!Array.isArray(prompt))
        return '';
    return prompt
        .map(block => {
        if (typeof block === 'string')
            return block;
        if (!block || typeof block !== 'object')
            return '';
        const record = block;
        if (record.type === 'text' && typeof record.text === 'string')
            return record.text;
        if (typeof record.text === 'string')
            return record.text;
        return '';
    })
        .filter(Boolean)
        .join('\n');
}
function looksLikePlan(value) {
    return Boolean(value) && typeof value === 'object'
        && typeof value.objective === 'string'
        && typeof value.evaluator === 'string';
}
/**
 * Find a plan object embedded in a delegation prompt: a fenced JSON block, a
 * `PLAN_JSON:` line, or a prompt that is itself the JSON object.
 */
export function parsePlanFromPrompt(text) {
    if (typeof text !== 'string' || text.trim() === '')
        return null;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
    for (const match of text.matchAll(fenced)) {
        try {
            const value = JSON.parse(match[1]);
            if (looksLikePlan(value))
                return value;
        }
        catch {
            // Try the next block.
        }
    }
    const marker = /PLAN_JSON:\s*(\{[\s\S]*\})\s*$/m.exec(text);
    if (marker) {
        try {
            const value = JSON.parse(marker[1]);
            if (looksLikePlan(value))
                return value;
        }
        catch {
            // Fall through to the whole-prompt attempt.
        }
    }
    try {
        const value = JSON.parse(text.trim());
        return looksLikePlan(value) ? value : null;
    }
    catch {
        return null;
    }
}
async function readJson(path) {
    return JSON.parse(await fsp.readFile(path, 'utf8'));
}
async function pathExists(path) {
    try {
        await fsp.access(path);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Resolve the plan from config, the plan file, or the delegation prompt.
 */
export async function resolvePlan({ cwd, config, promptText, }) {
    if (config.plan && typeof config.plan === 'object') {
        return { plan: { ...config.plan }, source: 'config' };
    }
    const planPath = isAbsolute(config.planPath) ? config.planPath : resolve(cwd, config.planPath);
    if (await pathExists(planPath)) {
        const value = await readJson(planPath);
        if (!looksLikePlan(value))
            throw new Error(`Research plan is incomplete: ${planPath}`);
        return { plan: value, source: planPath };
    }
    const embedded = parsePlanFromPrompt(promptText);
    if (embedded)
        return { plan: embedded, source: 'prompt' };
    throw new Error(`No research plan: write ${config.planPath} (or include a PLAN_JSON object in the delegation prompt)`);
}
function truncateDiagnostic(text) {
    const value = String(text ?? '');
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length <= MAX_DIAGNOSTIC_BYTES)
        return value;
    const suffix = Buffer.from(DIAGNOSTIC_SUFFIX, 'utf8');
    let end = MAX_DIAGNOSTIC_BYTES - suffix.length;
    while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000)
        end -= 1;
    return bytes.subarray(0, end).toString('utf8') + DIAGNOSTIC_SUFFIX;
}
function textOutput(text) {
    return [{ type: 'text', text }];
}
/** Strip live handles and obvious secret values before config is serialized. */
function publicConfig(config) {
    const { plan, layerfs, workerEnv, ...rest } = config;
    void plan;
    const safeEnv = {};
    const secret = /(token|key|secret|password|credential)/i;
    for (const [key, value] of Object.entries(workerEnv ?? {})) {
        if (!secret.test(key))
            safeEnv[key] = value;
    }
    // The tri-state opt-out is part of the public contract: CONFIG.json must
    // record `layerfs: false`, not silently drop the field.
    const safeLayerfs = layerfs === false
        ? false
        : layerfs && typeof layerfs === 'object'
            ? layerfs.client
                ? { project: layerfs.project ?? null }
                : layerfs
            : undefined;
    return {
        ...rest,
        workerEnv: safeEnv,
        ...(safeLayerfs !== undefined ? { layerfs: safeLayerfs } : {}),
    };
}
function summaryText(result, output) {
    const leader = result.leader ?? {};
    const pending = result.pending_workspaces ?? [];
    const lines = [
        'Auto-research batch COMPLETED.',
        `status: ${result.status}`,
        `leader: ${leader.id ?? '(none)'}`,
        `score: ${leader.evaluation?.score ?? '(none)'}`,
        `workspace: ${leader.workspace ?? '(none)'}`,
        `run: ${output}`,
        `result: ${join(output, 'RESULT.json')}`,
        `dashboard: ${join(output, 'DASHBOARD.json')}`,
        `leader_file: ${join(output, 'LEADER.json')}`,
        `selections: ${join(output, 'SELECTIONS.json')}`,
        `stop_reason: ${result.stop_reason}`,
        `pending_workspaces: ${pending.length}`,
        ...pending.map(entry => `pending: ${String(entry.workspace ?? '')}`),
        'scope: ' + result.scope,
    ];
    return lines.join('\n');
}
function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
/**
 * Refuse a runtime root that is a symlink escaping the workspace.
 *
 * `.auto-research-methods` holds every branch artifact and the runner lock, so
 * a planted symlink would redirect those writes outside the assigned
 * checkout. A missing runtime root is fine (it is created later).
 */
export async function assertRuntimeRootContained(workspaceRoot, runtimeRoot) {
    let stats;
    try {
        stats = await fsp.lstat(runtimeRoot);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    if (!stats.isSymbolicLink()) {
        if (!stats.isDirectory()) {
            throw new Error(`Auto-research runtime root is not a directory: ${runtimeRoot}`);
        }
        return;
    }
    let realRoot;
    let realRuntime;
    try {
        [realRoot, realRuntime] = await Promise.all([fsp.realpath(workspaceRoot), fsp.realpath(runtimeRoot)]);
    }
    catch (error) {
        throw new Error(`Auto-research runtime root is an unresolvable symlink: ${runtimeRoot} (${error.message})`);
    }
    if (!isContained(realRoot, realRuntime)) {
        throw new Error(`Auto-research runtime root is a symlink escaping the workspace: ${runtimeRoot} -> ${realRuntime}`);
    }
}
/** A lock file that stayed unparsable this recently is still being written. */
const LOCK_WRITE_GRACE_MS = 2000;
/**
 * Acquire `<runtimeRoot>/runner.lock` so two `subagent_auto_research`
 * invocations on one checkout fail loud instead of racing on `LATEST.json`.
 *
 * The payload is written to a unique sibling first and then hard-linked into
 * place, so a lock file is never observable empty or half-written. A stale
 * lock is reclaimed only when its owning PID is gone; an unparsable lock that
 * is younger than {@link LOCK_WRITE_GRACE_MS} is treated as live rather than
 * unlinked, which closes the remaining creation window.
 */
export async function acquireRunnerLock(runtimeRoot, runId, { cwd = runtimeRoot, pid = process.pid, alive = processAlive, now = Date.now, writeGraceMs = LOCK_WRITE_GRACE_MS, } = {}) {
    await fsp.mkdir(runtimeRoot, { recursive: true });
    const path = join(runtimeRoot, 'runner.lock');
    const info = { pid, runId, cwd, started_at: new Date(now()).toISOString() };
    const payload = JSON.stringify(info, null, 2) + '\n';
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const temporary = join(runtimeRoot, `.runner.lock.${pid}.${randomUUID()}`);
        try {
            await fsp.writeFile(temporary, payload, { mode: 0o600 });
            // link() is atomic and refuses an existing target, so the visible lock is
            // always the complete payload.
            await fsp.link(temporary, path);
            let released = false;
            return {
                path,
                info,
                release: async () => {
                    if (released)
                        return;
                    released = true;
                    try {
                        const saved = JSON.parse(await fsp.readFile(path, 'utf8'));
                        if (saved.pid === pid && saved.runId === runId)
                            await fsp.unlink(path);
                    }
                    catch {
                        // Already unlocked or replaced by a newer owner.
                    }
                },
            };
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            let saved = null;
            let readable = true;
            try {
                saved = JSON.parse(await fsp.readFile(path, 'utf8'));
            }
            catch {
                saved = null;
                readable = false;
            }
            const owner = typeof saved?.pid === 'number' ? saved.pid : null;
            if (owner !== null && alive(owner)) {
                throw new Error(`Another auto-research batch is already running for this checkout: ${path} (pid ${owner}, run ${String(saved?.runId ?? 'unknown')})`);
            }
            if (owner === null) {
                // Either a writer that has not finished or a corrupt lock. Only a lock
                // old enough to be certainly abandoned may be removed.
                const stats = await fsp.stat(path).catch(() => null);
                if (stats && now() - stats.mtimeMs < writeGraceMs) {
                    throw new Error(`Another auto-research batch is starting for this checkout: ${path}${readable ? '' : ' (lock still being written)'}`);
                }
            }
            // Stale lock: reclaim only when the owner is definitely gone.
            await fsp.unlink(path).catch(() => { });
        }
        finally {
            await fsp.unlink(temporary).catch(() => { });
        }
    }
    throw new Error(`Could not acquire the auto-research runner lock: ${path}`);
}
/** The worker environment keys this plugin owns in a `dsh` shell registry. */
export const AUTO_RESEARCH_ENV_KEYS = [
    'DSH_AUTO_RESEARCH_WORKER',
    'DSH_AUTO_RESEARCH_BRANCH',
    'DSH_AUTO_RESEARCH_CHECKOUT',
    'DSH_AUTO_RESEARCH_SANDBOX_PATH',
];
/** A `DSH_*` name a `dsh` shell registry accepts as a contributor key. */
const REGISTRY_KEY = /^DSH_[A-Z][A-Z0-9_]*$/;
/**
 * The branch environments of the workers that are running right now.
 *
 * `dsh` rebuilds the `DSH_*` namespace for every model shell call and asks each
 * registered contributor for the values of the calling execution. The runner
 * registers a worker's branch environment before starting its activation and
 * removes it in `finally`, so a worker's own `bash` calls receive
 * `DSH_AUTO_RESEARCH_*` (and the configured `workerEnv`) in their real process
 * environment, while the coordinator's calls receive nothing.
 */
export class WorkerEnvRegistry {
    entries = new Map();
    nextKey = 1;
    get size() {
        return this.entries.size;
    }
    /** @returns every checkout that currently has a live worker. */
    checkouts() {
        return [...this.entries.values()].map(entry => entry.checkout);
    }
    /** Whether `path` is one of the live worker checkouts (or inside it). */
    ownsCheckout(path) {
        const target = resolve(path);
        for (const entry of this.entries.values()) {
            if (isContained(resolve(entry.checkout), target))
                return true;
        }
        return false;
    }
    register({ id, checkout, parentSessionId = null, childSessionId = null, env = {}, }) {
        const key = this.nextKey;
        this.nextKey += 1;
        const entry = {
            key,
            id,
            checkout: resolve(checkout),
            parentSessionId,
            childSessionId,
            env: { ...env },
        };
        this.entries.set(key, entry);
        let disposed = false;
        return {
            id,
            checkout: entry.checkout,
            setChildSession: sessionId => {
                if (!this.entries.has(key))
                    return;
                entry.childSessionId = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
            },
            dispose: () => {
                if (disposed)
                    return;
                disposed = true;
                this.entries.delete(key);
            },
        };
    }
    /** The branch environment for one shell tool execution, or `{}`. */
    resolve(execution) {
        const entry = this.match(execution);
        if (!entry)
            return {};
        // The flag is forced last: a configured `workerEnv` must never be able to
        // claim it is outside a worker session.
        return { ...entry.env, DSH_AUTO_RESEARCH_WORKER: '1' };
    }
    /** The registered entry that belongs to `execution`, if any. */
    match(execution) {
        if (!execution || typeof execution !== 'object')
            return null;
        const agent = execution.agent;
        const session = agent && typeof agent === 'object'
            ? agent.session
            : undefined;
        const header = session?.header ?? null;
        const sessionId = typeof header?.id === 'string' ? header.id : null;
        const cwd = typeof header?.cwd === 'string' ? header.cwd : null;
        const parentSession = typeof header?.parentSession === 'string' ? header.parentSession : null;
        const origin = header?.origin;
        if (sessionId) {
            for (const entry of this.entries.values()) {
                if (entry.childSessionId !== null && entry.childSessionId === sessionId)
                    return entry;
            }
        }
        if (!cwd)
            return null;
        const target = resolve(cwd);
        const matches = [...this.entries.values()]
            .filter(entry => isContained(entry.checkout, target))
            .sort((left, right) => right.checkout.length - left.checkout.length);
        const exact = matches.find(entry => entry.checkout === target);
        if (exact)
            return exact;
        if (matches.length === 1)
            return matches[0];
        if (matches.length === 0)
            return null;
        // Several workers share this checkout tree (cooperative epochs reuse one
        // branch): a declared child/parent session decides, then the newest entry.
        if (origin === 'subagent' || parentSession !== null) {
            const related = matches.find(entry => parentSession !== null && entry.parentSessionId === parentSession);
            return related ?? matches.at(-1);
        }
        return null;
    }
}
/** The runtime session id of a live agent, when the host exposes one. */
export function sessionIdOf(agent) {
    const header = agent?.session?.header;
    return typeof header?.id === 'string' && header.id.length > 0 ? header.id : null;
}
/** Whether `path` sits inside a `.auto-research-methods/runs/` runtime tree. */
export function isInsideRuntimeRuns(path) {
    const parts = resolve(path).split(sep);
    const index = parts.lastIndexOf('.auto-research-methods');
    return index >= 0 && parts[index + 1] === 'runs';
}
/** One-line description for each environment key this plugin owns. */
const WORKER_KEY_DESCRIPTIONS = {
    DSH_AUTO_RESEARCH_WORKER: '1 inside an auto-research branch worker; absent for the coordinator',
    DSH_AUTO_RESEARCH_BRANCH: 'LayerFS branch of this worker checkout (when the workspace backend has one)',
    DSH_AUTO_RESEARCH_CHECKOUT: 'Absolute host checkout this branch worker edits',
    DSH_AUTO_RESEARCH_SANDBOX_PATH: 'Sandbox-internal mount path of this worker checkout (LayerFS only)',
};
/**
 * The `DSH_*` keys the `auto-research` contributor declares.
 *
 * The owned worker keys are always declared; a configured `workerEnv` adds
 * every well-formed `DSH_*` name (except `DSH_LAYERFS_*`, owned by
 * `@dsh-layerfs/host`). Other names cannot travel through a `dsh` shell
 * registry at all, so they stay in the prompt environment only.
 */
export function declaredWorkerEnvKeys(workerEnv = {}) {
    const keys = {};
    for (const name of AUTO_RESEARCH_ENV_KEYS) {
        keys[name] = { description: WORKER_KEY_DESCRIPTIONS[name] };
    }
    for (const name of Object.keys(workerEnv)) {
        if (!REGISTRY_KEY.test(name) || name.startsWith('DSH_LAYERFS_') || Object.hasOwn(keys, name))
            continue;
        keys[name] = { description: 'Configured auto-research worker environment value' };
    }
    return keys;
}
/** One provider instance, normally created by the Cordis plugin entry. */
export class AutoResearchProvider {
    ctx;
    config;
    name;
    capabilities;
    inheritsParentContext;
    /** Branch environments of the workers that are running right now. */
    workerEnvs = new WorkerEnvRegistry();
    /**
     * `DSH_*` keys the shell contributor may return.
     *
     * A `dsh` registry refuses an undeclared key, so the owned keys plus every
     * `DSH_*` name from `config.workerEnv` are declared up front. `DSH_LAYERFS_*`
     * is never declared here: `@dsh-layerfs/host` owns those keys for the same
     * session and a second owner is a hard registration error.
     */
    workerEnvKeys;
    /** Batches whose runner is still alive (used to reject recursive delegation). */
    activeBatches = 0;
    disposeShellEnv = null;
    constructor({ ctx, config = {} }) {
        if (!ctx)
            throw new Error('AutoResearchProvider requires a plugin context');
        this.ctx = ctx;
        this.config = resolveConfig(config);
        this.name = this.config.providerName;
        this.capabilities = NO_START_CAPABILITIES;
        this.inheritsParentContext = false;
        this.workerEnvKeys = declaredWorkerEnvKeys(this.config.workerEnv);
        this.installShellEnvContributor();
    }
    /** Release the shell-env registration (the Cordis fiber normally owns it). */
    dispose() {
        this.disposeShellEnv?.();
        this.disposeShellEnv = null;
    }
    /** The `ctx.shellEnv` service, read without tripping Cordis's inject guard. */
    shellEnvService(context = this.ctx) {
        const holder = context;
        if (!holder)
            return undefined;
        if (typeof holder.get === 'function') {
            try {
                const value = holder.get('shellEnv');
                if (value)
                    return value;
            }
            catch {
                // The service is not injected in this host; try the property fallback.
            }
        }
        try {
            return holder.shellEnv;
        }
        catch {
            return undefined;
        }
    }
    /**
     * Register the branch `shellEnv` contributor once a `dsh` shell registry is
     * available. The registry may be injected after this provider is built, so
     * `ctx.inject` is used when the service is not there yet.
     */
    installShellEnvContributor() {
        const install = (service) => {
            if (!service || typeof service.register !== 'function' || this.disposeShellEnv)
                return;
            try {
                this.disposeShellEnv = service.register(this.workerEnvContributor());
            }
            catch (error) {
                // A host that refuses the registration still runs; workers then rely on
                // the documented prompt environment only.
                this.ctx.logger?.warn?.(`[auto-research] shellEnv contributor unavailable: ${error.message}`);
            }
        };
        const existing = this.shellEnvService();
        if (existing) {
            install(existing);
            return;
        }
        const inject = this.ctx.inject;
        if (typeof inject !== 'function')
            return;
        try {
            ;
            inject.call(this.ctx, ['shellEnv'], child => install(this.shellEnvService(child)));
        }
        catch {
            // shellEnv is optional for this plugin.
        }
    }
    /** The contributor handed to `ctx.shellEnv.register`. */
    workerEnvContributor() {
        return {
            name: 'auto-research',
            variables: this.workerEnvKeys,
            resolve: execution => this.workerEnvFor(execution),
        };
    }
    /**
     * The branch environment for one shell execution, filtered to declared keys.
     *
     * `resolve` is only invoked for a worker's own session (see
     * {@link WorkerEnvRegistry.match}); a coordinator's call gets nothing.
     */
    workerEnvFor(execution) {
        const resolved = this.workerEnvs.resolve(execution);
        const allowed = {};
        for (const [key, value] of Object.entries(resolved)) {
            if (Object.hasOwn(this.workerEnvKeys, key) && typeof value === 'string')
                allowed[key] = value;
        }
        return allowed;
    }
    providerInfo(name) {
        const service = this.ctx.subagents;
        const registry = service.providers;
        if (registry && typeof registry === 'object') {
            const entry = registry instanceof Map ? registry.get(name) : registry[name];
            if (entry && typeof entry === 'object')
                return entry;
        }
        for (const method of ['getProvider', 'get', 'describe']) {
            const fn = service[method];
            if (typeof fn === 'function') {
                try {
                    const value = fn.call(service, name);
                    if (value && typeof value === 'object')
                        return value;
                }
                catch {
                    // Fall through to the next introspection hook.
                }
            }
        }
        return null;
    }
    isRecursiveWorker(name) {
        return name === this.name || name === 'auto-research';
    }
    /**
     * Refuse `subagent_auto_research` from a branch worker.
     *
     * A worker already owns one branch of a running batch: delegating another
     * batch from inside it would recurse forever, race the runner lock of its own
     * checkout, and corrupt `plan.json`. A delegation whose cwd is a live worker
     * checkout or any `runs/` runtime tree is rejected the same way.
     */
    assertNotRecursive(request, cwd) {
        const parent = request.parent;
        const origin = parent?.session?.header?.origin;
        if (origin === 'subagent' || this.workerEnvs.ownsCheckout(cwd) || isInsideRuntimeRuns(cwd)) {
            throw new Error('subagent_auto_research cannot be called recursively by a worker subagent');
        }
    }
    /**
     * Choose the worker provider. Explicit configuration wins (after validation);
     * otherwise external/non-inheriting providers are preferred over in-process
     * context-inheriting providers such as `fork`.
     */
    workerProviderName() {
        const names = typeof this.ctx.subagents?.list === 'function' ? this.ctx.subagents.list() : [];
        const configured = this.config.workerProvider;
        if (configured !== undefined) {
            if (!names.includes(configured)) {
                throw new Error(`worker provider "${configured}" is not registered (available: ${names.join(', ') || 'none'})`);
            }
            if (this.isRecursiveWorker(configured))
                throw new Error('auto-research cannot delegate to itself as a worker');
            return configured;
        }
        const candidates = names.filter(name => !this.isRecursiveWorker(name));
        if (candidates.length === 0)
            throw new Error('auto-research requires at least one other registered subagent provider');
        const external = candidates.filter(name => this.providerInfo(name)?.inheritsParentContext !== true);
        const pool = external.length > 0 ? external : candidates;
        for (const preferred of PREFERRED_WORKERS) {
            if (pool.includes(preferred))
                return preferred;
        }
        return pool[0];
    }
    async start(request) {
        if (!request || typeof request !== 'object')
            throw new Error('auto-research requires a start request');
        if (request.signal?.aborted)
            throw new ResearchStoppedError('auto-research request was aborted before startup');
        const cwd = request.cwd;
        if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
            throw new Error('auto-research child cwd must be an absolute path: ' + String(cwd));
        }
        this.assertNotRecursive(request, cwd);
        const stat = await fsp.stat(cwd).catch(() => null);
        if (!stat?.isDirectory())
            throw new Error('auto-research child cwd is not an accessible directory: ' + cwd);
        if (!request.parent)
            throw new Error('auto-research requires the exact live parent agent');
        const promptText = extractPromptText(request.prompt);
        const { plan, source } = await resolvePlan({ cwd, config: this.config, promptText });
        if (typeof plan.evaluator !== 'string')
            throw new Error('Plan requires an evaluator script');
        if (!isAbsolute(plan.evaluator))
            plan.evaluator = resolve(cwd, plan.evaluator);
        const evaluatorPath = plan.evaluator;
        if (typeof evaluatorPath !== 'string')
            throw new Error('Plan requires an evaluator script');
        const evaluatorStat = await fsp.stat(evaluatorPath).catch(() => null);
        if (!evaluatorStat?.isFile())
            throw new Error('Research plan evaluator does not exist: ' + evaluatorPath);
        const workerProvider = this.workerProviderName();
        const workspaceRoot = await selectPlanWorkspace(cwd, plan);
        const runtimeRoot = join(workspaceRoot, '.auto-research-methods');
        await assertRuntimeRootContained(workspaceRoot, runtimeRoot);
        await assertRuntimeRootContained(workspaceRoot, join(runtimeRoot, 'runs'));
        const seed = resolve(workspaceRoot) !== resolve(cwd);
        if (seed) {
            await assertRuntimeRootContained(cwd, join(cwd, '.auto-research-methods'));
        }
        const runId = randomUUID();
        const output = join(runtimeRoot, 'runs', runId);
        // Take the checkout lock before creating anything: a concurrent batch on
        // the same checkout must fail without leaving an orphan `runs/<runId>`
        // directory or overwriting `SEED.json`.
        const lock = await acquireRunnerLock(runtimeRoot, runId, { cwd });
        this.activeBatches += 1;
        let manager = null;
        let initialState = null;
        let runner = null;
        let released = false;
        const releaseLock = async () => {
            if (released)
                return;
            released = true;
            this.activeBatches = Math.max(0, this.activeBatches - 1);
            await lock.release();
        };
        try {
            await fsp.mkdir(output, { recursive: true });
            if (seed) {
                // The runner stores artifacts inside the compact seed; leave a pointer at
                // the checkout so the coordinator can discover the active seed runtime.
                await writeJsonAtomic(join(cwd, '.auto-research-methods', 'SEED.json'), {
                    seed: workspaceRoot,
                    runtime: runtimeRoot,
                    latest: join(runtimeRoot, 'LATEST.json'),
                });
            }
            const originalManifest = await inventory(workspaceRoot);
            const selectionFile = join(runtimeRoot, 'LATEST.json');
            const shellEnv = await resolveShellEnvironment(this.ctx, request.parent);
            const env = { ...process.env, ...shellEnv };
            const explicitLayerfs = this.config.layerfs;
            const snapshotForced = explicitLayerfs === false || this.config.workspaceBackend === 'snapshot';
            const layerfsConfig = !snapshotForced && explicitLayerfs && typeof explicitLayerfs === 'object' ? explicitLayerfs : null;
            const layerfsSettings = layerfsConfig?.client
                ? null
                : resolveLayerfsConfig(env, snapshotForced ? false : layerfsConfig ?? undefined);
            // An explicit opt-out also stops the session's LayerFS binding from
            // leaking into worker environments.
            const layerfsEnv = snapshotForced
                ? {}
                : withoutLayerfsTrace(layerfsEnvironment(env, layerfsSettings, explicitLayerfs));
            manager = await createWorkspaceManager({
                output,
                runId,
                config: this.config,
                env,
                ...(layerfsConfig?.client ? { layerfs: layerfsConfig } : {}),
            });
            let sourceWorkspace = workspaceRoot;
            if (await pathExists(selectionFile)) {
                let latest = null;
                try {
                    latest = await readJson(selectionFile);
                }
                catch {
                    throw new Error(`Previous run selection is not valid JSON: ${selectionFile}`);
                }
                if (latest?.original_manifest && !jsonEqual(latest.original_manifest, originalManifest)) {
                    throw new Error('Original workspace changed since the last method run. Select/reconcile the intended starting workspace before continuing; all branches preserved.');
                }
                const savedWorkspace = typeof latest?.leader_workspace === 'string' ? latest.leader_workspace : null;
                const savedBranch = typeof latest?.leader_branch === 'string' ? latest.leader_branch : null;
                let adopted = false;
                if (savedWorkspace !== null) {
                    const candidate = savedWorkspace;
                    // Compare resolved paths: `runs` (or the saved workspace) may be a
                    // symlink, and a lexical check alone would let either escape.
                    const [realRuns, realCandidate] = await Promise.all([
                        fsp.realpath(join(runtimeRoot, 'runs')).catch(() => null),
                        fsp.realpath(candidate).catch(() => null),
                    ]);
                    if (isAbsolute(candidate)
                        && realRuns !== null
                        && realCandidate !== null
                        && isContained(realRuns, realCandidate)) {
                        const candidateStat = await fsp.stat(realCandidate).catch(() => null);
                        if (candidateStat?.isDirectory()) {
                            sourceWorkspace = candidate;
                            adopted = true;
                        }
                    }
                }
                if (!adopted && savedBranch !== null) {
                    if (manager.kind !== 'layerfs') {
                        throw new Error(`Previous leader workspace is missing or inaccessible and this checkout has no LayerFS backend to restore branch ${savedBranch}`);
                    }
                    initialState = await manager.adopt(savedBranch, 'initial');
                    sourceWorkspace = initialState.path;
                    adopted = true;
                }
                if (!adopted && (savedWorkspace !== null || savedBranch !== null)) {
                    throw new Error(`Previous leader workspace is missing or inaccessible (workspace=${savedWorkspace ?? '(none)'}, branch=${savedBranch ?? '(none)'})`);
                }
                if (savedWorkspace === null && savedBranch === null) {
                    throw new Error(`Previous run selection in ${selectionFile} has no leader_workspace or leader_branch`);
                }
            }
            const evaluator = new FrozenEvaluator({ plan: plan, output, logger: this.ctx.logger ?? null });
            runner = new Runner({
                config: publicConfig(this.config),
                plan,
                workspace: sourceWorkspace,
                output,
                originalManifest,
                selectionFile,
                deps: {
                    subagents: this.ctx.subagents,
                    workspaceManager: manager,
                    evaluator,
                    ...(initialState ? { initialState } : {}),
                    parent: request.parent,
                    ...(sessionIdOf(request.parent) ? { parentSessionId: sessionIdOf(request.parent) } : {}),
                    ...(request.signal ? { signal: request.signal } : {}),
                    workerProvider,
                    workerEnv: this.config.workerEnv,
                    layerfsEnv,
                    workerEnvRegistry: this.workerEnvs,
                    ...(this.ctx.logger ? { logger: this.ctx.logger } : {}),
                    runId,
                },
            });
            this.ctx.logger?.info?.(`[auto-research] batch ${runId}: plan=${source} workspace=${sourceWorkspace} run=${output} worker=${workerProvider}`);
            const activeRunner = runner;
            const result = (async () => {
                try {
                    const batch = await activeRunner.run();
                    return { output: textOutput(summaryText(batch, output)), stopReason: 'completed' };
                }
                catch (error) {
                    const stopped = error instanceof ResearchStoppedError || request.signal?.aborted === true;
                    if (!stopped) {
                        const message = error instanceof Error ? error.message : String(error);
                        this.ctx.logger?.warn?.(`[auto-research] batch ${runId} failed: ${message}`);
                        try {
                            await fsp.writeFile(join(output, 'RESULT.json'), JSON.stringify({
                                status: 'FAILED',
                                error: message,
                                artifacts_preserved: true,
                            }, null, 2) + '\n');
                        }
                        catch {
                            // The run directory may be unwritable after an external failure.
                        }
                        return {
                            output: textOutput(`Auto-research batch FAILED: ${message}\nrun: ${output}`),
                            diagnostic: truncateDiagnostic(message),
                            stopReason: 'error',
                        };
                    }
                    const pending = activeRunner.pendingWorkspaces();
                    try {
                        await fsp.writeFile(join(output, 'RESULT.json'), JSON.stringify({
                            status: 'STOPPED',
                            stop_reason: 'stopped',
                            pending_workspaces: pending,
                            artifacts_preserved: true,
                        }, null, 2) + '\n');
                    }
                    catch {
                        // Best effort: cancellation must still settle.
                    }
                    const pendingLines = pending.map(entry => `pending: ${String(entry.workspace ?? '')}`);
                    return {
                        output: textOutput([
                            'Auto-research batch STOPPED; artifacts retained.',
                            `run: ${output}`,
                            `pending_workspaces: ${pending.length}`,
                            ...pendingLines,
                        ].join('\n')),
                        diagnostic: truncateDiagnostic('Research stopped; artifacts retained'),
                        stopReason: 'aborted',
                    };
                }
                finally {
                    await activeRunner.releaseAll().catch(() => { });
                    await releaseLock().catch(() => { });
                }
            })();
            let disposal = null;
            return {
                id: runId,
                result,
                dispose: () => {
                    disposal ??= (async () => {
                        activeRunner.stop();
                        await result.catch(() => { });
                        await activeRunner.releaseAll();
                        await releaseLock();
                    })();
                    return disposal;
                },
            };
        }
        catch (error) {
            if (initialState) {
                // The adopted branch is mounted; a startup failure must not leave it
                // behind when the manager (and its client) closes.
                try {
                    await manager?.release(initialState, { discard: false });
                }
                catch (releaseError) {
                    this.ctx.logger?.warn?.(`[auto-research] failed to release the adopted initial state: ${releaseError.message}`);
                }
            }
            await manager?.close().catch(() => { });
            await releaseLock().catch(() => { });
            throw error;
        }
    }
}
/** @returns a provider for the Cordis entry point. */
export function createProvider(options) {
    return new AutoResearchProvider(options);
}
//# sourceMappingURL=provider.js.map