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
import { createWorkspaceManager, inventory, isContained, jsonEqual, layerfsEnvironment, resolveLayerfsConfig, resolveShellEnvironment, selectPlanWorkspace, writeJsonAtomic, } from './layerfs-workspace.js';
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
    if (config.layerfs !== undefined)
        resolved.layerfs = config.layerfs;
    if (config.plan !== undefined)
        resolved.plan = config.plan;
    return resolved;
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
/** One provider instance, normally created by the Cordis plugin entry. */
export class AutoResearchProvider {
    ctx;
    config;
    name;
    capabilities;
    inheritsParentContext;
    constructor({ ctx, config = {} }) {
        if (!ctx)
            throw new Error('AutoResearchProvider requires a plugin context');
        this.ctx = ctx;
        this.config = resolveConfig(config);
        this.name = this.config.providerName;
        this.capabilities = NO_START_CAPABILITIES;
        this.inheritsParentContext = false;
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
        const seed = resolve(workspaceRoot) !== resolve(cwd);
        const runId = randomUUID();
        const output = join(runtimeRoot, 'runs', runId);
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
        const lock = await acquireRunnerLock(runtimeRoot, runId, { cwd });
        let manager = null;
        let initialState = null;
        let runner = null;
        let released = false;
        const releaseLock = async () => {
            if (released)
                return;
            released = true;
            await lock.release();
        };
        try {
            const originalManifest = await inventory(workspaceRoot);
            const selectionFile = join(runtimeRoot, 'LATEST.json');
            const shellEnv = await resolveShellEnvironment(this.ctx, request.parent);
            const env = { ...process.env, ...shellEnv };
            const explicitLayerfs = this.config.layerfs;
            const layerfsConfig = explicitLayerfs && typeof explicitLayerfs === 'object' ? explicitLayerfs : null;
            const layerfsSettings = layerfsConfig?.client
                ? null
                : resolveLayerfsConfig(env, explicitLayerfs === false ? false : layerfsConfig ?? undefined);
            // An explicit opt-out also stops the session's LayerFS binding from
            // leaking into worker environments.
            const layerfsEnv = explicitLayerfs === false
                ? {}
                : layerfsEnvironment(env, layerfsSettings, explicitLayerfs);
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
                    if (isAbsolute(candidate)
                        && isContained(join(runtimeRoot, 'runs'), candidate)
                        && await pathExists(candidate)) {
                        const candidateStat = await fsp.stat(candidate).catch(() => null);
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
                    ...(request.signal ? { signal: request.signal } : {}),
                    workerProvider,
                    workerEnv: this.config.workerEnv,
                    layerfsEnv,
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