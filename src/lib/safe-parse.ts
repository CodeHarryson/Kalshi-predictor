/**
 * Safely parse a JSON string and validate the result with a user-supplied
 * type predicate. On any failure (invalid JSON, wrong shape, wrong types)
 * returns the caller-provided fallback. The optional `onError` hook lets
 * callers log + tag for observability without losing the safe-return
 * contract.
 *
 * Generic narrowing: TypeScript 4.9+ correctly narrows `T` inside the
 * predicate, so `safeParse<ModelWeights>(raw, isModelWeights, FALLBACK)`
 * returns `ModelWeights` (the type, not `unknown`).
 */
export function safeParse<T>(
  raw: string,
  validate: (v: unknown) => v is T,
  options: { fallback: T | null; onError?: (e: unknown, raw: string) => void }
): T | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    options.onError?.(e, raw);
    return options.fallback;
  }
  if (!validate(parsed)) {
    options.onError?.(new Error("safeParse: type predicate rejected value"), raw);
    return options.fallback;
  }
  return parsed;
}

/** Persisted shape of ModelWeights.weights (matches retrain.ts:37-38). */
export interface ModelWeightsShape {
  coefficients: number[];
}

export function isModelWeights(v: unknown): v is ModelWeightsShape {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.coefficients)) return false;
  return o.coefficients.every((c) => typeof c === "number" && Number.isFinite(c));
}

/**
 * Persisted shape of ModelFeatureLog.features. NOTE: this is the
 * 5-field shape actually written by builder.ts:76-82, NOT the 4-field
 * LegFeatures interface. They drifted apart when modelBlended was
 * added to the feature set.
 */
export interface StoredLegFeatures {
  baseProbability: number;
  ratingDiffNorm: number;
  isHome: number;
  recentFormDiff: number;
  modelBlended: number;
}

export function isStoredLegFeatures(v: unknown): v is StoredLegFeatures {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.baseProbability === "number" &&
    Number.isFinite(o.baseProbability) &&
    typeof o.ratingDiffNorm === "number" &&
    Number.isFinite(o.ratingDiffNorm) &&
    typeof o.isHome === "number" &&
    Number.isFinite(o.isHome) &&
    typeof o.recentFormDiff === "number" &&
    Number.isFinite(o.recentFormDiff) &&
    typeof o.modelBlended === "number" &&
    Number.isFinite(o.modelBlended)
  );
}
