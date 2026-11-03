/**
 * RSI-top protocols: randomized metric-subset views and `PORTFOLIO.json`
 * validation. Pure functions.
 */

import type { MetricDefinition, MetricDiagnostic, MetricView } from './types.js'

const COMBINATION_LIMIT = 5000

/** Deterministic seeded RNG (mulberry32), used by tests and reproducible runs. */
export function seededRandom(seed = 1): () => number {
  let value = seed >>> 0
  return function random(): number {
    value = (value + 0x6d2b79f5) >>> 0
    let t = value
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function binomial(n: number, k: number): number {
  const size = Math.min(k, n - k)
  let value = 1
  for (let index = 1; index <= size; index += 1) {
    value = (value * (n - size + index)) / index
    if (value > COMBINATION_LIMIT) return value
  }
  return value
}

function combinations(count: number, size: number): number[][] {
  const result: number[][] = []
  const current: number[] = []
  const walk = (start: number): void => {
    if (current.length === size) {
      result.push([...current])
      return
    }
    for (let index = start; index < count; index += 1) {
      current.push(index)
      walk(index + 1)
      current.pop()
    }
  }
  walk(0)
  return result
}

/** One random distinct subset of `size` positions from `0..count-1`. */
function sampleSubset(count: number, size: number, rng: () => number): number[] {
  const pool = Array.from({ length: count }, (_, index) => index)
  for (let index = 0; index < size; index += 1) {
    const swap = index + Math.floor(rng() * (count - index))
    const hold = pool[index] as number
    pool[index] = pool[swap] as number
    pool[swap] = hold
  }
  return pool.slice(0, size)
}

/** Build one view from a set of metric positions. */
function makeView(
  metrics: MetricDefinition[],
  positions: number[],
  diagnostics: MetricDiagnostic[],
  rows: Array<{
    id: string
    parent: string | null
    workspace: string
    evaluation?: { metrics?: Record<string, unknown> } | null
  }>,
): MetricView {
  const definitions = positions
    .map(position => metrics[position])
    .filter((definition): definition is MetricDefinition => definition !== undefined)
  const keys = definitions.map(definition => definition.name)
  return {
    definitions,
    diagnostics: diagnostics.filter(diagnostic => keys.includes(diagnostic.name)),
    rows: rows.map(row => ({
      id: row.id,
      parent: row.parent,
      workspace: row.workspace,
      metrics: Object.fromEntries(keys.map(key => [key, row.evaluation?.metrics?.[key] ?? null])),
    })),
  }
}

/**
 * Sample `count` distinct randomized metric-subset views (RSI-top).
 *
 * Small combination spaces are enumerated and shuffled. For large spaces
 * (`C(n, k) > 5000`) a reservoir / rejection sampler draws distinct subsets
 * directly, so a plan with dozens of metrics never materializes a combinatorial
 * explosion. Distinct views are used until the space is exhausted.
 */
export function sampleMetricViews({
  metrics = [],
  subset = 1,
  count = 0,
  diagnostics = [],
  rows = [],
  rng = Math.random,
}: {
  metrics?: MetricDefinition[]
  subset?: number
  count?: number
  diagnostics?: MetricDiagnostic[]
  rows?: Array<{
    id: string
    parent: string | null
    workspace: string
    evaluation?: { metrics?: Record<string, unknown> } | null
  }>
  rng?: () => number
}): MetricView[] {
  if (!Array.isArray(metrics)) throw new Error('metrics must be an array')
  if (!Number.isInteger(count) || count < 0) throw new Error('view count must be a non-negative integer')
  if (!Number.isInteger(subset) || subset < 1 || subset > metrics.length) {
    throw new Error('invalid metric subset size')
  }
  if (count === 0) return []
  const total = binomial(metrics.length, subset)
  const views: MetricView[] = []
  if (total <= COMBINATION_LIMIT) {
    const all = combinations(metrics.length, subset)
    for (let index = all.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(rng() * (index + 1))
      const hold = all[index] as number[]
      all[index] = all[swap] as number[]
      all[swap] = hold
    }
    for (let index = 0; index < count; index += 1) {
      const chosen = all[index % all.length] as number[]
      views.push(makeView(metrics, chosen, diagnostics, rows))
    }
    return views
  }
  // Large space: draw distinct subsets directly with a seen-key set.
  const target = Math.min(count, Math.max(1, Math.floor(total)))
  const seen = new Set<string>()
  const picks: number[][] = []
  const maxAttempts = target * 20 + 1000
  let attempts = 0
  while (picks.length < target && attempts < maxAttempts) {
    attempts += 1
    const candidate = sampleSubset(metrics.length, subset, rng)
    const key = [...candidate].sort((a, b) => a - b).join(',')
    if (seen.has(key)) continue
    seen.add(key)
    picks.push(candidate)
  }
  for (let index = 0; index < count; index += 1) {
    const chosen = picks[index % Math.max(1, picks.length)] ?? sampleSubset(metrics.length, subset, rng)
    views.push(makeView(metrics, chosen, diagnostics, rows))
  }
  return views
}

function probability(value: unknown): number {
  if (typeof value === 'boolean') throw new Error('Incomplete RSI portfolio')
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error('Incomplete RSI portfolio')
  }
  return number
}

/** One normalized portfolio proposal. */
export interface PortfolioProposal {
  bottleneck: string
  mechanism: string
  expected_effect: string
  lineage: string
  verbalized_probability: number
  parent: string
}

/**
 * Validate a `PORTFOLIO.json` proposal set. Every proposal must describe a
 * distinct bottleneck/mechanism/effect hypothesis with a verbalized probability
 * in [0, 1]; the array must have exactly `portfolioSize` entries.
 */
export function validatePortfolio(
  portfolio: unknown,
  { portfolioSize, parentId = 'initial' }: { portfolioSize?: number; parentId?: string } = {},
): PortfolioProposal[] {
  if (!Array.isArray(portfolio) || portfolio.length !== portfolioSize) {
    throw new Error('Portfolio size does not match the fixed plan')
  }
  const hypotheses = new Set<string>()
  const normalized: PortfolioProposal[] = []
  for (const proposal of portfolio as unknown[]) {
    if (proposal === null || typeof proposal !== 'object' || Array.isArray(proposal)) {
      throw new Error('Incomplete RSI portfolio')
    }
    const record = proposal as Record<string, unknown>
    const fields = ['bottleneck', 'mechanism', 'expected_effect', 'lineage'].map(key => {
      const value = record[key]
      if (typeof value !== 'string' || value.trim() === '') throw new Error('Incomplete RSI portfolio')
      return value.trim()
    })
    const [bottleneck, mechanism, expectedEffect, lineage] = fields as [string, string, string, string]
    const verbalized = probability(record.verbalized_probability)
    const key = `${bottleneck}\u0000${mechanism}\u0000${expectedEffect}`
    if (hypotheses.has(key)) throw new Error('Duplicate RSI portfolio hypotheses')
    hypotheses.add(key)
    normalized.push({
      bottleneck,
      mechanism,
      expected_effect: expectedEffect,
      lineage,
      verbalized_probability: verbalized,
      parent: parentId,
    })
  }
  return normalized
}
