/**
 * Self-contained Python 3 GPU Queue & Verification Server for Google Colab.
 *
 * Modeled after `ara`'s `LeanSearch/server.py` and `DaytonaWorker.py`:
 * - Serializes all GPU executions through a strict mutex (`gpu_lock`) so
 *   concurrent local `LayerFS` branches never contend for the same Colab GPU,
 *   trigger CUDA OOMs, or pollute kernel timing measurements.
 * - Isolates each request inside its own ephemeral `/tmp/dsh-colab-jobs/<id>`
 *   sandbox and verifies per-file and manifest SHA-256 digests before and after
 *   evaluation.
 */
export const COLAB_WORKER_PY = `#!/usr/bin/env python3
"""dsh-auto-research Colab GPU Queue & Frozen-Evaluator Worker Server."""
import argparse
import base64
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid

OMIT_DIRS = {
    ".auto-research-methods",
    ".method-evaluation",
    ".codex",
    ".claude",
    ".aws",
    ".ssh",
    ".azure",
    ".config",
    ".env",
    ".netrc",
    ".npmrc",
    ".git-credentials",
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
}

MAX_HTTP_PAYLOAD_BYTES = 64 * 1024 * 1024


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def json_digest(value) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def safe_relative_path(root: Path, rel: str) -> Path:
    if not isinstance(rel, str) or not rel or rel.startswith("/") or "\\\\" in rel:
        raise ValueError(f"Unsafe relative path: {rel!r}")
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ValueError(f"Unsafe path segments: {rel!r}")
    target = (root / rel).resolve()
    root_resolved = root.resolve()
    if target != root_resolved and root_resolved not in target.parents:
        raise ValueError(f"Path escapes workspace root: {rel!r}")
    return target


def should_omit_entry(name: str, rel_posix: str) -> bool:
    if name in OMIT_DIRS or name.startswith(".env."):
        return True
    if rel_posix.startswith("SHARED_CONTEXT/methods-"):
        return True
    return False


def workspace_inventory(root: Path) -> dict:
    manifest = {}
    root_resolved = root.resolve()
    for current, dirs, files in os.walk(root_resolved, followlinks=False):
        curr_path = Path(current)
        kept_dirs = []
        for d in sorted(dirs):
            full_d = curr_path / d
            if full_d.is_symlink():
                continue
            rel_d = full_d.relative_to(root_resolved).as_posix()
            if should_omit_entry(d, rel_d):
                continue
            kept_dirs.append(d)
        dirs[:] = kept_dirs
        for name in sorted(files):
            full = curr_path / name
            if full.is_symlink() or not full.is_file():
                continue
            rel = full.relative_to(root_resolved).as_posix()
            if should_omit_entry(name, rel):
                continue
            manifest[rel] = sha256_bytes(full.read_bytes())
    return manifest


def probe_gpu() -> dict:
    script = (
        "import json\\n"
        "info = {'gpu_available': False, 'gpu_name': None, 'gpu_count': 0, "
        "'vram_total_mb': 0, 'cuda_version': None, 'torch_version': None}\\n"
        "try:\\n"
        "    import torch\\n"
        "    info['torch_version'] = getattr(torch, '__version__', None)\\n"
        "    info['cuda_version'] = getattr(getattr(torch, 'version', None), 'cuda', None)\\n"
        "    if torch.cuda.is_available():\\n"
        "        info['gpu_available'] = True\\n"
        "        info['gpu_count'] = int(torch.cuda.device_count())\\n"
        "        info['gpu_name'] = str(torch.cuda.get_device_name(0))\\n"
        "        props = torch.cuda.get_device_properties(0)\\n"
        "        info['vram_total_mb'] = int(getattr(props, 'total_memory', 0) // (1024 * 1024))\\n"
        "except Exception:\\n"
        "    pass\\n"
        "print(json.dumps(info))\\n"
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if proc.returncode == 0 and proc.stdout.strip():
            return json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        pass
    return {
        "gpu_available": False,
        "gpu_name": None,
        "gpu_count": 0,
        "vram_total_mb": 0,
        "cuda_version": None,
        "torch_version": None,
    }


def flush_gpu_l2_cache(gpu_available: bool) -> None:
    if not gpu_available:
        return
    script = (
        "try:\\n"
        "    import torch\\n"
        "    if torch.cuda.is_available():\\n"
        "        torch.cuda.empty_cache()\\n"
        "        buf = torch.zeros((16 * 1024 * 1024,), dtype=torch.int32, device='cuda')\\n"
        "        buf.fill_(1)\\n"
        "        torch.cuda.synchronize()\\n"
        "        del buf\\n"
        "        torch.cuda.empty_cache()\\n"
        "except Exception:\\n"
        "    pass\\n"
    )
    try:
        subprocess.run([sys.executable, "-c", script], capture_output=True, timeout=10)
    except Exception:
        pass


def parse_timeout(raw_value, default_sec: float = 300.0) -> float:
    try:
        val = float(raw_value if raw_value is not None else default_sec)
    except (TypeError, ValueError):
        raise ValueError("timeout_seconds must be a positive finite number")
    if not math.isfinite(val) or val <= 0:
        raise ValueError("timeout_seconds must be a positive finite number")
    return min(val, 86400.0)


def run_isolated_process(argv, cwd: Path, env: dict, timeout_sec: float) -> dict:
    start = time.monotonic()
    timed_out = False
    proc = subprocess.Popen(
        argv,
        cwd=str(cwd),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=max(0.1, float(timeout_sec)))
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            stdout, stderr = proc.communicate(timeout=2.0)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                stdout, stderr = proc.communicate(timeout=2.0)
            except subprocess.TimeoutExpired:
                try:
                    if proc.stdout:
                        proc.stdout.close()
                except Exception:
                    pass
                try:
                    if proc.stderr:
                        proc.stderr.close()
                except Exception:
                    pass
                try:
                    proc.wait(timeout=1.0)
                except Exception:
                    pass
                stdout, stderr = "", "[process killed after timeout; child held stdio pipes]"
    duration_ms = int((time.monotonic() - start) * 1000)
    return {
        "exit_code": proc.returncode,
        "timed_out": timed_out,
        "stdout": (stdout or "")[:32 * 1024 * 1024],
        "stderr": (stderr or "")[:4 * 1024 * 1024],
        "duration_ms": duration_ms,
    }


class ColabQueueService:
    def __init__(self, token: str, work_root: Path):
        if not token or len(token) < 16:
            raise ValueError("Server token must be at least 16 characters")
        self.token = token
        self.work_root = work_root.resolve()
        self.work_root.mkdir(parents=True, exist_ok=True)
        self.gpu_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.queue_depth = 0
        self.active_job_id = None
        self.gpu_info = probe_gpu()

    def verify_token(self, header: str) -> bool:
        if not header or not header.startswith("Bearer "):
            return False
        supplied = header[len("Bearer "):].strip()
        return hmac.compare_digest(supplied.encode("utf-8"), self.token.encode("utf-8"))

    def health(self) -> dict:
        with self.state_lock:
            q_depth = self.queue_depth
            active = self.active_job_id
        return {
            "ok": True,
            **self.gpu_info,
            "python_version": platform.python_version(),
            "queue_depth": q_depth,
            "active_job_id": active,
        }

    def materialize_files(self, workspace: Path, files: list, expected_manifest_sha256: str) -> dict:
        if not isinstance(files, list):
            raise ValueError("files must be a list")
        manifest = {}
        for entry in files:
            if not isinstance(entry, dict):
                raise ValueError("Each file entry must be an object")
            rel = entry.get("path")
            raw_b64 = entry.get("contentBase64")
            expected_sha = entry.get("sha256")
            mode = int(entry.get("mode", 0o644)) & 0o777
            if not isinstance(raw_b64, str) or not isinstance(expected_sha, str):
                raise ValueError(f"Invalid file entry for {rel!r}")
            target = safe_relative_path(workspace, rel)
            data = base64.b64decode(raw_b64)
            actual_sha = sha256_bytes(data)
            if actual_sha != expected_sha:
                raise ValueError(f"SHA-256 mismatch for file {rel}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            try:
                os.chmod(target, mode)
            except OSError:
                pass
            manifest[rel] = actual_sha
        computed_manifest = json_digest(manifest)
        if expected_manifest_sha256 and computed_manifest != expected_manifest_sha256:
            raise ValueError("Workspace manifest SHA-256 mismatch")
        return manifest

    def handle_exec(self, payload: dict) -> dict:
        job_id = str(uuid.UUID(str(payload.get("id") or uuid.uuid4())))
        command = payload.get("command")
        if not isinstance(command, list) or not command or not all(isinstance(x, str) for x in command):
            raise ValueError("command must be a non-empty list of strings")
        compile_command = payload.get("compile_command")
        if compile_command is not None:
            if not isinstance(compile_command, list) or not compile_command or not all(isinstance(x, str) for x in compile_command):
                raise ValueError("compile_command must be a non-empty list of strings when provided")
        cold_l2_flush = bool(payload.get("cold_l2_flush", False))
        timeout_sec = parse_timeout(payload.get("timeout_seconds"), 300.0)
        files = payload.get("files", [])
        expected_manifest = str(payload.get("workspace_manifest_sha256", ""))
        extra_env = payload.get("env") or {}

        job_dir = Path(tempfile.mkdtemp(prefix=f"exec-{job_id}-", dir=str(self.work_root)))
        workspace = job_dir / "workspace"
        cache_dir = job_dir / "cache"
        tmp_dir = job_dir / "tmp"
        workspace.mkdir(parents=True, exist_ok=True)
        cache_dir.mkdir(parents=True, exist_ok=True)
        tmp_dir.mkdir(parents=True, exist_ok=True)
        queued = False
        try:
            manifest = self.materialize_files(workspace, files, expected_manifest)
            env = os.environ.copy()
            env.pop("DSH_COLAB_TOKEN", None)
            env["PYTHONDONTWRITEBYTECODE"] = "1"
            env["TMPDIR"] = str(tmp_dir)
            env["DSH_COLAB_JOB_ID"] = job_id
            env["TRITON_CACHE_DIR"] = str(cache_dir / "triton")
            env["TORCHINDUCTOR_CACHE_DIR"] = str(cache_dir / "inductor")
            if cold_l2_flush:
                env["DSH_COLAB_COLD_L2_FLUSH"] = "1"
            for k, v in extra_env.items():
                if isinstance(k, str) and isinstance(v, str):
                    env[k] = v

            # Stage 1 (Optional): Parallel compilation outside the GPU mutex lock
            compile_duration_ms = 0
            if compile_command:
                comp_run = run_isolated_process(compile_command, workspace, env, timeout_sec)
                compile_duration_ms = comp_run["duration_ms"]
                if comp_run["exit_code"] != 0 or comp_run["timed_out"]:
                    return {
                        "ok": True,
                        "id": job_id,
                        **comp_run,
                        "compile_duration_ms": compile_duration_ms,
                        "gpu_name": self.gpu_info.get("gpu_name"),
                        "workspace_manifest_sha256": json_digest(workspace_inventory(workspace) or manifest),
                    }

            # Stage 2: Serialized execution inside the hardware GPU mutex lock
            with self.state_lock:
                self.queue_depth += 1
                queued = True
            with self.gpu_lock:
                with self.state_lock:
                    self.queue_depth -= 1
                    queued = False
                    self.active_job_id = job_id
                try:
                    if cold_l2_flush:
                        flush_gpu_l2_cache(bool(self.gpu_info.get("gpu_available")))
                    run = run_isolated_process(command, workspace, env, timeout_sec)
                finally:
                    with self.state_lock:
                        self.active_job_id = None
            after_manifest = workspace_inventory(workspace)
            return {
                "ok": True,
                "id": job_id,
                **run,
                "compile_duration_ms": compile_duration_ms,
                "gpu_name": self.gpu_info.get("gpu_name"),
                "workspace_manifest_sha256": json_digest(after_manifest or manifest),
            }
        except Exception as exc:
            with self.state_lock:
                if queued and self.queue_depth > 0:
                    self.queue_depth -= 1
            raise exc
        finally:
            shutil.rmtree(job_dir, ignore_errors=True)

    def handle_evaluate(self, payload: dict) -> dict:
        job_id = str(uuid.UUID(str(payload.get("id") or uuid.uuid4())))
        eval_name = str(payload.get("evaluator_filename") or "evaluator.py")
        if "/" in eval_name or "\\\\" in eval_name or eval_name in ("", ".", ".."):
            raise ValueError("Invalid evaluator_filename")
        eval_b64 = payload.get("evaluator_base64")
        eval_sha = payload.get("evaluator_sha256")
        if not isinstance(eval_b64, str) or not isinstance(eval_sha, str):
            raise ValueError("Missing evaluator_base64 or evaluator_sha256")
        eval_bytes = base64.b64decode(eval_b64)
        if sha256_bytes(eval_bytes) != eval_sha:
            raise ValueError("Frozen evaluator SHA-256 mismatch before execution")

        timeout_sec = parse_timeout(payload.get("timeout_seconds"), 300.0)
        files = payload.get("files", [])
        expected_manifest = str(payload.get("workspace_manifest_sha256", ""))

        job_dir = Path(tempfile.mkdtemp(prefix=f"eval-{job_id}-", dir=str(self.work_root)))
        workspace = job_dir / "workspace"
        eval_dir = job_dir / "frozen"
        tmp_dir = job_dir / "tmp"
        workspace.mkdir(parents=True, exist_ok=True)
        eval_dir.mkdir(parents=True, exist_ok=True)
        tmp_dir.mkdir(parents=True, exist_ok=True)
        eval_path = eval_dir / eval_name
        eval_path.write_bytes(eval_bytes)
        queued = False

        try:
            self.materialize_files(workspace, files, expected_manifest)
            before_manifest = workspace_inventory(workspace)
            before_digest = json_digest(before_manifest)
            with self.state_lock:
                self.queue_depth += 1
                queued = True
            with self.gpu_lock:
                with self.state_lock:
                    self.queue_depth -= 1
                    queued = False
                    self.active_job_id = job_id
                try:
                    env = os.environ.copy()
                    env.pop("DSH_COLAB_TOKEN", None)
                    env["PYTHONDONTWRITEBYTECODE"] = "1"
                    env["TMPDIR"] = str(tmp_dir)
                    env["DSH_COLAB_JOB_ID"] = job_id
                    ext = eval_path.suffix.lower()
                    if ext in (".js", ".mjs", ".cjs"):
                        argv = ["node", str(eval_path), str(workspace)]
                    else:
                        argv = [sys.executable, "-I", "-B", str(eval_path), str(workspace)]
                    run = run_isolated_process(argv, eval_dir, env, timeout_sec)
                finally:
                    with self.state_lock:
                        self.active_job_id = None

            after_eval_sha = sha256_bytes(eval_path.read_bytes()) if eval_path.exists() else ""
            after_manifest = workspace_inventory(workspace)
            after_digest = json_digest(after_manifest)
            mutated = (after_eval_sha != eval_sha) or (after_digest != before_digest)

            parsed_eval = None
            raw_out = run["stdout"].strip()
            if raw_out:
                try:
                    parsed_eval = json.loads(raw_out)
                except Exception:
                    parsed_eval = None

            return {
                "ok": True,
                "id": job_id,
                **run,
                "gpu_name": self.gpu_info.get("gpu_name"),
                "evaluator_sha256": after_eval_sha,
                "workspace_manifest_sha256": after_digest,
                "workspace_mutated": mutated,
                "evaluation": parsed_eval,
            }
        except Exception as exc:
            with self.state_lock:
                if queued and self.queue_depth > 0:
                    self.queue_depth -= 1
            raise exc
        finally:
            shutil.rmtree(job_dir, ignore_errors=True)


def make_handler(service: ColabQueueService, max_payload_bytes: int = MAX_HTTP_PAYLOAD_BYTES):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            return

        def send_json(self, code: int, payload: dict):
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def check_auth(self) -> bool:
            auth = self.headers.get("Authorization", "")
            if not service.verify_token(auth):
                self.send_json(401, {"ok": False, "error": "Unauthorized"})
                return False
            return True

        def do_GET(self):
            if not self.check_auth():
                return
            if self.path == "/health":
                self.send_json(200, service.health())
            else:
                self.send_json(404, {"ok": False, "error": "Not found"})

        def do_POST(self):
            if not self.check_auth():
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > max_payload_bytes:
                    self.send_json(413, {"ok": False, "error": f"Payload exceeds limit ({max_payload_bytes} bytes)"})
                    return
                body = self.rfile.read(length) if length > 0 else b"{}"
                payload = json.loads(body.decode("utf-8"))
                if self.path == "/exec":
                    res = service.handle_exec(payload)
                    self.send_json(200, res)
                elif self.path == "/evaluate":
                    res = service.handle_evaluate(payload)
                    self.send_json(200, res)
                else:
                    self.send_json(404, {"ok": False, "error": "Not found"})
            except ValueError as err:
                self.send_json(400, {"ok": False, "error": str(err)})
            except Exception as err:
                self.send_json(500, {"ok": False, "error": str(err)})

    return Handler


def main():
    parser = argparse.ArgumentParser(description="dsh-auto-research Colab GPU Queue Server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--token", default="")
    parser.add_argument("--token-file", default="")
    parser.add_argument("--work-root", default="")
    parser.add_argument("--ready-file", default="")
    parser.add_argument("--max-payload-bytes", type=int, default=MAX_HTTP_PAYLOAD_BYTES)
    args = parser.parse_args()

    token = args.token.strip()
    if args.token_file:
        token = Path(args.token_file).read_text(encoding="utf-8").strip()
    if not token:
        token = os.environ.get("DSH_COLAB_TOKEN", "").strip()
    if not token:
        raise SystemExit("Provide --token, --token-file, or DSH_COLAB_TOKEN")

    work_root = Path(args.work_root) if args.work_root else Path(tempfile.mkdtemp(prefix="dsh-colab-server-"))
    service = ColabQueueService(token=token, work_root=work_root)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(service, args.max_payload_bytes))
    server.daemon_threads = True
    actual_port = server.server_address[1]
    info = {
        "endpoint": f"http://{args.host}:{actual_port}",
        "port": actual_port,
        "gpu": service.gpu_info,
    }
    if args.ready_file:
        ready_path = Path(args.ready_file)
        ready_tmp = Path(str(ready_path) + f".{os.getpid()}.tmp")
        ready_tmp.write_text(json.dumps(info), encoding="utf-8")
        os.replace(ready_tmp, ready_path)
    print(json.dumps(info), flush=True)

    def handle_sigterm(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, handle_sigterm)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if not args.work_root:
            shutil.rmtree(work_root, ignore_errors=True)


if __name__ == "__main__":
    main()
`;
/**
 * Build a ready-to-paste single-cell Python snippet for a Google Colab notebook.
 *
 * Running this cell on a Colab GPU runtime starts the serialized GPU queue
 * server in the background, opens an HTTPS tunnel via `cloudflared`, and prints
 * the exact `connection.json` payload to connect local `dsh-auto-research`.
 */
