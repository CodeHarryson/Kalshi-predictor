/**
 * Chance a player's stat reaches a threshold, from his recent game log.
 *
 * Each past game votes for "reached it" with a weight that decays with age
 * (0.92 per game, so about 8 games to halve). The vote is smoothed with a
 * normal kernel rather than counted as 0/1, so 4 games at 24 points and 1 at
 * 36 give a sensible chance of 25+ instead of a lumpy 20%. Touchdowns are
 * counts with a small mean, so they use a Poisson on the weighted rate.
 *
 * This knows nothing about the opponent, minutes, lineup or injuries: it is a
 * baseline, and the ranking pulls it hard toward Kalshi's price.
 */
export const MIN_GAMES = 6;
const DECAY = 0.92;
const CLAMP = 0.01;

function phi(z: number): number {
  // Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf).
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

function weighted(values: number[]) {
  const w = values.map((_, i) => DECAY ** i);
  const total = w.reduce((a, b) => a + b, 0);
  const mean = values.reduce((a, v, i) => a + v * w[i], 0) / total;
  const variance = values.reduce((a, v, i) => a + w[i] * (v - mean) ** 2, 0) / total;
  return { w, total, mean, sd: Math.sqrt(variance) };
}

function poissonAtLeast(lambda: number, k: number): number {
  let term = Math.exp(-lambda);
  let below = 0;
  for (let i = 0; i < k; i++) {
    below += term;
    term *= lambda / (i + 1);
  }
  return 1 - below;
}

/**
 * @param values stat per game, most recent first
 * @param counts true for small-count stats (touchdowns)
 * @returns P(stat >= threshold), or null with fewer than MIN_GAMES games
 */
export function probAtLeast(values: number[], threshold: number, counts = false): number | null {
  if (values.length < MIN_GAMES) return null;
  const { w, total, mean, sd } = weighted(values);
  let p: number;
  if (counts) {
    p = poissonAtLeast(Math.max(mean, 0.02), Math.ceil(threshold));
  } else {
    const h = Math.max(0.6, 0.3 * sd);
    p = values.reduce((a, v, i) => a + w[i] * phi((v - threshold + 0.5) / h), 0) / total;
  }
  return Math.min(1 - CLAMP, Math.max(CLAMP, p));
}

export function weightedMean(values: number[]): number {
  return values.length ? weighted(values).mean : 0;
}
