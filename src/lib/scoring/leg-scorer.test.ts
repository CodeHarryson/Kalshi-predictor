import { describe, it, expect, vi } from "vitest";
import { parseModelWeights, EXPECTED_FEATURE_DIM } from "./leg-scorer";

describe("parseModelWeights", () => {
  it("returns coefficients for valid JSON with right dim", () => {
    const coeffs = Array(EXPECTED_FEATURE_DIM).fill(0).map((_, i) => i * 0.1);
    const r = parseModelWeights(JSON.stringify({ coefficients: coeffs }));
    expect(r).toEqual({ coefficients: coeffs });
  });

  it("returns null for invalid JSON", () => {
    expect(parseModelWeights("not json")).toBeNull();
  });

  it("returns null for wrong shape (object missing coefficients)", () => {
    expect(parseModelWeights(JSON.stringify({ intercept: 0 }))).toBeNull();
  });

  it("returns null when coefficients are not all numbers", () => {
    const bad = Array(EXPECTED_FEATURE_DIM).fill(0);
    bad[1] = "x" as unknown as number;
    expect(parseModelWeights(JSON.stringify({ coefficients: bad }))).toBeNull();
  });

  it("returns null for NaN/Infinity in coefficients", () => {
    const bad = Array(EXPECTED_FEATURE_DIM).fill(0);
    bad[1] = NaN;
    expect(parseModelWeights(JSON.stringify({ coefficients: bad }))).toBeNull();
  });

  it("returns null for wrong dimension", () => {
    expect(parseModelWeights(JSON.stringify({ coefficients: [0, 0.1, 0.2] }))).toBeNull();
  });

  it("logs warnings on bad input", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseModelWeights("garbage");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
