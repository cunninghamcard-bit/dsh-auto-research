/**
 * RSI-top protocols: randomized metric-subset views and `PORTFOLIO.json`
 * validation. Pure functions.
 */
const COMBINATION_LIMIT = 5000;
/** Deterministic seeded RNG (mulberry32), used by tests and reproducible runs. */
export function seededRandom(seed = 1) {
    let value = seed >>> 0;
    return function random() {
        value = (value + 0x6d2b79f5) >>> 0;
        let t = value;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function binomial(n, k) {
    const size = Math.min(k, n - k);
    let value = 1;
    for (let index = 1; index <= size; index += 1) {
        value = (value * (n - size + index)) / index;
        if (value > COMBINATION_LIMIT)
            return value;
    }
    return value;
}
function combinations(count, size) {
    const result = [];
    const current = [];
    const walk = (start) => {
        if (current.length === size) {
            result.push([...current]);
            return;
        }
        for (let index = start; index < count; index += 1) {
            current.push(index);
            walk(index + 1);
            current.pop();
        }
    };
    walk(0);
    return result;
}
/** One random distinct subset of `size` positions from `0..count-1`. */
function sampleSubset(count, size, rng) {
    const pool = Array.from({ length: count }, (_, index) => index);
    for (let index = 0; index < size; index += 1) {
        const swap = index + Math.floor(rng() * (count - index));
        const hold = pool[index];
        pool[index] = pool[swap];
        pool[swap] = hold;
    }
    return pool.slice(0, size);
}
/** Build one view from a set of metric positions. */
function makeView(metrics, positions, diagnostics, rows) {
    const definitions = positions
        .map(position => metrics[position])
        .filter((definition) => definition !== undefined);
    const keys = definitions.map(definition => definition.name);
    return {
        definitions,
        diagnostics: diagnostics.filter(diagnostic => keys.includes(diagnostic.name)),
        rows: rows.map(row => ({
            id: row.id,
            parent: row.parent,
            workspace: row.workspace,
            metrics: Object.fromEntries(keys.map(key => [key, row.evaluation?.metrics?.[key] ?? null])),
        })),
    };
}
/**
 * Sample `count` distinct randomized metric-subset views (RSI-top).
 *
 * Small combination spaces are enumerated and shuffled. For large spaces
 * (`C(n, k) > 5000`) a reservoir / rejection sampler draws distinct subsets
 * directly, so a plan with dozens of metrics never materializes a combinatorial
 * explosion. Distinct views are used until the space is exhausted.
 */
export function sampleMetricViews({ metrics = [], subset = 1, count = 0, diagnostics = [], rows = [], rng = Math.random, }) {
    if (!Array.isArray(metrics))
        throw new Error('metrics must be an array');
    if (!Number.isInteger(count) || count < 0)
        throw new Error('view count must be a non-negative integer');
    if (!Number.isInteger(subset) || subset < 1 || subset > metrics.length) {
        throw new Error('invalid metric subset size');
    }
    if (count === 0)
        return [];
    const total = binomial(metrics.length, subset);
    const views = [];
    if (total <= COMBINATION_LIMIT) {
        const all = combinations(metrics.length, subset);
        for (let index = all.length - 1; index > 0; index -= 1) {
            const swap = Math.floor(rng() * (index + 1));
            const hold = all[index];
            all[index] = all[swap];
            all[swap] = hold;
        }
        for (let index = 0; index < count; index += 1) {
            const chosen = all[index % all.length];
            views.push(makeView(metrics, chosen, diagnostics, rows));
        }
        return views;
    }
    // Large space: draw distinct subsets directly with a seen-key set.
    const target = Math.min(count, Math.max(1, Math.floor(total)));
    const seen = new Set();
    const picks = [];
    const maxAttempts = target * 20 + 1000;
    let attempts = 0;
    while (picks.length < target && attempts < maxAttempts) {
        attempts += 1;
        const candidate = sampleSubset(metrics.length, subset, rng);
        const key = [...candidate].sort((a, b) => a - b).join(',');
        if (seen.has(key))
            continue;
        seen.add(key);
        picks.push(candidate);
    }
    for (let index = 0; index < count; index += 1) {
        const chosen = picks[index % Math.max(1, picks.length)] ?? sampleSubset(metrics.length, subset, rng);
        views.push(makeView(metrics, chosen, diagnostics, rows));
    }
    return views;
}
function probability(value) {
    if (typeof value === 'boolean')
        throw new Error('Incomplete RSI portfolio');
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1) {
        throw new Error('Incomplete RSI portfolio');
    }
    return number;
}
/**
 * Validate a `PORTFOLIO.json` proposal set. Every proposal must describe a
 * distinct bottleneck/mechanism/effect hypothesis with a verbalized probability
 * in [0, 1]; the array must have exactly `portfolioSize` entries.
 */
export function validatePortfolio(portfolio, { portfolioSize, parentId = 'initial' } = {}) {
    if (!Array.isArray(portfolio) || portfolio.length !== portfolioSize) {
        throw new Error('Portfolio size does not match the fixed plan');
    }
    const hypotheses = new Set();
    const normalized = [];
    for (const proposal of portfolio) {
        if (proposal === null || typeof proposal !== 'object' || Array.isArray(proposal)) {
            throw new Error('Incomplete RSI portfolio');
        }
        const record = proposal;
        const fields = ['bottleneck', 'mechanism', 'expected_effect', 'lineage'].map(key => {
            const value = record[key];
            if (typeof value !== 'string' || value.trim() === '')
                throw new Error('Incomplete RSI portfolio');
            return value.trim();
        });
        const [bottleneck, mechanism, expectedEffect, lineage] = fields;
        const verbalized = probability(record.verbalized_probability);
        const key = `${bottleneck}\u0000${mechanism}\u0000${expectedEffect}`;
        if (hypotheses.has(key))
            throw new Error('Duplicate RSI portfolio hypotheses');
        hypotheses.add(key);
        normalized.push({
            bottleneck,
            mechanism,
            expected_effect: expectedEffect,
            lineage,
            verbalized_probability: verbalized,
            parent: parentId,
        });
    }
    return normalized;
}
//# sourceMappingURL=protocols.js.map