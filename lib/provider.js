/**
 * `SubagentProvider` named `auto-research`.
 *
 * One activation runs one complete research Batch. Setup failures reject
 * `start()` before publication; after the handle is returned, every terminal
 * outcome settles through `result` (never a rejection), as the seam requires.
 */
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { LayerFSWorkspaceFactory, SnapshotWorkspaceFactory, createWorkspaceManager, inventory, isContained, jsonEqual, layerfsEnvironment, resolveLayerfsConfig, resolveShellEnvironment, selectPlanWorkspace, withoutLayerfsTrace, writeJsonAtomic, } from './layerfs-workspace.js';
import { insideWorkerCheckout } from './skills.js';
import { FrozenEvaluator } from './evaluator.js';
import { ResearchStoppedError, Runner, normalizeOptions, resolveWorkerAgentOptions, validatePlan, } from './runner.js';
/** Out-of-process capability advertisement: forwards child `agentOptions` to worker branches. */
export const NO_START_CAPABILITIES = Object.freeze({
    agentOptions: true,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
});
const MAX_DIAGNOSTIC_BYTES = 4096;
const DIAGNOSTIC_SUFFIX = '\n[diagnostic truncated]';
const PREFERRED_WORKERS = ['claude-code', 'codex', 'acp', 'dsh-sdk', 'spawn'];
/** Normalize plugin config (also used by the Cordis standard schema). */
export function resolveConfig(input = {}) {
    if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
        throw new Error('config must be an object');
    }
    const config = input;
    if (config.workerEnv !== undefined
        && (config.workerEnv === null || typeof config.workerEnv !== 'object' || Array.isArray(config.workerEnv))) {
        throw new Error('workerEnv must be an object');
    }
    if (config.rounds !== undefined)
        requirePositiveInteger(config.rounds, 'rounds');
    if (config.branches !== undefined)
        requirePositiveInteger(config.branches, 'branches');
    if (config.parallelism !== undefined)
        requirePositiveInteger(config.parallelism, 'parallelism');
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
    for (const key of ['workerLlmProvider', 'workerModel', 'workerReasoningEffort']) {
        if (config[key] !== undefined && config[key] !== null) {
            requireNonEmptyString(config[key], key);
        }
    }
    if (config.workerAgentOptions !== undefined && config.workerAgentOptions !== null) {
        if (typeof config.workerAgentOptions !== 'object' || Array.isArray(config.workerAgentOptions)) {
            throw new Error('workerAgentOptions must be an object');
        }
    }
    const resolved = {
        providerName: config.providerName ?? 'auto-research',
        planPath: config.planPath ?? '.auto-research-methods/plan.json',
        rounds: config.rounds ?? 1,
        branches: config.branches ?? config.parallelism ?? 4,
        explorationMinutes: config.explorationMinutes ?? 30,
        exploitationMinutes: config.exploitationMinutes ?? 30,
        rsiTop: config.rsiTop ?? false,
        forkAndFlush: config.forkAndFlush ?? false,
        shareContext: config.shareContext ?? false,
        sharingIntervalMinutes: config.sharingIntervalMinutes ?? 10,
        workerEnv: config.workerEnv ?? {},
    };
    if (config.parallelism !== undefined)
        resolved.parallelism = config.parallelism;
    if (config.workerProvider !== undefined)
        resolved.workerProvider = config.workerProvider;
    if (config.workerLlmProvider !== undefined) {
        resolved.workerLlmProvider = config.workerLlmProvider ? config.workerLlmProvider.trim() : null;
    }
    if (config.workerModel !== undefined) {
        resolved.workerModel = config.workerModel ? config.workerModel.trim() : null;
    }
    if (config.workerReasoningEffort !== undefined) {
        resolved.workerReasoningEffort = config.workerReasoningEffort ? config.workerReasoningEffort.trim() : null;
    }
    if (config.workerAgentOptions !== undefined)
        resolved.workerAgentOptions = config.workerAgentOptions;
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
    if (config.planPath === '.auto-research-methods/plan.json') {
        const fallbackPath = resolve(cwd, 'auto-research.json');
        if (await pathExists(fallbackPath)) {
            const value = await readJson(fallbackPath);
            if (!looksLikePlan(value))
                throw new Error(`Research plan is incomplete: ${fallbackPath}`);
            return { plan: value, source: fallbackPath };
        }
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
function redactObjectSecrets(obj, secretPattern) {
    const safe = {};
    for (const [key, value] of Object.entries(obj)) {
        if (!secretPattern.test(key))
            safe[key] = value;
    }
    return safe;
}
/** Strip live handles and obvious secret values before config is serialized. */
function publicConfig(config) {
    const { plan, layerfs, workerEnv, ...rest } = config;
    void plan;
    const secret = /(token|key|secret|password|credential)/i;
    const safeEnv = redactObjectSecrets(workerEnv ?? {}, secret);
    // The tri-state opt-out is part of the public contract: CONFIG.json must
    // record `layerfs: false`, not silently drop the field.
    const safeLayerfs = layerfs === false
        ? false
        : layerfs && typeof layerfs === 'object'
            ? layerfs.client
                ? { project: layerfs.project ?? null }
                : redactObjectSecrets(layerfs, secret)
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
            // Stale lock: reclaim atomically by moving to a unique stale path and
            // verifying its owner is still dead before deleting.
            const stalePath = join(runtimeRoot, `.runner.lock.stale.${pid}.${randomUUID()}`);
            try {
                await fsp.rename(path, stalePath);
                let movedSaved = null;
                try {
                    movedSaved = JSON.parse(await fsp.readFile(stalePath, 'utf8'));
                }
                catch {
                    movedSaved = null;
                }
                const movedOwner = typeof movedSaved?.pid === 'number' ? movedSaved.pid : null;
                if (movedOwner !== null && movedOwner !== owner && alive(movedOwner)) {
                    await fsp.link(stalePath, path).catch(() => { });
                    await fsp.unlink(stalePath).catch(() => { });
                    throw new Error(`Another auto-research batch is already running for this checkout: ${path} (pid ${movedOwner})`);
                }
                await fsp.unlink(stalePath).catch(() => { });
            }
            catch (reclaimErr) {
                if (reclaimErr instanceof Error && reclaimErr.message.startsWith('Another auto-research batch')) {
                    throw reclaimErr;
                }
            }
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
    /** Called whenever a worker starts or stops (the skill catalog depends on it). */
    onChange = null;
    resolveCwd;
    constructor(options = {}) {
        this.resolveCwd = options.resolveCwd ?? null;
    }
    get size() {
        return this.entries.size;
    }
    /** @returns every checkout that currently has a live worker. */
    checkouts() {
        return [...this.entries.values()].map(entry => entry.checkout);
    }
    /** Whether `sessionId` is the child session of a live worker. */
    hasChildSession(sessionId) {
        for (const entry of this.entries.values()) {
            if (entry.childSessionId === sessionId)
                return true;
        }
        return false;
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
        this.onChange?.();
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
                this.onChange?.();
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
        const record = execution;
        const agent = record.agent;
        const agentRecord = agent !== null && typeof agent === 'object'
            ? agent
            : null;
        // `dsh` copies the *parent* header (and its root cwd) onto a child session
        // and stores the worker's assigned checkout as a working-directory change,
        // so neither `header.cwd` nor `agent.cwd` alone identifies the branch.
        const session = record.session ?? agentRecord?.session;
        const sessionRecord = session !== null && typeof session === 'object'
            ? session
            : null;
        const header = sessionRecord?.header ?? null;
        const sessionId = typeof header?.id === 'string' && header.id.length > 0 ? header.id : null;
        const parentSession = typeof header?.parentId === 'string' && header.parentId.length > 0
            ? header.parentId
            : typeof header?.parentSession === 'string' && header.parentSession.length > 0
                ? header.parentSession
                : null;
        const origin = header?.origin;
        const executionCwd = typeof record.cwd === 'string' && record.cwd.length > 0 ? record.cwd : null;
        if (sessionId) {
            for (const entry of this.entries.values()) {
                if (entry.childSessionId !== null && entry.childSessionId === sessionId)
                    return entry;
            }
        }
        // A grandchild (a peer reviewer started by a branch worker) carries the
        // worker's session as its parent.
        if (parentSession !== null) {
            for (const entry of this.entries.values()) {
                if (entry.childSessionId !== null && entry.childSessionId === parentSession)
                    return entry;
            }
        }
        const candidates = [];
        const addCandidate = (value) => {
            if (typeof value !== 'string' || value.length === 0)
                return;
            if (!candidates.includes(value))
                candidates.push(value);
        };
        addCandidate(executionCwd);
        addCandidate(this.resolveCwd?.(session, agent));
        const entries = Array.isArray(sessionRecord?.entries) ? sessionRecord.entries : [];
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index];
            if (entry === null || typeof entry !== 'object')
                continue;
            if (entry.type !== 'working-directory/change')
                continue;
            const change = entry;
            const value = change.cwd ?? change.data?.cwd;
            if (typeof value === 'string' && value.length > 0) {
                addCandidate(value);
                break;
            }
        }
        addCandidate(agentRecord?.cwd);
        addCandidate(header?.cwd);
        for (const cwd of candidates) {
            const target = resolve(cwd);
            const matches = [...this.entries.values()]
                .filter(entry => !(sessionId !== null && entry.parentSessionId !== null && entry.parentSessionId === sessionId))
                .filter(entry => isContained(entry.checkout, target))
                .sort((left, right) => right.checkout.length - left.checkout.length);
            const exact = matches.find(entry => entry.checkout === target);
            if (exact)
                return exact;
            if (matches.length === 1)
                return matches[0];
            if (matches.length === 0)
                continue;
            // Several workers share this checkout tree (cooperative epochs reuse one
            // branch): a declared child/parent session decides, then the newest entry.
            if (origin === 'subagent' || parentSession !== null || executionCwd !== null) {
                const related = matches.find(entry => parentSession !== null && entry.parentSessionId === parentSession);
                return related ?? matches.at(-1);
            }
        }
        return null;
    }
}
/** The runtime session id of a live agent, when the host exposes one. */
export function sessionIdOf(agent) {
    const header = agent?.session?.header;
    return typeof header?.id === 'string' && header.id.length > 0 ? header.id : null;
}
/** One-line description for each environment key this plugin owns. */
const WORKER_KEY_DESCRIPTIONS = {
    DSH_AUTO_RESEARCH_WORKER: '1 inside an auto-research branch worker; absent for the coordinator',
    DSH_AUTO_RESEARCH_BRANCH: 'LayerFS branch of this worker checkout (when the workspace backend has one)',
    DSH_AUTO_RESEARCH_CHECKOUT: 'Absolute host checkout this branch worker edits',
    DSH_AUTO_RESEARCH_SANDBOX_PATH: 'Sandbox-internal mount path of this worker checkout (LayerFS only)',
};
/** `dsh`-owned names that a plugin contributor may never claim. */
export const DSH_RESERVED_ENV_KEYS = new Set([
    'DSH_HOME',
    'DSH_SHELL',
    'DSH_SESSION_ID',
    'DSH_PROFILE',
    'DSH_PROFILE_DIR',
]);
/** Secret-looking names are filtered from prompts, receipts and registries. */
const SECRET_ENV_KEY = /(token|key|secret|password|credential)/i;
/**
 * The `DSH_*` keys the `auto-research` contributor declares.
 *
 * The owned worker keys are always declared; a configured `workerEnv` adds
 * every well-formed `DSH_*` name (except `DSH_LAYERFS_*`, owned by
 * `@dsh-layerfs/host`, and the harness-reserved names). Other names cannot
 * travel through a `dsh` shell registry at all, so they stay in the prompt
 * environment only.
 */
