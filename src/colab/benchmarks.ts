/**
 * Built-in benchmark generators for testing `dsh-auto-research` with a remote
 * Google Colab GPU runtime (or local Python fallback).
 *
 * Includes:
 * 1. `createGpuAttentionBenchmark`: Modeled on `ara`'s `muse_attention_decode`
 *    and `OfficialJudge.md` (GQA + RoPE decode kernel optimization with fresh-input
 *    anti-cheating checks and CUDA Event timing).
 * 2. `createGraphCutBenchmark`: Modeled on `ara`'s `scripts/benchmark_methods.py`
 *    (paired balanced weighted graph-cut combinatorial optimization with exact
 *    oracle optimum).
 */

import * as fsp from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { sha256 } from '../api.js'
import type { ResearchPlanInput } from '../api.js'

export interface GpuBenchmarkOptions {
  /** Executor for the frozen evaluator, e.g. `colab`. */
  executor?: string
  /** Whether to allow CPU timing fallback when CUDA is unavailable (default: `false` on Colab, `true` in local CI). */
  allowCpuFallback?: boolean
  /** Evaluation timeout in seconds (default: `120`). */
  evaluationSeconds?: number
}

export interface GpuBenchmarkProject {
  workspace: string
  evaluatorPath: string
  candidatePath: string
  taskPath: string
  planPath: string
  taskSha256: string
  plan: ResearchPlanInput
}

/**
 * Create a self-contained GPU Attention Decode (`GQA + RoPE`) optimization
 * benchmark workspace modeled after `ara`'s `muse_attention_decode`.
 */
