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
import type { ResearchPlanInput } from '../api.js';
export interface GpuBenchmarkOptions {
    /** Executor for the frozen evaluator, e.g. `colab`. */
    executor?: string;
    /** Whether to allow CPU timing fallback when CUDA is unavailable (default: `false` on Colab, `true` in local CI). */
    allowCpuFallback?: boolean;
    /** Evaluation timeout in seconds (default: `120`). */
    evaluationSeconds?: number;
}
export interface GpuBenchmarkProject {
    workspace: string;
    evaluatorPath: string;
    candidatePath: string;
    taskPath: string;
    planPath: string;
    taskSha256: string;
    plan: ResearchPlanInput;
}
/**
 * Create a self-contained GPU Attention Decode (`GQA + RoPE`) optimization
 * benchmark workspace modeled after `ara`'s `muse_attention_decode`.
 */
export declare function createGpuAttentionBenchmark(targetDir: string, options?: GpuBenchmarkOptions): Promise<GpuBenchmarkProject>;
export interface GraphCutBenchmarkOptions {
    seed?: number;
    n?: number;
    /** Executor for the frozen evaluator, e.g. `colab`. */
    executor?: string;
    evaluationSeconds?: number;
}
export interface GraphCutBenchmarkProject {
    workspace: string;
    evaluatorPath: string;
    candidatePath: string;
    taskPath: string;
    planPath: string;
    baselineScore: number;
    optimumScore: number;
    optimumLeftVertices: number[];
    plan: ResearchPlanInput;
}
/**
 * Deterministic Balanced Weighted Graph-Cut benchmark ported from `ara`'s
 * `scripts/benchmark_methods.py`, including the exact combinatorial oracle.
 */
export declare function createGraphCutBenchmark(targetDir: string, options?: GraphCutBenchmarkOptions): Promise<GraphCutBenchmarkProject>;
//# sourceMappingURL=benchmarks.d.ts.map