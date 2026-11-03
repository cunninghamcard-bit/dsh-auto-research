/**
 * HTTP/HTTPS client and workspace packager for the Colab GPU Queue Server.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OMIT, jsonDigest, sha256 } from '../api.js';
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024; // 32 MiB
const MAX_TIMER_MS = 2_147_483_647;
/** Directories and files omitted when packaging a workspace for remote execution. */
export const REMOTE_OMIT = new Set([
    ...OMIT,
    '.git',
    'node_modules',
    '.venv',
    'venv',
    '__pycache__',
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
function defaultCliPath() {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, 'cli.js');
}
function readConnectionJsonSync(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    }
    catch (error) {
        throw new Error(`Failed to read Colab connection file ${filePath}: ${error.message}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`Invalid JSON in Colab connection file ${filePath}: ${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Colab connection file ${filePath} must contain a JSON object`);
    }
    const obj = parsed;
    return {
        ...(typeof obj.endpoint === 'string' ? { endpoint: obj.endpoint } : {}),
        ...(typeof obj.token === 'string' ? { token: obj.token } : {}),
        ...(typeof obj.timeoutSeconds === 'number' && Number.isFinite(obj.timeoutSeconds)
            ? { timeoutSeconds: obj.timeoutSeconds }
            : {}),
        ...(typeof obj.queueTimeoutSeconds === 'number' && Number.isFinite(obj.queueTimeoutSeconds)
            ? { queueTimeoutSeconds: obj.queueTimeoutSeconds }
            : {}),
        ...(typeof obj.allowInsecureHttp === 'boolean' ? { allowInsecureHttp: obj.allowInsecureHttp } : {}),
    };
}
/**
 * Resolve Colab configuration from explicit options, a `connection.json` file,
 * or ambient `DSH_COLAB_*` environment variables.
 */
export function resolveColabConfig(input = {}, env = process.env) {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const connectionFile = raw.connectionFile !== undefined
        ? (raw.connectionFile ? resolve(String(raw.connectionFile)) : null)
        : (env.DSH_COLAB_CONNECTION ? resolve(env.DSH_COLAB_CONNECTION) : null);
    const fileData = connectionFile ? readConnectionJsonSync(connectionFile) : {};
    const allowInsecureHttp = raw.allowInsecureHttp
        ?? fileData.allowInsecureHttp
        ?? (env.DSH_COLAB_ALLOW_INSECURE_HTTP === '1' || env.DSH_COLAB_ALLOW_INSECURE_HTTP === 'true');
    if (typeof allowInsecureHttp !== 'boolean') {
        throw new Error('Colab allowInsecureHttp must be a boolean');
    }
    const rawEndpoint = raw.endpoint !== undefined
        ? raw.endpoint
        : (fileData.endpoint ?? env.DSH_COLAB_ENDPOINT ?? null);
    const endpoint = typeof rawEndpoint === 'string' && rawEndpoint.trim()
        ? rawEndpoint.trim().replace(/\/+$/, '')
        : null;
    if (endpoint !== null) {
        let parsed;
        try {
            parsed = new URL(endpoint);
        }
        catch {
            throw new Error(`Invalid Colab endpoint URL: ${endpoint}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`Colab endpoint must use http or https: ${endpoint}`);
        }
        if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname) && !allowInsecureHttp) {
            throw new Error(`Colab endpoint over cleartext http:// is only allowed for loopback hosts (${parsed.hostname}); use https:// or set allowInsecureHttp: true`);
        }
    }
    const rawToken = raw.token !== undefined
        ? raw.token
        : (fileData.token ?? env.DSH_COLAB_TOKEN ?? null);
    const token = typeof rawToken === 'string' && rawToken.trim() ? rawToken.trim() : null;
    const timeoutCandidate = raw.timeoutSeconds ?? fileData.timeoutSeconds ?? (env.DSH_COLAB_TIMEOUT_SECONDS ? Number(env.DSH_COLAB_TIMEOUT_SECONDS) : DEFAULT_TIMEOUT_SECONDS);
    if (typeof timeoutCandidate !== 'number' || !Number.isFinite(timeoutCandidate) || timeoutCandidate <= 0) {
        throw new Error('Colab timeoutSeconds must be a positive finite number');
    }
    const defaultQueueTimeout = Math.max(timeoutCandidate * 4 + 30, 600);
    const queueTimeoutCandidate = raw.queueTimeoutSeconds ?? fileData.queueTimeoutSeconds ?? (env.DSH_COLAB_QUEUE_TIMEOUT_SECONDS ? Number(env.DSH_COLAB_QUEUE_TIMEOUT_SECONDS) : defaultQueueTimeout);
    if (typeof queueTimeoutCandidate !== 'number' || !Number.isFinite(queueTimeoutCandidate) || queueTimeoutCandidate <= 0) {
        throw new Error('Colab queueTimeoutSeconds must be a positive finite number');
    }
    const maxPayloadBytes = raw.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    if (typeof maxPayloadBytes !== 'number' || !Number.isFinite(maxPayloadBytes) || maxPayloadBytes <= 0) {
        throw new Error('Colab maxPayloadBytes must be a positive finite number');
    }
    const injectShellEnv = raw.injectShellEnv ?? true;
    if (typeof injectShellEnv !== 'boolean') {
        throw new Error('Colab injectShellEnv must be a boolean');
    }
    const cliPath = typeof raw.cliPath === 'string' && raw.cliPath.trim()
        ? resolve(raw.cliPath.trim())
        : (env.DSH_COLAB_CLI ? resolve(env.DSH_COLAB_CLI) : defaultCliPath());
    return {
        endpoint,
        token,
        connectionFile,
        timeoutSeconds: timeoutCandidate,
        queueTimeoutSeconds: queueTimeoutCandidate,
        maxPayloadBytes,
        injectShellEnv,
        cliPath,
        allowInsecureHttp,
    };
}
/**
 * Write a mode-0600 connection JSON file so worker processes and evaluators can
 * authenticate without exposing tokens in command-line arguments or prompt text.
 */
