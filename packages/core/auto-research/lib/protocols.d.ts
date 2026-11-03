/**
 * RSI-top protocols: randomized metric-subset views and `PORTFOLIO.json`
 * validation. Pure functions.
 */
import type { MetricDefinition, MetricDiagnostic, MetricView } from './types.js';
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
//# sourceMappingURL=protocols.d.ts.map