import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";
import { trainLogisticRegression } from "./logistic";
import { featuresToVector, MIN_SAMPLES_TO_TRAIN } from "./leg-scorer";
import { safeParse, isStoredLegFeatures, type StoredLegFeatures } from "@/lib/safe-parse";
import { ALL_LEAGUES } from "@/lib/sync";

export interface RetrainResult {
  league: League;
  trained: boolean;
  sampleSize: number;
}

/**
 * Retrains the logistic blend for a league from every settled
 * ModelFeatureLog row (WON/LOST legs). Below MIN_SAMPLES_TO_TRAIN this is a
 * no-op - leg-scorer.ts falls back to the pure Elo+form estimate until then.
 * Call this after settling parlays (see app/api/parlays/[id]/settle) so the
 * model keeps improving as real outcomes accumulate.
 */
export async function maybeRetrainLeague(league: League): Promise<RetrainResult> {
  const rows = await db.modelFeatureLog.findMany({
    where: { league, actualOutcome: { in: ["WON", "LOST"] } },
  });

  if (rows.length < MIN_SAMPLES_TO_TRAIN) {
    return { league, trained: false, sampleSize: rows.length };
  }

  const dataset: { x: number[]; y: number }[] = [];
  for (const row of rows) {
    const features = safeParse<StoredLegFeatures | null>(row.features, isStoredLegFeatures, {
      fallback: null,
      onError: (e) => console.warn(`[retrain:${league}] skipping bad row ${row.id}`, e),
    });
    if (features === null) continue; // skip invalid row, don't fail whole retrain
    dataset.push({
      x: featuresToVector(features),
      y: row.actualOutcome === "WON" ? 1 : 0,
    });
  }

  const coefficients = trainLogisticRegression(dataset);

  await db.modelWeights.upsert({
    where: { league },
    create: { league, weights: JSON.stringify({ coefficients }), sampleSize: rows.length },
    update: { weights: JSON.stringify({ coefficients }), sampleSize: rows.length, trainedAt: new Date() },
  });

  return { league, trained: true, sampleSize: rows.length };
}

export async function maybeRetrainAllLeagues(): Promise<RetrainResult[]> {
  return Promise.all(ALL_LEAGUES.map(maybeRetrainLeague));
}
