/**
 * Research protocols shared by the runner, provider, and coordinator.
 *
 * These are pure(ish) functions: metric-view sampling, portfolio validation,
 * shared-checkpoint / peer-review validation, and the zero-synthesis context
 * published to later cooperative branches. Filesystem reads are injectable so
 * tests can exercise the policy without a real checkout.
 */
import type { MetricDefinition, MetricDiagnostic, MetricView, SharedCheckpoint, SharedEvidenceFile } from './types.js';
/** Deterministic seeded RNG (mulberry32), used by tests and reproducible runs. */
export declare function seededRandom(seed?: number): () => number;
/**
 * Sample `count` distinct randomized metric-subset views (RSI-top).
 *
 * Small combination spaces are enumerated and shuffled. For large spaces
 * (`C(n, k) > 5000`) a reservoir / rejection sampler draws distinct subsets
 * directly, so a plan with dozens of metrics never materializes a combinatorial
 * explosion. Distinct views are used until the space is exhausted.
 */
export declare function sampleMetricViews({ metrics, subset, count, diagnostics, rows, rng, }: {
    metrics?: MetricDefinition[];
    subset?: number;
    count?: number;
    diagnostics?: MetricDiagnostic[];
    rows?: Array<{
        id: string;
        parent: string | null;
        workspace: string;
        evaluation?: {
            metrics?: Record<string, unknown>;
        } | null;
    }>;
    rng?: () => number;
}): MetricView[];
/** One normalized portfolio proposal. */
export interface PortfolioProposal {
    bottleneck: string;
    mechanism: string;
    expected_effect: string;
    lineage: string;
    verbalized_probability: number;
    parent: string;
}
/**
 * Validate a `PORTFOLIO.json` proposal set. Every proposal must describe a
 * distinct bottleneck/mechanism/effect hypothesis with a verbalized probability
 * in [0, 1]; the array must have exactly `portfolioSize` entries.
 */
export declare function validatePortfolio(portfolio: unknown, { portfolioSize, parentId }?: {
    portfolioSize?: number;
    parentId?: string;
}): PortfolioProposal[];
/**
 * Discover the two files a cooperative worker maintains itself:
 * `RESEARCH_CHECKPOINT.md` and `RESEARCH_CONTEXT/*.md`. Symlinks, traversal and
 * non-regular entries are rejected; secrets are rejected rather than published.
 */
export declare function readSharedContextFiles(checkout: string): Promise<Record<string, SharedEvidenceFile>>;
/**
 * Read and validate `SHARED_CHECKPOINT.json` plus its explicit evidence
 * allowlist, then auto-discover `RESEARCH_CHECKPOINT.md` and
 * `RESEARCH_CONTEXT/*.md`. Rejects symlinks, traversal, dotfiles (except
 * `.method-evaluation`), non-text extensions, private state names, and
 * credential-looking content.
 */
export declare function readSharedCheckpoint(checkout: string): Promise<SharedCheckpoint>;
/**
 * Validate `PEER-REVIEW.json` against the exact immutable peer snapshot.
 */
export declare function validatePeerReview(review: unknown, { peerDigest, peerIds }?: {
    peerDigest?: string | null;
    peerIds?: string[];
}): Record<string, unknown>;
/** One entry rendered into `shared-context.md`. */
export interface SharedContextEntry {
    id?: string;
    summary?: string;
    files?: Record<string, {
        text?: string;
    } | undefined>;
    checkout?: string | null;
    transcript?: string | null;
    notes?: string | null;
    [key: string]: unknown;
}
/**
 * Build `shared-context.md`: the shared-context policy, verbatim
 * `RESEARCH_CHECKPOINT.md` files, peer checkout/transcript/notes paths, and an
 * index of `RESEARCH_CONTEXT/<subject>__<method>__<result>__<status>.md` topic
 * files published by completed cooperative branches.
 */
export declare function buildZeroSynthesisContext({ objective, rows, checkpoints, previousContext, }?: {
    objective?: string;
    rows?: Array<{
        id?: string;
        shared_checkpoint?: SharedCheckpoint;
        [key: string]: unknown;
    }>;
    checkpoints?: SharedContextEntry[];
    previousContext?: string | null;
}): string;
/**
 * Write `shared-context.md` atomically and make it read-only for the cohort.
 * A partially written context file must never be published to a peer.
 */
export declare function writeSharedContextAtomic(path: string, text: string, { mode }?: {
    mode?: number;
}): Promise<string>;
/** Build the immutable `PEER-EVIDENCE.json` payload. */
export declare function buildPeerEvidence({ objective, peers, scope, }: {
    objective?: string;
    peers?: unknown[];
    scope?: string;
}): Record<string, unknown>;
/** @returns the peer id set carried by a `PEER-EVIDENCE.json` object. */
export declare function peerIdsOf(bundle: unknown): string[];
/** @returns the POSIX path of `target` relative to `root` (test helper). */
export declare function relativePosixPath(root: string, target: string): string;
//# sourceMappingURL=protocols.d.ts.map