export function declaredWorkerEnvKeys(workerEnv) {
    const keys = {};
    for (const name of AUTO_RESEARCH_ENV_KEYS) {
        keys[name] = { description: WORKER_KEY_DESCRIPTIONS[name] };
    }
    if (!workerEnv || typeof workerEnv !== 'object' || Array.isArray(workerEnv))
        return keys;
    for (const [name, value] of Object.entries(workerEnv)) {
        if (typeof value !== 'string')
            continue;
        if (!REGISTRY_KEY.test(name)
            || name.startsWith('DSH_LAYERFS_')
            || DSH_RESERVED_ENV_KEYS.has(name)
            || SECRET_ENV_KEY.test(name)
            || Object.hasOwn(keys, name))
            continue;
        keys[name] = { description: 'Configured auto-research worker environment value' };
    }
    return keys;
}
/**
 * Concrete registry implementation of `ctx.autoResearch` (`AutoResearchService`).
 *
 * Pre-seeded with `[LayerFSWorkspaceFactory, SnapshotWorkspaceFactory]`, while
 * allowing workspace backend plugins (`layerfsWorkspacePlugin`,
 * `snapshotWorkspacePlugin`, or custom workspace plugins) to register or
 * override backends.
 */
export class AutoResearchServiceImpl {
    backends = [
        new LayerFSWorkspaceFactory(),
        new SnapshotWorkspaceFactory(),
    ];
    registerWorkspaceBackend(factory) {
        const existingIndex = this.backends.findIndex(item => item.name === factory.name);
        if (existingIndex >= 0) {
            this.backends[existingIndex] = factory;
        }
        else {
            // Custom backends registered by plugins take priority before snapshot fallback.
            const snapshotIndex = this.backends.findIndex(item => item.name === 'snapshot');
            if (snapshotIndex >= 0)
                this.backends.splice(snapshotIndex, 0, factory);
            else
                this.backends.push(factory);
        }
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            const idx = this.backends.indexOf(factory);
            if (idx >= 0)
                this.backends.splice(idx, 1);
        };
    }
    getWorkspaceBackend(name) {
        return this.backends.find(item => item.name === name);
    }
    listWorkspaceBackends() {
        return [...this.backends];
    }
}
/** One provider instance, normally created by the Cordis plugin entry. */
export class AutoResearchProvider {
    ctx;
    config;
    name;
    capabilities;
    inheritsParentContext;
    /** Capability registry exposed on `ctx.autoResearch`. */
    service;
    /** Branch environments of the workers that are running right now. */
    workerEnvs = new WorkerEnvRegistry({
        resolveCwd: session => this.sessionWorkingDirectory(session),
    });
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
        this.service = this.autoResearchService() ?? new AutoResearchServiceImpl();
        this.workerEnvKeys = declaredWorkerEnvKeys(this.config.workerEnv);
        this.installShellEnvContributor();
    }
    /** The `ctx.subprocess` service (`@deepseek-ai/dsh-subprocess`), read safely. */
    subprocessService(context = this.ctx) {
        const holder = context;
        if (!holder)
            return undefined;
        if (typeof holder.get === 'function') {
            try {
                const value = holder.get('subprocess');
                if (value)
                    return value;
            }
            catch {
                // The service is not injected in this host; try the property fallback.
            }
        }
        try {
            return holder.subprocess;
        }
        catch {
            return undefined;
        }
    }
    /** Existing `ctx.autoResearch` service if already provided on `ctx`. */
    autoResearchService(context = this.ctx) {
        const holder = context;
        if (!holder)
            return undefined;
        if (typeof holder.get === 'function') {
            try {
                const value = holder.get('autoResearch');
                if (value)
                    return value;
            }
            catch {
                // Not registered via ctx.get.
            }
        }
        try {
            return holder.autoResearch;
        }
        catch {
            return undefined;
        }
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
     * batch from inside it would recurse and race the runner lock. Two signals,
     * either sufficient: the cwd is inside a checkout carrying the runner's
     * `.auto-research-methods/WORKER.json` marker, or the caller's session is a
     * live worker's child session.
     */
    assertNotRecursive(request, cwd) {
        const sessionId = sessionIdOf(request.parent);
        if (insideWorkerCheckout(cwd) || (sessionId !== null && this.workerEnvs.hasChildSession(sessionId))) {
            throw new Error('subagent_auto_research cannot be called recursively by a worker subagent');
        }
    }
    /**
     * The assigned checkout of one session, when the host exposes
     * `ctx.workingDirectory.get(session)`.
     */
    sessionWorkingDirectory(session) {
        let value;
        const context = this.ctx;
        try {
            if (typeof context?.get === 'function')
                value = context.get('workingDirectory');
        }
        catch {
            value = undefined;
        }
        if (!value) {
            try {
                value = context?.workingDirectory;
            }
            catch {
                value = undefined;
            }
        }
        const get = value?.get;
        if (typeof get !== 'function')
            return null;
        try {
            const cwd = get.call(value, session);
            return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
        }
        catch {
            return null;
        }
    }
    /**
     * Choose the worker provider. Explicit configuration wins (after validation);
     * a plan-level override is honored when registered; otherwise external/non-inheriting
     * providers are preferred over in-process context-inheriting providers such as `fork`.
     */
    workerProviderName(planOverride, preferAgentOptions = false) {
        const names = typeof this.ctx.subagents?.list === 'function' ? this.ctx.subagents.list() : [];
        const configured = this.config.workerProvider;
        if (configured !== undefined) {
            if (!names.includes(configured)) {
                throw new Error(`worker provider "${configured}" is not registered (available: ${names.join(', ') || 'none'})`);
            }
            if (this.isRecursiveWorker(configured))
                throw new Error('auto-research cannot delegate to itself as a worker');
        }
        const planRequested = typeof planOverride === 'string' && planOverride.trim().length > 0
            ? planOverride.trim()
            : undefined;
        if (planRequested !== undefined) {
            if (this.isRecursiveWorker(planRequested)) {
                throw new Error('auto-research cannot delegate to itself as a worker');
            }
            if (names.includes(planRequested)) {
                return planRequested;
            }
            this.ctx.logger?.warn?.(`[auto-research] plan requested workerProvider "${planRequested}" which is not registered (available: ${names.join(', ') || 'none'}); falling back to configured/default provider`);
        }
        if (configured !== undefined)
            return configured;
        const candidates = names.filter(name => !this.isRecursiveWorker(name));
        if (candidates.length === 0)
            throw new Error('auto-research requires at least one other registered subagent provider');
        const external = candidates.filter(name => this.providerInfo(name)?.inheritsParentContext !== true);
        const basePool = external.length > 0 ? external : candidates;
        const optionCapable = preferAgentOptions
            ? basePool.filter(name => this.providerInfo(name)?.capabilities?.agentOptions === true)
            : [];
        const pool = optionCapable.length > 0 ? optionCapable : basePool;
        for (const preferred of PREFERRED_WORKERS) {
            if (pool.includes(preferred))
                return preferred;
        }
        return pool[0];
    }
    /**
     * Resolve worker `agentOptions` against the live parent agent's current LLM
     * state and `dsh`'s active `llm` registry so callers only need to specify a
     * model ID or display name (e.g. `glm-5.3-flash` or `GLM Flash`) without
     * hardcoding the internal provider adapter ID.
     */
    async resolveLiveWorkerAgentOptions(rawOptions, parent) {
        if (!rawOptions)
            return null;
        const resolved = { ...rawOptions };
        const parentRecord = parent && typeof parent === 'object'
            ? parent
            : null;
        let headerConfig;
        try {
            headerConfig = parentRecord?.session?.requestHeader?.()?.config;
        }
        catch {
            headerConfig = undefined;
        }
        const parentProvider = typeof headerConfig?.provider === 'string' && headerConfig.provider.length > 0
            ? headerConfig.provider
            : typeof parentRecord?.options?.provider === 'string' && parentRecord.options.provider.length > 0
                ? parentRecord.options.provider
                : undefined;
        if (resolved.provider === undefined && typeof resolved.model === 'string' && resolved.model.includes('/')) {
            const slashIndex = resolved.model.indexOf('/');
            const prefix = resolved.model.slice(0, slashIndex).trim();
            const suffix = resolved.model.slice(slashIndex + 1).trim();
            if (prefix.length > 0 && suffix.length > 0) {
                resolved.provider = prefix;
                resolved.model = suffix;
            }
        }
        const context = this.ctx;
        let llmService = null;
        try {
            const candidate = typeof context?.get === 'function' ? context.get('llm') : context?.llm;
            if (candidate && typeof candidate === 'object') {
                llmService = candidate;
            }
        }
        catch {
            llmService = null;
        }
        if (typeof resolved.model === 'string' && resolved.model.length > 0 && llmService) {
            const targetModel = resolved.model.trim();
            const targetLower = targetModel.toLowerCase();
            const targetTokens = targetLower.split(/[^a-z0-9]+/).filter(Boolean);
            const providerIds = [];
            if (resolved.provider) {
                providerIds.push(resolved.provider);
            }
            else {
                if (parentProvider)
                    providerIds.push(parentProvider);
                try {
                    for (const p of llmService.listProviders?.() ?? []) {
                        if (typeof p?.id === 'string' && p.id.length > 0 && !providerIds.includes(p.id)) {
                            providerIds.push(p.id);
                        }
                    }
                }
                catch {
                    // Ignore provider listing errors and fall back to parentProvider.
                }
            }
            let matched = null;
            for (const providerId of providerIds) {
                let models = [];
                try {
                    models = (await llmService.listModels?.(providerId)) ?? [];
                }
                catch {
                    models = [];
                }
                const exact = models.find(m => m.id === targetModel)
                    ?? models.find(m => m.id.toLowerCase() === targetLower || m.name?.toLowerCase() === targetLower)
                    ?? (targetTokens.length > 0
                        ? models.find(m => {
                            const haystack = `${m.id} ${m.name ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
                            return targetTokens.every(tok => haystack.includes(tok));
                        })
                        : undefined);
                if (exact) {
                    matched = { provider: providerId, model: exact.id };
                    break;
                }
            }
            if (matched) {
                resolved.provider = matched.provider;
                resolved.model = matched.model;
            }
        }
        if (resolved.provider === undefined && parentProvider !== undefined) {
            resolved.provider = parentProvider;
        }
        return resolved;
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
        // Validate the complete plan before any lock, run directory or mount exists.
        validatePlan(plan, normalizeOptions(this.config, plan));
        const planOptionsRecord = plan.options && typeof plan.options === 'object'
            ? plan.options
            : {};
        const workerAgentOptions = await this.resolveLiveWorkerAgentOptions(resolveWorkerAgentOptions(this.config, plan, request.agentOptions), request.parent);
        const planWorkerProvider = plan.workerProvider ?? plan.worker_provider ?? planOptionsRecord.workerProvider;
        const workerProvider = this.workerProviderName(planWorkerProvider, Boolean(workerAgentOptions));
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
                backends: this.service.listWorkspaceBackends(),
            });
            let sourceWorkspace = workspaceRoot;
            let frontier = null;
            if (await pathExists(selectionFile)) {
                let latest = null;
                try {
                    latest = await readJson(selectionFile);
                }
                catch {
                    throw new Error(`Previous run selection is not valid JSON: ${selectionFile}`);
                }
                frontier = latest?.frontier ?? null;
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
            const evaluatorEnv = {};
            for (const [k, v] of Object.entries(process.env)) {
                if (typeof v === 'string')
                    evaluatorEnv[k] = v;
            }
            for (const [k, v] of Object.entries(shellEnv)) {
                if (typeof v === 'string')
                    evaluatorEnv[k] = v;
            }
            const evaluator = new FrozenEvaluator({
                plan: plan,
                output,
                env: evaluatorEnv,
                logger: this.ctx.logger ?? null,
                subprocess: this.subprocessService() ?? null,
            });
            runner = new Runner({
                config: publicConfig(this.config),
                plan,
                workspace: sourceWorkspace,
                output,
                originalManifest,
                selectionFile,
                frontier,
                deps: {
                    subagents: this.ctx.subagents,
                    workspaceManager: manager,
                    evaluator,
                    ...(initialState ? { initialState } : {}),
                    parent: request.parent,
                    ...(sessionIdOf(request.parent) ? { parentSessionId: sessionIdOf(request.parent) } : {}),
                    ...(request.signal ? { signal: request.signal } : {}),
                    workerProvider,
                    ...(workerAgentOptions ? { workerAgentOptions } : {}),
                    workerEnv: this.config.workerEnv,
                    layerfsEnv,
                    workerEnvRegistry: this.workerEnvs,
                    ...(this.ctx.logger ? { logger: this.ctx.logger } : {}),
                    runId,
                },
            });
            this.ctx.logger?.info?.(`[auto-research] batch ${runId}: plan=${source} workspace=${sourceWorkspace} run=${output} worker=${workerProvider}${workerAgentOptions?.model ? ` model=${workerAgentOptions.provider ?? ''}/${workerAgentOptions.model}` : ''}`);
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
                            await writeJsonAtomic(join(output, 'RESULT.json'), {
                                status: 'FAILED',
                                error: message,
                                artifacts_preserved: true,
                            });
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
                        await writeJsonAtomic(join(output, 'RESULT.json'), {
                            status: 'STOPPED',
                            stop_reason: 'stopped',
                            pending_workspaces: pending,
                            artifacts_preserved: true,
                        });
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