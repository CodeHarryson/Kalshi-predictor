import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";

export interface CalibrationBucket {
  label: string;
  min: number;
  max: number;
  count: number;
  avgPredicted: number;
  actualWinRate: number;
}

export interface CalibrationReport {
  buckets: CalibrationBucket[];
  brierScore: number | null;
  sampleSize: number;
}

const BUCKET_SIZE = 0.1;

export async function computeCalibration(league?: League): Promise<CalibrationReport> {
  const rows = await db.modelFeatureLog.findMany({
    where: {
      ...(league ? { league } : {}),
      actualOutcome: { in: ["WON", "LOST"] },
    },
    select: { predictedProbability: true, actualOutcome: true },
  });

  if (rows.length === 0) {
    return { buckets: [], brierScore: null, sampleSize: 0 };
  }

  let sqError = 0;
  const bucketed = new Map<number, { predicted: number[]; actual: number[] }>();

  for (const row of rows) {
    const actual = row.actualOutcome === "WON" ? 1 : 0;
    sqError += (row.predictedProbability - actual) ** 2;

    const bucketIdx = Math.min(Math.floor(row.predictedProbability / BUCKET_SIZE), 9);
    const bucket = bucketed.get(bucketIdx) ?? { predicted: [], actual: [] };
    bucket.predicted.push(row.predictedProbability);
    bucket.actual.push(actual);
    bucketed.set(bucketIdx, bucket);
  }

  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < 10; i++) {
    const b = bucketed.get(i);
    if (!b) continue;
    const min = i * BUCKET_SIZE;
    const max = min + BUCKET_SIZE;
    buckets.push({
      label: `${Math.round(min * 100)}-${Math.round(max * 100)}%`,
      min,
      max,
      count: b.predicted.length,
      avgPredicted: average(b.predicted),
      actualWinRate: average(b.actual),
    });
  }

  return {
    buckets,
    brierScore: sqError / rows.length,
    sampleSize: rows.length,
  };
}

function average(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
