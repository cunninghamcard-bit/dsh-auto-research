/**
 * Strict TypeScript contracts for the `dsh-auto-research/colab` executor backend.
 *
 * Bridges local multi-branch `dsh + LayerFS` runs to a remote Google Colab GPU
 * runtime through a serialized mutex queue and SHA-256 manifest verification.
 */
/** Configuration accepted by the `dsh-auto-research/colab` sub-plugin. */
export interface ColabConfig {
    /** Base HTTPS/HTTP URL of the Colab worker server (e.g. `https://xxx.trycloudflare.com`). */
    endpoint?: string | null;
    /** Bearer token authenticating requests to the Colab worker server. */
    token?: string | null;
    /** Path to a mode-0600 JSON file containing `{ endpoint, token, timeoutSeconds }`. */
    connectionFile?: string | null;
    /** Per-request execution timeout in seconds once the GPU lock is acquired (default: `300`). */
    timeoutSeconds?: number;
    /** HTTP transport timeout in seconds including queue wait across branches (default: `max(timeoutSeconds * 4 + 30, 600)`). */
    queueTimeoutSeconds?: number;
    /** Maximum workspace payload size in bytes before upload is refused (default: 32 MiB). */
    maxPayloadBytes?: number;
    /** Whether to register `DSH_COLAB_*` in `ctx.shellEnv` (default: `true`). */
    injectShellEnv?: boolean;
    /** Optional custom path to the CLI entry script injected as `DSH_COLAB_CLI`. */
    cliPath?: string | null;
    /** Allow non-loopback `http://` endpoints (default: `false`; loopback `http://127.0.0.1` is always allowed). */
    allowInsecureHttp?: boolean;
}
/** Normalized Colab configuration with defaults applied. */
export interface ResolvedColabConfig {
    endpoint: string | null;
    token: string | null;
    connectionFile: string | null;
    timeoutSeconds: number;
    queueTimeoutSeconds: number;
    maxPayloadBytes: number;
    injectShellEnv: boolean;
    cliPath: string;
    allowInsecureHttp: boolean;
}
/** One workspace file entry serialized for remote Colab execution. */
export interface ColabFileEntry {
    /** Relative POSIX path inside the workspace. */
    path: string;
    /** Lowercase hex SHA-256 of the raw file bytes. */
    sha256: string;
    /** Base64-encoded file content. */
    contentBase64: string;
    /** File mode bits (e.g. `0o644` or `0o755`). */
    mode: number;
}
/** Health and GPU hardware telemetry returned by `GET /health`. */
export interface ColabHealthResponse {
    ok: boolean;
    gpu_available: boolean;
    gpu_name: string | null;
    gpu_count: number;
    vram_total_mb: number;
    cuda_version: string | null;
    torch_version: string | null;
    python_version: string;
    queue_depth: number;
    active_job_id: string | null;
}
/** Request payload for `POST /exec` (worker pre-flight GPU command). */
export interface ColabExecRequest {
    /** Canonical UUID v4 idempotency key for this job. */
    id: string;
    /** Optional compilation/warmup argv executed in parallel BEFORE acquiring the GPU mutex lock. */
    compile_command?: string[];
    /** Command argv to execute inside the isolated remote workspace while holding the GPU mutex lock. */
    command: string[];
    /** Whether to flush GPU L2 cache and empty CUDA cache before running `command` (default: `false`). */
    cold_l2_flush?: boolean;
    /** Workspace files to materialize before running `command`. */
    files: ColabFileEntry[];
    /** Canonical SHA-256 of the `{ [path]: sha256 }` manifest. */
    workspace_manifest_sha256: string;
    /** Execution timeout in seconds. */
    timeout_seconds: number;
    /** Additional non-secret environment variables for the command. */
    env?: Record<string, string>;
}
/** Response payload from `POST /exec`. */
export interface ColabExecResponse {
    ok: boolean;
    id: string;
    exit_code: number | null;
    timed_out: boolean;
    stdout: string;
    stderr: string;
    duration_ms: number;
    compile_duration_ms?: number;
    gpu_name: string | null;
    workspace_manifest_sha256: string;
    error?: string;
}
/** Request payload for `POST /evaluate` (authoritative `FrozenEvaluator` GPU scoring). */
export interface ColabEvalRequest {
    /** Canonical UUID v4 idempotency key for this evaluation. */
    id: string;
    /** Filename of the frozen evaluator script (e.g. `evaluator.py`). */
    evaluator_filename: string;
    /** Base64-encoded bytes of the frozen evaluator script. */
    evaluator_base64: string;
    /** Expected lowercase hex SHA-256 of the frozen evaluator script. */
    evaluator_sha256: string;
    /** Candidate workspace files to materialize read-only for the evaluator. */
    files: ColabFileEntry[];
    /** Canonical SHA-256 of the `{ [path]: sha256 }` workspace inventory. */
    workspace_manifest_sha256: string;
    /** Evaluation timeout in seconds. */
    timeout_seconds: number;
}
/** Response payload from `POST /evaluate`. */
export interface ColabEvalResponse {
    ok: boolean;
    id: string;
    exit_code: number | null;
    timed_out: boolean;
    stdout: string;
    stderr: string;
    duration_ms: number;
    gpu_name: string | null;
    evaluator_sha256: string;
    workspace_manifest_sha256: string;
    workspace_mutated: boolean;
    /** Parsed JSON output emitted by the frozen evaluator on stdout, if valid JSON. */
    evaluation?: Record<string, unknown> | null;
    error?: string;
}
//# sourceMappingURL=types.d.ts.map