export async function writeColabConnectionFile(filePath, connection) {
    const resolved = resolve(filePath);
    await fsp.mkdir(dirname(resolved), { recursive: true });
    const payload = JSON.stringify({
        endpoint: connection.endpoint.replace(/\/+$/, ''),
        token: connection.token,
        ...(connection.timeoutSeconds !== undefined ? { timeoutSeconds: connection.timeoutSeconds } : {}),
        ...(connection.queueTimeoutSeconds !== undefined ? { queueTimeoutSeconds: connection.queueTimeoutSeconds } : {}),
        ...(connection.allowInsecureHttp !== undefined ? { allowInsecureHttp: connection.allowInsecureHttp } : {}),
    }, null, 2) + '\n';
    await fsp.writeFile(resolved, payload, { encoding: 'utf8', mode: 0o600 });
    await fsp.chmod(resolved, 0o600).catch(() => { });
    return resolved;
}
function shouldOmitRemoteEntry(name, relPosix) {
    if (REMOTE_OMIT.has(name) || name.startsWith('.env.'))
        return true;
    if (relPosix.startsWith('SHARED_CONTEXT/methods-'))
        return true;
    return false;
}
/**
 * Package a local workspace directory for remote Colab execution.
 *
 * Excludes secrets (`.env*`, `.ssh`, `.git`, etc.), heavy local caches
 * (`node_modules`, `.venv`, `__pycache__`), and `SHARED_CONTEXT/methods-*`
 * while preserving published `SHARED_CONTEXT/*` files so remote inventory
 * digests match `COLAB_WORKER_PY`'s `workspace_inventory()` 100%.
 */