export async function createGpuAttentionBenchmark(
  targetDir: string,
  options: GpuBenchmarkOptions = {},
): Promise<GpuBenchmarkProject> {
  const workspace = resolve(targetDir)
  await fsp.mkdir(workspace, { recursive: true })

  const taskSpec = {
    problem: 'muse_attention_decode_gqa',
    batch_size: 8,
    num_q_heads: 16,
    num_kv_heads: 4,
    head_dim: 64,
    seq_len: 256,
    warmup_iters: 5,
    bench_iters: 25,
    atol: 1e-3,
    rtol: 1e-3,
    require_cuda: options.allowCpuFallback !== true,
  }
  const taskRaw = JSON.stringify(taskSpec, null, 2) + '\n'
  const taskSha256 = sha256(taskRaw)
  const taskPath = join(workspace, 'task.json')
  await fsp.writeFile(taskPath, taskRaw, 'utf8')

  const candidatePy = `"""Candidate GQA + RoPE attention decode implementation.

Optimize \`attention_decode(q, k_cache, v_cache, cos, sin, scale)\` without
changing its mathematical output. Keep this file self-contained.
"""
import math
import torch


def apply_rope_naive(x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
    # x: [B, H, D], cos/sin: [B, D // 2]
    b, h, d = x.shape
    half = d // 2
    out = torch.empty_like(x)
    for bi in range(b):
        for hi in range(h):
            x1 = x[bi, hi, :half].clone()
            x2 = x[bi, hi, half:].clone()
            c = cos[bi]
            s = sin[bi]
            out[bi, hi, :half] = x1 * c - x2 * s
            out[bi, hi, half:] = x2 * c + x1 * s
    return out


def attention_decode(
    q: torch.Tensor,
    k_cache: torch.Tensor,
    v_cache: torch.Tensor,
    cos: torch.Tensor,
    sin: torch.Tensor,
    scale: float,
) -> torch.Tensor:
    """Compute single-token GQA decode attention with rotary position embedding on q.

    Shapes:
      q:       [B, H_q, D]
      k_cache: [B, S, H_kv, D]
      v_cache: [B, S, H_kv, D]
      cos:     [B, D // 2]
      sin:     [B, D // 2]
    Returns:
      out:     [B, H_q, D]
    """
    q_rot = apply_rope_naive(q, cos, sin)
    b, h_q, d = q_rot.shape
    h_kv = k_cache.shape[2]
    group_size = h_q // h_kv
    outputs = []
    for hi in range(h_q):
        kv_idx = hi // group_size
        q_head = q_rot[:, hi, :].unsqueeze(1)            # [B, 1, D]
        k_head = k_cache[:, :, kv_idx, :].clone()        # [B, S, D]
        v_head = v_cache[:, :, kv_idx, :].clone()        # [B, S, D]
        scores = torch.bmm(q_head, k_head.transpose(1, 2)) * scale
        probs = torch.softmax(scores.float(), dim=-1).to(q.dtype)
        ctx = torch.bmm(probs, v_head)                   # [B, 1, D]
        outputs.append(ctx)
    return torch.cat(outputs, dim=1)
`
  const candidatePath = join(workspace, 'candidate_kernel.py')
  await fsp.writeFile(candidatePath, candidatePy, 'utf8')

  const evaluatorPy = `#!/usr/bin/env python3
"""Frozen GPU Evaluator for GQA + RoPE Attention Decode."""
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time

EXPECTED_TASK_HASH = ${JSON.stringify(taskSha256)}
_PERF_COUNTER = time.perf_counter


def reference_attention_decode(q, k_cache, v_cache, cos, sin, scale):
    import torch
    half = q.shape[-1] // 2
    q1, q2 = q[..., :half], q[..., half:]
    c = cos.unsqueeze(1)
    s = sin.unsqueeze(1)
    q_rot = torch.cat([q1 * c - q2 * s, q2 * c + q1 * s], dim=-1)
    b, h_q, d = q_rot.shape
    h_kv = k_cache.shape[2]
    group = h_q // h_kv
    q_grouped = q_rot.view(b, h_kv, group, d)
    k_t = k_cache.permute(0, 2, 3, 1)  # [B, H_kv, D, S]
    scores = torch.matmul(q_grouped, k_t) * scale  # [B, H_kv, group, S]
    probs = torch.softmax(scores.float(), dim=-1).to(q.dtype)
    v_g = v_cache.permute(0, 2, 1, 3)  # [B, H_kv, S, D]
    out = torch.matmul(probs, v_g)     # [B, H_kv, group, D]
    return out.reshape(b, h_q, d)


def slow_baseline_attention(q, k_cache, v_cache, cos, sin, scale):
    import torch
    b, h, d = q.shape
    half = d // 2
    q_rot = torch.empty_like(q)
    for bi in range(b):
        for hi in range(h):
            x1 = q[bi, hi, :half].clone()
            x2 = q[bi, hi, half:].clone()
            q_rot[bi, hi, :half] = x1 * cos[bi] - x2 * sin[bi]
            q_rot[bi, hi, half:] = x2 * cos[bi] + x1 * sin[bi]
    h_kv = k_cache.shape[2]
    group_size = h // h_kv
    outputs = []
    for hi in range(h):
        kv_idx = hi // group_size
        q_head = q_rot[:, hi, :].unsqueeze(1)
        k_head = k_cache[:, :, kv_idx, :].clone()
        v_head = v_cache[:, :, kv_idx, :].clone()
        scores = torch.bmm(q_head, k_head.transpose(1, 2)) * scale
        probs = torch.softmax(scores.float(), dim=-1).to(q.dtype)
        outputs.append(torch.bmm(probs, v_head))
    return torch.cat(outputs, dim=1)


def evaluate(root: Path) -> dict:
    task_file = root / "task.json"
    raw = task_file.read_bytes()
    if hashlib.sha256(raw).hexdigest() != EXPECTED_TASK_HASH:
        raise ValueError("immutable task.json was modified")
    task = json.loads(raw.decode("utf-8"))
    cand_file = root / "candidate_kernel.py"
    if not cand_file.is_file():
        raise ValueError("candidate_kernel.py is missing")

    import torch
    use_cuda = bool(torch.cuda.is_available())
    if task.get("require_cuda") and not use_cuda:
        raise ValueError("CUDA GPU required by task.json but torch.cuda.is_available() is False")

    # Bind timing primitives before importing untrusted candidate module
    cuda_sync = torch.cuda.synchronize if use_cuda else None
    cuda_event_cls = torch.cuda.Event if use_cuda else None
    cuda_elapsed = torch.cuda.Event.elapsed_time if use_cuda else None

    def time_fn(fn, args, warmup: int, iters: int):
        last_out = None
        for _ in range(warmup):
            last_out = fn(*args)
        if use_cuda and cuda_sync and cuda_event_cls and cuda_elapsed:
            cuda_sync()
            start_ev = cuda_event_cls(enable_timing=True)
            end_ev = cuda_event_cls(enable_timing=True)
            start_ev.record()
            for _ in range(iters):
                last_out = fn(*args)
            end_ev.record()
            cuda_sync()
            return (float(cuda_elapsed(start_ev, end_ev)) / max(1, iters)), last_out
        start = _PERF_COUNTER()
        for _ in range(iters):
            last_out = fn(*args)
        return (((_PERF_COUNTER() - start) * 1000.0) / max(1, iters)), last_out

    device = torch.device("cuda" if use_cuda else "cpu")
    dtype = torch.float16 if use_cuda else torch.float32

    spec = importlib.util.spec_from_file_location("candidate_kernel", str(cand_file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, "attention_decode"):
        raise ValueError("candidate_kernel.py must define attention_decode")

    B = int(task["batch_size"])
    H_q = int(task["num_q_heads"])
    H_kv = int(task["num_kv_heads"])
    D = int(task["head_dim"])
    S = int(task["seq_len"])
    scale = 1.0 / math.sqrt(D)
    atol = float(task["atol"])

    def check_tensor_match(got, ref):
        if not isinstance(got, torch.Tensor) or got.shape != ref.shape or got.dtype != ref.dtype:
            raise ValueError(f"Output shape/dtype mismatch: got { getattr(got, 'shape', None) } { getattr(got, 'dtype', None) }, expected {ref.shape} {ref.dtype}")
        err = float((got.float() - ref.float()).abs().max().item())
        if not math.isfinite(err) or err > atol:
            raise ValueError(f"Numerical error {err:.6e} exceeds tolerance {atol}")
        return err

    dynamic_seed = int.from_bytes(os.urandom(4), "little") | 1
    max_err = 0.0
    for seed in (101, 202, 303, dynamic_seed):
        gen = torch.Generator(device=device).manual_seed(seed)
        q = torch.randn((B, H_q, D), device=device, dtype=dtype, generator=gen)
        k = torch.randn((B, S, H_kv, D), device=device, dtype=dtype, generator=gen)
        v = torch.randn((B, S, H_kv, D), device=device, dtype=dtype, generator=gen)
        cos = torch.randn((B, D // 2), device=device, dtype=dtype, generator=gen)
        sin = torch.randn((B, D // 2), device=device, dtype=dtype, generator=gen)
        ref = reference_attention_decode(q, k, v, cos, sin, scale)
        got = mod.attention_decode(q, k, v, cos, sin, scale)
        max_err = max(max_err, check_tensor_match(got, ref))

    gen = torch.Generator(device=device).manual_seed(999)
    q = torch.randn((B, H_q, D), device=device, dtype=dtype, generator=gen)
    k = torch.randn((B, S, H_kv, D), device=device, dtype=dtype, generator=gen)
    v = torch.randn((B, S, H_kv, D), device=device, dtype=dtype, generator=gen)
    cos = torch.randn((B, D // 2), device=device, dtype=dtype, generator=gen)
    sin = torch.randn((B, D // 2), device=device, dtype=dtype, generator=gen)

    warmup = int(task["warmup_iters"])
    iters = int(task["bench_iters"])
    base_ms, _ = time_fn(slow_baseline_attention, (q, k, v, cos, sin, scale), warmup, iters)
    cand_ms, timed_out = time_fn(mod.attention_decode, (q, k, v, cos, sin, scale), warmup, iters)
    timed_ref = reference_attention_decode(q, k, v, cos, sin, scale)
    max_err = max(max_err, check_tensor_match(timed_out, timed_ref))
    speedup = round(base_ms / max(1e-6, cand_ms), 4)

    return {
        "valid": True,
        "score": speedup,
        "metrics": {
            "speedup": speedup,
            "candidate_ms": round(cand_ms, 4),
            "baseline_ms": round(base_ms, 4),
            "max_abs_error": round(max_err, 6),
            "gpu_used": 1 if use_cuda else 0,
        },
        "evidence": ["candidate_kernel.py"],
    }


if __name__ == "__main__":
    root_dir = Path(sys.argv[-1]).resolve()
    try:
        res = evaluate(root_dir)
    except Exception as exc:
        res = {"valid": False, "reason": str(exc)}
    print(json.dumps(res))
`
  const evaluatorPath = join(workspace, 'evaluator.py')
  await fsp.writeFile(evaluatorPath, evaluatorPy, { encoding: 'utf8', mode: 0o755 })

  const plan: ResearchPlanInput = {
    objective: 'Maximize GQA + RoPE attention decode speedup on the target GPU while preserving numerical equivalence within 1e-3.',
    worker_prompt: [
      'Optimize `candidate_kernel.py` (`attention_decode`) for GQA + RoPE single-token attention decode.',
      'Eliminate Python head loops and redundant tensor clones by vectorizing rotary embedding and grouped-query head broadcasting.',
      'Do not modify `task.json` or `evaluator.py`. Verify correctness and speedup before finishing.',
    ].join(' '),
    evaluator: evaluatorPath,
    evaluation_seconds: options.evaluationSeconds ?? 120,
    direction: 'maximize',
    ...(options.executor ? { options: { executor: options.executor } } : {}),
    metrics: [
      { name: 'speedup', definition: 'Baseline latency divided by candidate latency' },
      { name: 'candidate_ms', definition: 'Candidate kernel mean latency in milliseconds' },
      { name: 'baseline_ms', definition: 'Naive baseline mean latency in milliseconds' },
      { name: 'max_abs_error', definition: 'Maximum absolute numerical error against reference' },
      { name: 'gpu_used', definition: '1 when timed on CUDA GPU, 0 on CPU fallback' },
    ],
    selection_metrics: [{ name: 'speedup', direction: 'maximize' }],
    meaningful_gain: 0.05,
    stall_seconds: 300,
    metric_subset: 3,
    portfolio_size: 3,
  }
  const planJson = JSON.stringify(plan, null, 2) + '\n'
  const methodsDir = join(workspace, '.auto-research-methods')
  await fsp.mkdir(methodsDir, { recursive: true })
  const planPath = join(methodsDir, 'plan.json')
  await fsp.writeFile(planPath, planJson, 'utf8')
  await fsp.writeFile(join(workspace, 'auto-research.json'), planJson, 'utf8')

  return {
    workspace,
    evaluatorPath,
    candidatePath,
    taskPath,
    planPath,
    taskSha256,
    plan,
  }
}

