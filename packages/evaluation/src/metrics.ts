/**
 * Every number the corpus reports carries (point estimate, interval, n).
 *
 * D-050: a staged corpus of 24 defective plus 10 clean cannot resolve the
 * thresholds it gates. At n=24 a recall point estimate carries an interval wide
 * enough to straddle 0.60, and at n=10 clean a 25% ceiling is two changes wide.
 * Reporting a bare number would hide exactly that, so the interval is not
 * optional here — it is the finding.
 */

import type { WilsonInterval } from "@perbo/contracts";

/**
 * Whether the interval sits wholly on one side of the threshold. When it does
 * not, the corpus is not yet a gate for this metric and must not be used as one
 * (D-050's reversal trigger).
 */
export function resolvesAgainst(
  proportion: WilsonInterval,
  threshold: number,
  direction: "at_least" | "at_most",
): boolean {
  if (Number.isNaN(proportion.point)) return false;
  return direction === "at_least"
    ? proportion.low >= threshold || proportion.high < threshold
    : proportion.high <= threshold || proportion.low > threshold;
}

export function percentile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = q * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (rank - lower) * (sorted[upper]! - sorted[lower]!);
}

/** A small deterministic PRNG, so a reported interval is reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Quantile {
  point: number;
  low: number;
  high: number;
  n: number;
}

/** Percentile bootstrap for a quantile. Seeded, so re-running reproduces it. */
export function bootstrapQuantile(
  values: number[],
  q: number,
  iterations = 2000,
  seed = 0x5eed,
): Quantile {
  const n = values.length;
  if (n === 0) return { point: NaN, low: NaN, high: NaN, n: 0 };
  const point = percentile(values, q);
  if (n === 1) return { point, low: point, high: point, n };

  const random = mulberry32(seed);
  const estimates: number[] = [];
  const sample = new Array<number>(n);
  for (let i = 0; i < iterations; i += 1) {
    for (let j = 0; j < n; j += 1) sample[j] = values[Math.floor(random() * n)]!;
    estimates.push(percentile(sample, q));
  }
  return {
    point,
    low: percentile(estimates, 0.025),
    high: percentile(estimates, 0.975),
    n,
  };
}

/**
 * How often the repeats of one fixture disagreed with each other. One run
 * against a stochastic model is one sample; this is the number that says
 * whether three were enough.
 */
export interface Stability {
  fixtures: number;
  unanimous: number;
  split: number;
  /** Fraction of fixtures whose repeats did not all agree. */
  disagreement_rate: number;
}

export function stability(perFixture: boolean[][]): Stability {
  let unanimous = 0;
  for (const repeats of perFixture) {
    if (repeats.length === 0) continue;
    const first = repeats[0]!;
    if (repeats.every((value) => value === first)) unanimous += 1;
  }
  const fixtures = perFixture.filter((repeats) => repeats.length > 0).length;
  return {
    fixtures,
    unanimous,
    split: fixtures - unanimous,
    disagreement_rate: fixtures === 0 ? NaN : (fixtures - unanimous) / fixtures,
  };
}

/** True when strictly more than half the repeats agreed. */
export function majority(repeats: boolean[]): boolean {
  const yes = repeats.filter(Boolean).length;
  return yes * 2 > repeats.length;
}