export async function packWorkspaceFiles(workspace, maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES) {
    const root = resolve(workspace);
    const files = [];
    const manifest = {};
    let totalBytes = 0;
    async function walk(current) {
        const entries = await fsp.readdir(current, { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const fullPath = join(current, entry.name);
            const relPosix = relative(root, fullPath).split('\\').join('/');
            if (shouldOmitRemoteEntry(entry.name, relPosix))
                continue;
            const stat = await fsp.lstat(fullPath).catch(() => null);
            if (!stat || stat.isSymbolicLink())
                continue;
            if (stat.isDirectory()) {
                await walk(fullPath);
            }
            else if (stat.isFile()) {
                const content = await fsp.readFile(fullPath);
                totalBytes += content.byteLength;
                if (totalBytes > maxPayloadBytes) {
                    throw new Error(`Workspace payload exceeds maximum allowed size (${maxPayloadBytes} bytes)`);
                }
                const digest = sha256(content);
                manifest[relPosix] = digest;
                files.push({
                    path: relPosix,
                    sha256: digest,
                    contentBase64: content.toString('base64'),
                    mode: stat.mode & 0o777,
                });
            }
        }
    }
    await walk(root);
    return {
        files,
        manifest,
        manifestSha256: jsonDigest(manifest),
        totalBytes,
    };
}
/** Client for communicating with a remote or local Colab GPU Queue Server. */
export class ColabClient {
    config;
    rawConfig;
    baseEnv;
    constructor(config, env = process.env) {
        this.rawConfig = config ? { ...config } : {};
        this.baseEnv = env;
        this.config = resolveColabConfig(this.rawConfig, this.baseEnv);
    }
    requireCredentials() {
        const fresh = resolveColabConfig(this.rawConfig, this.baseEnv);
        if (!fresh.endpoint) {
            throw new Error('Colab endpoint is not configured (set endpoint, DSH_COLAB_CONNECTION, or DSH_COLAB_ENDPOINT)');
        }
        if (!fresh.token) {
            throw new Error('Colab token is not configured (set token, DSH_COLAB_CONNECTION, or DSH_COLAB_TOKEN)');
        }
        return { endpoint: fresh.endpoint, token: fresh.token, resolved: fresh };
    }
    async requestJson(method, path, body, options = {}) {
        const { endpoint, token, resolved } = this.requireCredentials();
        const timeoutSec = options.timeoutSeconds ?? resolved.queueTimeoutSeconds;
        const delayMs = Math.min(MAX_TIMER_MS, Math.max(1, Math.round(timeoutSec * 1000)));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Colab request timed out')), delayMs);
        timer.unref?.();
        const onAbort = () => controller.abort(options.signal?.reason ?? new Error('Colab request aborted'));
        if (options.signal) {
            if (options.signal.aborted)
                onAbort();
            else
                options.signal.addEventListener('abort', onAbort, { once: true });
        }
        try {
            const headers = {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
            };
            let serializedBody;
            if (body !== undefined) {
                headers['Content-Type'] = 'application/json; charset=utf-8';
                serializedBody = JSON.stringify(body);
            }
            const response = await fetch(`${endpoint}${path}`, {
                method,
                headers,
                ...(serializedBody !== undefined ? { body: serializedBody } : {}),
                signal: controller.signal,
            });
            const text = await response.text();
            let parsed = null;
            try {
                parsed = JSON.parse(text);
            }
            catch {
                parsed = null;
            }
            if (!response.ok) {
                const reason = parsed && typeof parsed.error === 'string'
                    ? parsed.error
                    : `HTTP ${response.status}: ${text.slice(0, 200)}`;
                throw new Error(`Colab server error (${response.status}): ${reason}`);
            }
            if (!parsed) {
                throw new Error('Colab server returned non-JSON response');
            }
            return parsed;
        }
        finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        }
    }
    /** Query the Colab GPU server health, hardware telemetry, and current queue depth. */
    async health(options = {}) {
        const res = await this.requestJson('GET', '/health', undefined, {
            timeoutSeconds: options.timeoutSeconds ?? 15,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        if (res.ok !== true) {
            throw new Error(`Colab server health check failed: ${String(res.error ?? 'not ok')}`);
        }
        return res;
    }
    /**
     * Package `workspace` and execute `command` inside an isolated sandbox on the
     * serialized Colab GPU queue.
     */
    async exec(workspace, command, options = {}) {
        if (!Array.isArray(command) || command.length === 0) {
            throw new Error('Colab exec requires a non-empty command array');
        }
        const packed = await packWorkspaceFiles(workspace, this.config.maxPayloadBytes);
        const timeoutSeconds = options.timeoutSeconds ?? this.config.timeoutSeconds;
        const httpTimeoutSeconds = options.queueTimeoutSeconds ?? Math.max(this.config.queueTimeoutSeconds, timeoutSeconds * 2 + 30);
        const payload = {
            id: options.id ?? randomUUID(),
            ...(options.compileCommand && options.compileCommand.length > 0
                ? { compile_command: options.compileCommand.map(String) }
                : {}),
            ...(options.coldL2Flush !== undefined ? { cold_l2_flush: options.coldL2Flush } : {}),
            command: command.map(String),
            files: packed.files,
            workspace_manifest_sha256: packed.manifestSha256,
            timeout_seconds: timeoutSeconds,
            ...(options.env ? { env: options.env } : {}),
        };
        const response = await this.requestJson('POST', '/exec', payload, {
            timeoutSeconds: httpTimeoutSeconds,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        if (response.ok !== true || response.id !== payload.id) {
            throw new Error(`Colab exec response integrity check failed for job ${payload.id}`);
        }
        return response;
    }
    /**
     * Run a frozen evaluator script against `workspace` on the remote Colab GPU
     * while enforcing pre/post SHA-256 integrity of both the evaluator and the
     * candidate workspace.
     */
    async evaluate(evaluatorScriptPath, workspace, options = {}) {
        const resolvedScript = resolve(evaluatorScriptPath);
        const [evalBytes, packed] = await Promise.all([
            fsp.readFile(resolvedScript),
            packWorkspaceFiles(workspace, this.config.maxPayloadBytes),
        ]);
        const evalSha256 = sha256(evalBytes);
        const timeoutSeconds = options.timeoutSeconds ?? this.config.timeoutSeconds;
        const httpTimeoutSeconds = options.queueTimeoutSeconds ?? Math.max(this.config.queueTimeoutSeconds, timeoutSeconds * 4 + 30);
        const payload = {
            id: options.id ?? randomUUID(),
            evaluator_filename: basename(resolvedScript) || 'evaluator.py',
            evaluator_base64: evalBytes.toString('base64'),
            evaluator_sha256: evalSha256,
            files: packed.files,
            workspace_manifest_sha256: packed.manifestSha256,
            timeout_seconds: timeoutSeconds,
        };
        const response = await this.requestJson('POST', '/evaluate', payload, {
            timeoutSeconds: httpTimeoutSeconds,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        if (response.ok !== true || response.id !== payload.id) {
            throw new Error(`Colab evaluate response integrity check failed for job ${payload.id}`);
        }
        if (response.evaluator_sha256 !== evalSha256) {
            throw new Error('Remote evaluator script SHA-256 changed during Colab evaluation');
        }
        if (response.workspace_mutated || response.workspace_manifest_sha256 !== packed.manifestSha256) {
            throw new Error('Evaluator or evaluated workspace changed on Colab; result rejected');
        }
        return response;
    }
}
//# sourceMappingURL=client.js.map