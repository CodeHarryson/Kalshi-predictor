/**
 * Tiny wrapper around the math operations used in scoring/poisson.ts. Two
 * purposes: (1) a single place to throw a typed MathError so callers can
 * `instanceof MathError` if they want, and (2) the `safeExp` clamping so
 * very-negative log-values round to 0 instead of producing NaN/Infinity
 * through Math.exp's IEEE-754 underflow behavior on some platforms.
 */

export class MathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MathError";
  }
}

/** Math.pow that throws MathError on non-finite output instead of returning NaN silently. */
export function safePow(base: number, exp: number): number {
  const r = Math.pow(base, exp);
  if (!Number.isFinite(r)) {
    throw new MathError(`safePow: non-finite result for ${base}^${exp}`);
  }
  return r;
}

/** Clamped Math.exp: anything below ~-745 underflows to 0, anything above ~709 overflows to Infinity. Both are caught here. */
export function safeExp(x: number): number {
  if (x < -700) return 0;
  if (x > 700) return Infinity;
  return Math.exp(x);
}

/**
 * ln(Gamma(x)) using the Lanczos approximation. We need this because
 * TypeScript's stdlib doesn't include lgamma and writing Stirling's
 * approximation directly is the kind of thing that breaks silently
 * for small x (k=0,1,2 — which is exactly the cases we hit in
 * poissonPmf at k=0,1,2).
 *
 * Coefficients from Numerical Recipes 3e (g=7, n=9). Accurate to ~1e-15
 * for x > 0.
 */
export function safeLgamma(x: number): number {
  if (x <= 0) {
    throw new MathError(`safeLgamma: x must be > 0, got ${x}`);
  }
  // Coefficients for the Lanczos approximation.
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Reflection formula.
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - safeLgamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < c.length; i++) {
    a += c[i] / (x + i);
  }
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