export interface GraphCutBenchmarkOptions {
  seed?: number
  n?: number
  /** Executor for the frozen evaluator, e.g. `colab`. */
  executor?: string
  evaluationSeconds?: number
}

export interface GraphCutBenchmarkProject {
  workspace: string
  evaluatorPath: string
  candidatePath: string
  taskPath: string
  planPath: string
  baselineScore: number
  optimumScore: number
  optimumLeftVertices: number[]
  plan: ResearchPlanInput
}

/**
 * Deterministic Balanced Weighted Graph-Cut benchmark ported from `ara`'s
 * `scripts/benchmark_methods.py`, including the exact combinatorial oracle.
 */
export async function createGraphCutBenchmark(
  targetDir: string,
  options: GraphCutBenchmarkOptions = {},
): Promise<GraphCutBenchmarkProject> {
  const workspace = resolve(targetDir)
  await fsp.mkdir(workspace, { recursive: true })
  const seed = options.seed ?? 42
  const n = options.n ?? 16
  if (n < 4 || n % 2 !== 0) throw new Error('n must be an even integer >= 4')

  let state = (seed >>> 0) || 1
  const nextRand = (): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }

  const edges: Array<[number, number, number]> = []
  for (let a = 0; a < n; a += 1) {
    for (let b = a + 1; b < n; b += 1) {
      if (nextRand() < 0.4) {
        const w = Math.floor(nextRand() * 21) - 5 // [-5, 15]
        edges.push([a, b, w])
      }
    }
  }

  const cutValue = (bits: number[]): number => {
    let sum = 0
    for (const [a, b, w] of edges) {
      if (bits[a] !== bits[b]) sum += w
    }
    return sum
  }

  const start = Array.from({ length: n }, (_, i) => (i < n / 2 ? 1 : 0))
  const baselineScore = cutValue(start)

  const half = n / 2
  let optimumScore = -Infinity
  let optimumLeftVertices: number[] = []
  const currentSubset: number[] = [0]
  const search = (startVertex: number, needed: number): void => {
    if (needed === 0) {
      const bits = new Array<number>(n).fill(0)
      for (const v of currentSubset) bits[v] = 1
      const score = cutValue(bits)
      if (score > optimumScore) {
        optimumScore = score
        optimumLeftVertices = [...currentSubset]
      }
      return
    }
    for (let v = startVertex; v <= n - needed; v += 1) {
      currentSubset.push(v)
      search(v + 1, needed - 1)
      currentSubset.pop()
    }
  }
  search(1, half - 1)

  const taskObj = { n, edges, baseline: baselineScore }
  const taskRaw = JSON.stringify(taskObj, null, 2) + '\n'
  const taskHash = sha256(taskRaw)
  const taskPath = join(workspace, 'task.json')
  const candidatePath = join(workspace, 'candidate.json')
  const probesPath = join(workspace, 'PROBES.json')

  await fsp.writeFile(taskPath, taskRaw, 'utf8')
  await fsp.writeFile(candidatePath, JSON.stringify(start) + '\n', 'utf8')
  await fsp.writeFile(probesPath, '[]\n', 'utf8')

  const evaluatorPy = `#!/usr/bin/env python3
"""Frozen evaluator for Balanced Weighted Graph Cut (ported from ara benchmark_methods.py)."""
import hashlib
import json
from pathlib import Path
import sys

TASK_HASH = ${JSON.stringify(taskHash)}


def value(task: dict, bits: list) -> int:
    n = task["n"]
    if (
        not isinstance(bits, list)
        or len(bits) != n
        or any(type(x) is not int or x not in (0, 1) for x in bits)
        or sum(bits) != n // 2
    ):
        raise ValueError("balanced binary assignment required")
    return sum(w for a, b, w in task["edges"] if bits[a] != bits[b])


def evaluate(root: Path) -> dict:
    raw = (root / "task.json").read_bytes()
    if hashlib.sha256(raw).hexdigest() != TASK_HASH:
        raise ValueError("immutable task changed")
    task = json.loads(raw.decode("utf-8"))
    bits = json.loads((root / "candidate.json").read_text(encoding="utf-8"))
    current = value(task, bits)
    probes_file = root / "PROBES.json"
    probes = json.loads(probes_file.read_text(encoding="utf-8")) if probes_file.exists() else []
    if not isinstance(probes, list) or len(probes) > 1000:
        raise ValueError("bounded probe schema")
    unique = {tuple(p): value(task, p) for p in probes}
    return {
        "valid": True,
        "score": current,
        "metrics": {
            "cut": current,
            "gain": current - task["baseline"],
            "best_probe": max([current] + list(unique.values())),
            "unique_probes": len(unique),
            "distinct_probe_scores": len(set(unique.values())),
        },
        "evidence": ["candidate.json", "PROBES.json"],
    }


if __name__ == "__main__":
    root_dir = Path(sys.argv[-1]).resolve()
    try:
        result = evaluate(root_dir)
    except Exception as error:
        result = {"valid": False, "reason": str(error)}
    print(json.dumps(result))
`
  const evaluatorPath = join(workspace, 'evaluator.py')
  await fsp.writeFile(evaluatorPath, evaluatorPy, { encoding: 'utf8', mode: 0o755 })

  const plan: ResearchPlanInput = {
    objective: 'Find a balanced binary vertex partition in candidate.json that maximizes the weighted graph cut for task.json.',
    worker_prompt: [
      'Find the best balanced weighted graph cut using task.json.',
      'candidate.json is a binary list of length n with exactly n/2 ones.',
      'Save up to 1000 distinct evaluated assignments in PROBES.json.',
      'Do not modify task.json or evaluator.py.',
    ].join(' '),
    evaluator: evaluatorPath,
    evaluation_seconds: options.evaluationSeconds ?? 60,
    direction: 'maximize',
    ...(options.executor ? { options: { executor: options.executor } } : {}),
    metrics: [
      { name: 'cut', definition: 'Weighted cut value of candidate.json' },
      { name: 'gain', definition: 'Improvement over initial baseline cut' },
      { name: 'best_probe', definition: 'Best score among candidate and PROBES.json' },
      { name: 'unique_probes', definition: 'Number of distinct valid probe assignments' },
      { name: 'distinct_probe_scores', definition: 'Number of distinct probe cut values' },
    ],
    selection_metrics: [{ name: 'cut', direction: 'maximize' }],
    meaningful_gain: 1,
    stall_seconds: 300,
    metric_subset: 3,
    portfolio_size: 3,
  }
  const planJson = JSON.stringify(plan, null, 2) + '\n'
  const methodsDir = join(workspace, '.auto-research-methods')
  await fsp.mkdir(methodsDir, { recursive: true })
  const planPath = join(methodsDir, 'plan.json')
  await fsp.writeFile(planPath, planJson, 'utf8')
  await fsp.writeFile(join(workspace, 'auto-research.json'), planJson, 'utf8')

  return {
    workspace,
    evaluatorPath,
    candidatePath,
    taskPath,
    planPath,
    baselineScore,
    optimumScore,
    optimumLeftVertices,
    plan,
  }
}
