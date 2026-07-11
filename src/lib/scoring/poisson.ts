/**
 * Pure-math Poisson helpers for the prop-bet scorer (player goals, team
 * corners, etc). Intentionally has no DB or provider imports — these
 * functions are deterministic in their inputs and unit-testable in
 * isolation, so any future change to rate estimation (Bayesian update,
 * per-position prior, etc.) can be tested without standing up a DB.
 *
 * The model assumption: count-style events (goals, corners, shots) are
 * reasonably well-modeled as Poisson at the per-game, per-actor level.
 * This is a v1 approximation — better models (bivariate Poisson for
 * correlated goal/count stats, or a zero-inflated variant for low-rate
 * player-goal markets) are tracked as deferred.
 */

import { MathError, safePow, safeExp, safeLgamma } from "./math-safe";

/** Ln(k!) via the gamma function: ln(k!) = lgamma(k+1). */
function logFactorial(k: number): number {
  if (k < 0 || !Number.isInteger(k)) {
    throw new MathError(`logFactorial: k must be a non-negative integer, got ${k}`);
  }
  return safeLgamma(k + 1);
}

/**
 * Poisson PMF: P(X = k) for X ~ Poisson(lambda).
 * Returns 0 for k < 0 (negative counts have no support). For very large
 * lambda + k, the unnormalized form exp(-lambda) * lambda^k / k! can
 * underflow to 0 — we compute in log space and exponentiate at the end
 * so k=0 with any lambda stays accurate.
 */
export function poissonPmf(lambda: number, k: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0;
  if (lambda < 0) {
    throw new MathError(`poissonPmf: lambda must be >= 0, got ${lambda}`);
  }
  if (lambda === 0) return k === 0 ? 1 : 0;

  // log P = -lambda + k * ln(lambda) - ln(k!)
  const logP = -lambda + k * Math.log(lambda) - logFactorial(k);
  // exp() of a very negative number rounds to 0, which is what we want
  // for the tail — caller can compare against a noise floor if needed.
  return safeExp(logP);
}

/**
 * P(X >= k) for X ~ Poisson(lambda). Used for "0.5+ goals" / "over 5.5
 * corners" style markets where the YES side resolves whenever the count
 * is at or above the threshold. Computed as 1 - P(X <= k - 1).
 *
 * Note: k=0.5 thresholds round up to k=1 (YES means "at least one event");
 * the caller (prop-rate.ts) is responsible for doing that rounding so this
 * function stays in integer-count territory.
 */
export function poissonProbAtLeast(lambda: number, k: number): number {
  if (k <= 0) {
    // "X >= 0" is always true; vacuously true. Treat as the constant 1.
    return 1;
  }
  if (lambda < 0) {
    throw new MathError(`poissonProbAtLeast: lambda must be >= 0, got ${lambda}`);
  }
  // Compute P(X <= k - 1) by summing PMF from 0 to k-1. For large k the
  // sum can be O(k) which is fine for the prop kinds we care about
  // (k <= ~10 for "0.5+" / "9.5+" style thresholds).
  let cdf = 0;
  for (let i = 0; i < k; i++) {
    cdf += poissonPmf(lambda, i);
  }
  // Numerical safety: clamp cdf into [0, 1] before subtracting. With
  // pathological lambdas + small k the sum can drift just above 1.
  return Math.max(0, Math.min(1, 1 - cdf));
}

// Touch safePow so it isn't tree-shaken if this file is the only consumer
// in some build configurations. No-op at runtime.
void safePow;
