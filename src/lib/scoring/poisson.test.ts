import { describe, it, expect } from "vitest";
import { poissonPmf, poissonProbAtLeast } from "./poisson";
import { MathError } from "./math-safe";

describe("poissonPmf", () => {
  it("P(X=0) = e^(-lambda)", () => {
    expect(poissonPmf(2, 0)).toBeCloseTo(Math.exp(-2), 10);
  });

  it("P(X=1) at lambda=1 equals e^-1", () => {
    expect(poissonPmf(1, 1)).toBeCloseTo(Math.exp(-1), 10);
  });

  it("PMF sums to ~1 across k=0..50 for lambda=5 (tail-truncated)", () => {
    let sum = 0;
    for (let k = 0; k <= 50; k++) sum += poissonPmf(5, k);
    // 50 is well past the 99.999% quantile of Poisson(5), so the
    // remaining tail is < 1e-12 and the truncated sum should round to 1.
    expect(sum).toBeCloseTo(1, 6);
  });

  it("returns 0 for negative k", () => {
    expect(poissonPmf(1, -1)).toBe(0);
  });

  it("returns 0 for non-integer k (negative or positive)", () => {
    expect(poissonPmf(1, 0.5)).toBe(0);
  });

  it("P(X=0) = 1 when lambda=0, 0 for k>0", () => {
    expect(poissonPmf(0, 0)).toBe(1);
    expect(poissonPmf(0, 1)).toBe(0);
  });

  it("throws on negative lambda", () => {
    expect(() => poissonPmf(-1, 0)).toThrow(MathError);
  });
});

describe("poissonProbAtLeast", () => {
  it("P(X >= 1) = 1 - e^(-lambda)", () => {
    expect(poissonProbAtLeast(1, 1)).toBeCloseTo(1 - Math.exp(-1), 10);
    expect(poissonProbAtLeast(2.5, 1)).toBeCloseTo(1 - Math.exp(-2.5), 10);
  });

  it("P(X >= 0) = 1 always", () => {
    expect(poissonProbAtLeast(1, 0)).toBe(1);
    expect(poissonProbAtLeast(0, 0)).toBe(1);
  });

  it("P(X >= 1) for small lambda is small", () => {
    // lambda = 0.1 → about 9.5% chance of at least one event
    expect(poissonProbAtLeast(0.1, 1)).toBeCloseTo(0.0952, 3);
  });

  it("P(X >= 5) for lambda = 5 is roughly 0.56", () => {
    // Hand-computed: P(X >= 5 | λ=5) ≈ 0.5595
    expect(poissonProbAtLeast(5, 5)).toBeCloseTo(0.5595, 3);
  });

  it("PMF consistency: P(X >= k) + P(X <= k-1) = 1", () => {
    const lambda = 3;
    const k = 2;
    const probAtLeast = poissonProbAtLeast(lambda, k);
    let probAtMost = 0;
    for (let i = 0; i < k; i++) probAtMost += poissonPmf(lambda, i);
    expect(probAtLeast + probAtMost).toBeCloseTo(1, 10);
  });

  it("does not throw for large lambda + k (numerical stability)", () => {
    // Sanity: lambda=20, k=10 should be a meaningful probability, not
    // silently underflow to 0 or overflow to Infinity.
    const p = poissonProbAtLeast(20, 10);
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThan(1);
    expect(Number.isFinite(p)).toBe(true);
  });
});
