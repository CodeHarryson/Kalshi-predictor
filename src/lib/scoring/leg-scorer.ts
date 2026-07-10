import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";
import { estimateGameProbabilities } from "./composite";
import { predictLogistic } from "./logistic";
import { safeParse, isModelWeights, type ModelWeightsShape } from "@/lib/safe-parse";

export interface LegFeatures {
  baseProbability: number;
  ratingDiffNorm: number;
  isHome: number;
  recentFormDiff: number;
}

export interface LegScore {
  probability: number;
  baseProbability: number;
  features: LegFeatures;
  modelBlended: boolean;
}

export const MIN_SAMPLES_TO_TRAIN = 30;

export const EXPECTED_FEATURE_DIM = 5; // 1 bias + 4 features (see featuresToVector)

/**
 * Parses a ModelWeights.weights string into the expected shape. Returns
 * null on any failure (invalid JSON, wrong shape, non-finite coefficients,
 * wrong dimension). Exported for unit tests.
 */
export function parseModelWeights(raw: string): ModelWeightsShape | null {
  const result = safeParse<ModelWeightsShape | null>(raw, isModelWeights, {
    fallback: null,
    onError: (e) => console.warn("[leg-scorer] bad modelWeights, falling back to Elo", e),
  });
  if (result === null) {
    return null;
  }
  if (result.coefficients.length !== EXPECTED_FEATURE_DIM) {
    console.warn(
      `[leg-scorer] coefficients length ${result.coefficients.length} != ${EXPECTED_FEATURE_DIM}, falling back to Elo`
    );
    return null;
  }
  return result;
}

export function featuresToVector(f: LegFeatures): number[] {
  return [1, f.baseProbability, f.ratingDiffNorm, f.isHome, f.recentFormDiff];
}

/**
 * Scores the probability that `side` (home or away team) wins the given
 * game. Starts from the explainable Elo+form estimate (composite.ts); if a
 * trained logistic model exists for the league (see retrain.ts) with enough
 * samples, its prediction is used instead as the final probability, with
 * the Elo estimate still included as an input feature so the learned model
 * is a calibration correction on top of it rather than a from-scratch model.
 */
export async function scoreGameSideProbability(
  gameId: string,
  side: "home" | "away"
): Promise<LegScore | null> {
  const est = await estimateGameProbabilities(gameId);
  if (!est) return null;

  const baseProbability = side === "home" ? est.homeWin : est.awayWin;
  const ratingDiff =
    side === "home" ? est.homeRating - est.awayRating : est.awayRating - est.homeRating;
  const formDiff =
    side === "home"
      ? est.homeRecentForm - est.awayRecentForm
      : est.awayRecentForm - est.homeRecentForm;

  const features: LegFeatures = {
    baseProbability,
    ratingDiffNorm: ratingDiff / 400,
    isHome: side === "home" ? 1 : 0,
    recentFormDiff: formDiff,
  };

  const game = await db.game.findUnique({ where: { id: gameId }, select: { league: true } });
  const league = game?.league as League | undefined;
  const modelWeights = league ? await db.modelWeights.findUnique({ where: { league } }) : null;

  if (modelWeights && modelWeights.sampleSize >= MIN_SAMPLES_TO_TRAIN) {
    const weights = parseModelWeights(modelWeights.weights);
    if (weights) {
      const probability = predictLogistic(weights.coefficients, featuresToVector(features));
      return { probability, baseProbability, features, modelBlended: true };
    }
  }

  return { probability: baseProbability, baseProbability, features, modelBlended: false };
}