export function buildColabBootstrapCell(options = {}) {
    const port = options.port ?? 8765;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid Colab server port: ${String(options.port)} (expected integer 1..65535)`);
    }
    const tunnel = options.tunnel ?? 'cloudflared';
    if (tunnel !== 'cloudflared' && tunnel !== 'ngrok' && tunnel !== 'none') {
        throw new Error(`Invalid tunnel option: ${String(tunnel)}`);
    }
    const workerB64 = Buffer.from(COLAB_WORKER_PY, 'utf8').toString('base64');
    return `# Paste and run this single cell inside your Google Colab GPU Notebook:
import base64, json, os, re, secrets, subprocess, time
from pathlib import Path

root = Path("/tmp/dsh-colab-worker")
root.mkdir(parents=True, exist_ok=True)
worker_py = root / "colab_worker.py"
worker_py.write_bytes(base64.b64decode("${workerB64}"))

token_file = root / "token.txt"
token = ${options.token ? JSON.stringify(options.token) : 'secrets.token_hex(24)'}
token_file.write_text(token, encoding="utf-8")
os.chmod(token_file, 0o600)

ready_file = root / "ready.json"
ready_file.unlink(missing_ok=True)
server_log = root / "server.log"
with server_log.open("w") as srv_out:
    server_proc = subprocess.Popen(
        ["python3", "-u", str(worker_py), "--host", "127.0.0.1", "--port", "${port}", "--token-file", str(token_file), "--ready-file", str(ready_file)],
        stdout=srv_out, stderr=subprocess.STDOUT, text=True
    )
for _ in range(300):
    if ready_file.exists():
        break
    if server_proc.poll() is not None:
        raise RuntimeError("Colab worker exited early: " + server_log.read_text(encoding="utf-8", errors="ignore"))
    time.sleep(0.1)
if not ready_file.exists():
    raise RuntimeError("Timed out waiting for Colab worker ready.json: " + server_log.read_text(encoding="utf-8", errors="ignore"))

ready = json.loads(ready_file.read_text(encoding="utf-8"))
endpoint = ready["endpoint"]
${tunnel === 'cloudflared' ? `
if not Path("/tmp/cloudflared").exists():
    subprocess.run(["wget", "-q", "-O", "/tmp/cloudflared", "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"], check=True)
    os.chmod("/tmp/cloudflared", 0o755)
tunnel_log = root / "tunnel.log"
with tunnel_log.open("w") as f:
    tunnel_proc = subprocess.Popen(["/tmp/cloudflared", "tunnel", "--url", endpoint, "--no-autoupdate"], stdout=f, stderr=subprocess.STDOUT)
public_url = None
for _ in range(150):
    text = tunnel_log.read_text(encoding="utf-8", errors="ignore") if tunnel_log.exists() else ""
    m = re.search(r"https://[a-zA-Z0-9-]+\\.trycloudflare\\.com", text)
    if m:
        public_url = m.group(0)
        break
    time.sleep(0.2)
if not public_url:
    raise RuntimeError("Failed to establish cloudflared tunnel: " + (tunnel_log.read_text(encoding="utf-8", errors="ignore") if tunnel_log.exists() else ""))
endpoint = public_url
` : tunnel === 'ngrok' ? `
from pyngrok import ngrok
endpoint = ngrok.connect(${port}, "http").public_url
` : ''}
print("=== dsh-auto-research Colab GPU Worker Ready ===")
print(json.dumps({
    "endpoint": endpoint,
    "token": token,
    "gpu": ready.get("gpu"),
}, indent=2))
`;
}
//# sourceMappingURL=server-script.js.map