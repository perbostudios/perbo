/**
 * The Wilson score interval, at 95% by default.
 *
 * Every proportion this repository reports carries (point estimate, interval,
 * n): at the sample sizes a handful of tickets gives, a bare share hides how
 * little it has settled. Wilson rather than the normal approximation because
 * the normal one produces bounds outside [0, 1] near the extremes, which is
 * where these populations mostly sit.
 */

export interface WilsonInterval {
  point: number;
  low: number;
  high: number;
  n: number;
  successes: number;
}

export function wilsonInterval(successes: number, n: number, z = 1.959963984540054): WilsonInterval {
  if (n === 0) return { point: NaN, low: NaN, high: NaN, n: 0, successes: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    point: p,
    // The interval always contains the point estimate; clamping to it removes a
    // floating-point artefact that puts `high` one ulp below p at p = 1.
    low: Math.min(p, Math.max(0, (centre - spread) / denominator)),
    high: Math.max(p, Math.min(1, (centre + spread) / denominator)),
    n,
    successes,
  };
}
