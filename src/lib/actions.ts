"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { League } from "@/generated/prisma/enums";
import {
  syncAll,
  syncLeagueSportsData,
  syncKalshiMarketsForLeague,
  ALL_LEAGUES,
} from "@/lib/sync";
import { maybeRetrainLeague, maybeRetrainAllLeagues } from "@/lib/scoring/retrain";
import { buildParlaySuggestions } from "@/lib/builder";
import type { CandidateLeg } from "@/lib/builder";
import { computeCalibration } from "@/lib/scoring/calibration";
import type { CalibrationReport } from "@/lib/scoring/calibration";
import { checkAdminToken } from "@/lib/admin-auth";
import { rateLimitAction } from "@/lib/rate-limit";

export interface ActionResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}

export async function syncSportsAction(
  league?: League
): Promise<ActionResult<{ leagues: number; gamesUpserted: number }>> {
  try {
    const denied = checkAdminToken((await headers()).get("x-admin-token"));
    if (!denied.ok) return { ok: false, error: denied.error };

    const limited = rateLimitAction(
      { key: "action syncSports", windowMs: 30_000, max: 1 },
      (await headers()).get("x-admin-token")
    );
    if (limited) return { ok: false, error: limited.error };

    const summaries = league
      ? [await syncLeagueSportsData(league)]
      : (await syncAll()).sports;
    revalidatePath("/");
    revalidatePath("/builder");
    return {
      ok: true,
      data: {
        leagues: summaries.length,
        gamesUpserted: summaries.reduce((n, s) => n + s.gamesUpserted, 0),
      },
    };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function syncKalshiAction(
  league?: League
): Promise<ActionResult<{ marketsUpserted: number; configured: boolean }>> {
  try {
    const denied = checkAdminToken((await headers()).get("x-admin-token"));
    if (!denied.ok) return { ok: false, error: denied.error };

    const limited = rateLimitAction(
      { key: "action syncKalshi", windowMs: 30_000, max: 1 },
      (await headers()).get("x-admin-token")
    );
    if (limited) return { ok: false, error: limited.error };

    const leagues = league ? [league] : ALL_LEAGUES;
    const summaries = [];
    for (const l of leagues) {
      summaries.push(await syncKalshiMarketsForLeague(l));
    }
    revalidatePath("/");
    revalidatePath("/builder");
    return {
      ok: true,
      data: {
        marketsUpserted: summaries.reduce((n, s) => n + s.marketsUpserted, 0),
        configured: summaries.some((s) => s.configured),
      },
    };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function retrainAction(
  league?: League
): Promise<ActionResult<{ trained: number; sampleSize: number }>> {
  try {
    const denied = checkAdminToken((await headers()).get("x-admin-token"));
    if (!denied.ok) return { ok: false, error: denied.error };

    const limited = rateLimitAction(
      { key: "action retrain", windowMs: 60_000, max: 1 },
      (await headers()).get("x-admin-token")
    );
    if (limited) return { ok: false, error: limited.error };

    const results = league
      ? [await maybeRetrainLeague(league)]
      : await maybeRetrainAllLeagues();
    revalidatePath("/model");
    return {
      ok: true,
      data: {
        trained: results.filter((r) => r.trained).length,
        sampleSize: results.reduce((n, r) => n + r.sampleSize, 0),
      },
    };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function fetchSuggestionsAction(
  league: string
): Promise<ActionResult<{ candidates: CandidateLeg[] }>> {
  try {
    const denied = checkAdminToken((await headers()).get("x-admin-token"));
    if (!denied.ok) return { ok: false, error: denied.error };

    if (typeof league !== "string" || !(league in ALL_LEAGUES) || league === "") {
      return { ok: false, error: "Invalid league" };
    }
    const candidates = await buildParlaySuggestions(league as League);
    return { ok: true, data: { candidates } };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function fetchCalibrationAction(
  league: string
): Promise<ActionResult<CalibrationReport>> {
  try {
    const denied = checkAdminToken((await headers()).get("x-admin-token"));
    if (!denied.ok) return { ok: false, error: denied.error };

    if (typeof league !== "string" || !(league in ALL_LEAGUES) || league === "") {
      return { ok: false, error: "Invalid league" };
    }
    const report = await computeCalibration(league as League);
    return { ok: true, data: report };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}
