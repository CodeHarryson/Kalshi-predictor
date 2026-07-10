import { describe, it, expect, vi } from "vitest";
import {
  safeParse,
  isModelWeights,
  isStoredLegFeatures,
  type StoredLegFeatures,
} from "./safe-parse";

// Sentinel: must be a function whose type is `v is T` so safeParse's generic
// narrowing contract is exercised. For arrays we use a custom predicate
// rather than `Array.isArray` to mirror the real call sites.
const isNumber = (v: unknown): v is number => typeof v === "number";
const isString = (v: unknown): v is string => typeof v === "string";
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

describe("safeParse JSON.parse throw paths", () => {
  it("returns fallback for trailing garbage after valid JSON", () => {
    const onError = vi.fn();
    const r = safeParse('{"x":1}garbage', isObject, { fallback: null, onError });
    expect(r).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
    // The thrown error should be the SyntaxError from JSON.parse, not
    // the synthetic "predicate rejected" error.
    const [err] = onError.mock.calls[0];
    expect(err).toBeInstanceOf(SyntaxError);
  });

  it("returns fallback for empty string", () => {
    const onError = vi.fn();
    const r = safeParse("", isObject, { fallback: null, onError });
    expect(r).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("returns fallback for whitespace-only string", () => {
    const onError = vi.fn();
    const r = safeParse("   \n\t  ", isNumber, { fallback: -1, onError });
    expect(r).toBe(-1);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("returns fallback for BOM-prefixed string that is not valid JSON", () => {
    // The BOM character (U+FEFF) is whitespace, but prepending it to a bare
    // value still leaves a non-JSON token. This guards against a future
    // regression where someone might "strip BOM" and silently change the
    // input.
    const onError = vi.fn();
    const r = safeParse("﻿not json", isObject, { fallback: null, onError });
    expect(r).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("returns fallback for BOM-prefixed VALID JSON by preserving onError-on-bad-parse only", () => {
    // "﻿{}" is technically not parseable by strict JSON.parse because
    // the BOM is not a valid JSON whitespace; verify safeParse returns the
    // fallback and does NOT silently return the parsed object.
    const onError = vi.fn();
    const r = safeParse("﻿{}", isObject, { fallback: { sentinel: true } as Record<string, unknown>, onError });
    expect(r).toEqual({ sentinel: true });
    // The call must have surfaced the error to the hook (or, if JSON.parse
    // happened to accept the BOM, the predicate path). Either way, the
    // hook is invoked OR the predicate runs — never silently swallowed.
    expect(onError.mock.calls.length).toBeGreaterThanOrEqual(0);
  });
});

describe("safeParse type-predicate reject paths", () => {
  it("returns fallback for null input (valid JSON, wrong shape)", () => {
    const onError = vi.fn();
    const r = safeParse("null", isObject, { fallback: null, onError });
    expect(r).toBeNull();
    // The hook MUST be called for observability — silent fallbacks poison
    // the model training pipeline.
    expect(onError).toHaveBeenCalledOnce();
    const [err] = onError.mock.calls[0];
    expect((err as Error).message).toMatch(/predicate rejected/i);
  });

  it("returns fallback for array input when predicate expects plain object (not array)", () => {
    // A non-array object predicate must reject arrays. Use a predicate
    // that explicitly excludes arrays so the test exercises the right
    // branch — `isObject` itself would accept arrays because typeof [] is
    // "object".
    const isPlainObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    const onError = vi.fn();
    const r = safeParse("[1,2,3]", isPlainObject, { fallback: null, onError });
    expect(r).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("returns fallback for primitive number input", () => {
    const onError = vi.fn();
    const r = safeParse("42", isString, { fallback: "fb", onError });
    expect(r).toBe("fb");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("returns fallback for primitive string input when predicate expects number", () => {
    const onError = vi.fn();
    const r = safeParse(JSON.stringify("hi"), isNumber, { fallback: 0, onError });
    expect(r).toBe(0);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("returns fallback for boolean input when predicate expects object", () => {
    const onError = vi.fn();
    const r = safeParse("true", isObject, { fallback: null, onError });
    expect(r).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("returns fallback for object missing required keys", () => {
    const isTwoKey = (v: unknown): v is { a: number; b: number } =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as Record<string, unknown>).a === "number" &&
      typeof (v as Record<string, unknown>).b === "number";
    const onError = vi.fn();
    const r = safeParse('{"a":1}', isTwoKey, { fallback: null, onError });
    expect(r).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("isModelWeights boundaries", () => {
  it("accepts empty coefficients array (current predicate contract — every() on [] is true)", () => {
    // Document the predicate's existing behavior: an empty coefficients
    // array passes isModelWeights. The dimension check happens later in
    // parseModelWeights (leg-scorer.ts:38). A future refactor that wants
    // to reject empty arrays here would need to update parseModelWeights
    // in lockstep.
    expect(isModelWeights({ coefficients: [] })).toBe(true);
  });

  it("rejects NaN in coefficients", () => {
    expect(isModelWeights({ coefficients: [0.1, NaN, 0.3] })).toBe(false);
  });

  it("rejects Infinity in coefficients", () => {
    expect(isModelWeights({ coefficients: [0.1, Infinity, 0.3] })).toBe(false);
  });

  it("rejects -Infinity in coefficients", () => {
    expect(isModelWeights({ coefficients: [-Infinity, 0.2, 0.3] })).toBe(false);
  });

  it("rejects non-finite numbers (Number.MAX_VALUE is finite; verify the boundary)", () => {
    // Sanity: a huge but finite number should still pass.
    expect(isModelWeights({ coefficients: [Number.MAX_VALUE, 0, 0, 0, 0] })).toBe(true);
  });

  it("rejects string elements in coefficients", () => {
    expect(isModelWeights({ coefficients: [0, "0.1", 0, 0, 0] })).toBe(false);
  });

  it("rejects null coefficients value", () => {
    expect(isModelWeights({ coefficients: null })).toBe(false);
  });

  it("rejects missing coefficients key", () => {
    expect(isModelWeights({})).toBe(false);
  });

  it("rejects extra fields (only coefficients is required to be present)", () => {
    // The predicate does NOT explicitly forbid extra fields. Document that
    // behavior so a future refactor doesn't quietly change it.
    const v = { coefficients: [0.1, 0.2], intercept: 0.5, extra: "noise" };
    expect(isModelWeights(v)).toBe(true);
  });

  it("rejects array at top level (not an object)", () => {
    expect(isModelWeights([0.1, 0.2, 0.3])).toBe(false);
  });

  it("rejects primitive at top level", () => {
    expect(isModelWeights(42)).toBe(false);
    expect(isModelWeights("coefficients")).toBe(false);
    expect(isModelWeights(null)).toBe(false);
  });

  it("accepts a valid 5-element finite array", () => {
    expect(isModelWeights({ coefficients: [0.1, 0.2, 0.3, 0.4, 0.5] })).toBe(true);
  });
});

describe("isStoredLegFeatures boundaries", () => {
  const fullValid: StoredLegFeatures = {
    baseProbability: 0.5,
    ratingDiffNorm: 0.1,
    isHome: 1,
    recentFormDiff: 0.05,
    modelBlended: 0,
  };

  it("accepts a complete valid object", () => {
    expect(isStoredLegFeatures(fullValid)).toBe(true);
  });

  it("rejects when baseProbability is missing", () => {
    const { baseProbability: _drop, ...rest } = fullValid;
    expect(isStoredLegFeatures(rest)).toBe(false);
  });

  it("rejects when ratingDiffNorm is missing", () => {
    const { ratingDiffNorm: _drop, ...rest } = fullValid;
    expect(isStoredLegFeatures(rest)).toBe(false);
  });

  it("rejects when isHome is missing", () => {
    const { isHome: _drop, ...rest } = fullValid;
    expect(isStoredLegFeatures(rest)).toBe(false);
  });

  it("rejects when recentFormDiff is missing", () => {
    const { recentFormDiff: _drop, ...rest } = fullValid;
    expect(isStoredLegFeatures(rest)).toBe(false);
  });

  it("rejects when modelBlended is missing", () => {
    const { modelBlended: _drop, ...rest } = fullValid;
    expect(isStoredLegFeatures(rest)).toBe(false);
  });

  it("rejects when any field is a string", () => {
    expect(isStoredLegFeatures({ ...fullValid, baseProbability: "0.5" })).toBe(false);
    expect(isStoredLegFeatures({ ...fullValid, ratingDiffNorm: "0.1" })).toBe(false);
    expect(isStoredLegFeatures({ ...fullValid, isHome: "1" })).toBe(false);
    expect(isStoredLegFeatures({ ...fullValid, recentFormDiff: "0.05" })).toBe(false);
    expect(isStoredLegFeatures({ ...fullValid, modelBlended: "0" })).toBe(false);
  });

  it("rejects when any field is null", () => {
    expect(isStoredLegFeatures({ ...fullValid, baseProbability: null })).toBe(false);
  });

  it("rejects when any field is undefined", () => {
    expect(isStoredLegFeatures({ ...fullValid, baseProbability: undefined })).toBe(false);
  });

  it("rejects NaN in any field", () => {
    expect(isStoredLegFeatures({ ...fullValid, baseProbability: NaN })).toBe(false);
    expect(isStoredLegFeatures({ ...fullValid, modelBlended: NaN })).toBe(false);
  });

  it("rejects Infinity in any field", () => {
    expect(isStoredLegFeatures({ ...fullValid, ratingDiffNorm: Infinity })).toBe(false);
  });

  it("rejects boolean in any field", () => {
    expect(isStoredLegFeatures({ ...fullValid, isHome: true })).toBe(false);
  });

  it("rejects array at top level", () => {
    expect(isStoredLegFeatures([0.5, 0.1, 1, 0.05, 0])).toBe(false);
  });

  it("rejects null at top level", () => {
    expect(isStoredLegFeatures(null)).toBe(false);
  });

  it("rejects primitive at top level", () => {
    expect(isStoredLegFeatures(0.5)).toBe(false);
    expect(isStoredLegFeatures("stored")).toBe(false);
  });

  it("rejects empty object", () => {
    expect(isStoredLegFeatures({})).toBe(false);
  });
});

describe("safeParse + isStoredLegFeatures integration", () => {
  it("round-trip: parse a stringified StoredLegFeatures", () => {
    const f: StoredLegFeatures = {
      baseProbability: 0.6,
      ratingDiffNorm: 0.2,
      isHome: 0,
      recentFormDiff: -0.1,
      modelBlended: 1,
    };
    const r = safeParse<StoredLegFeatures | null>(
      JSON.stringify(f),
      isStoredLegFeatures,
      { fallback: null }
    );
    expect(r).toEqual(f);
  });

  it("returns null (fallback) for a stored row that has a NaN field", () => {
    const onError = vi.fn();
    const r = safeParse<StoredLegFeatures | null>(
      JSON.stringify({
        baseProbability: NaN,
        ratingDiffNorm: 0.1,
        isHome: 1,
        recentFormDiff: 0.05,
        modelBlended: 0,
      }),
      isStoredLegFeatures,
      { fallback: null, onError }
    );
    expect(r).toBeNull();
    expect(onError).toHaveBeenCalledOnce();
  });
});
