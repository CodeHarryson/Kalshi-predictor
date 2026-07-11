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

// Server-action RPC requests don't auto-forward custom request headers
// from the browser, so a client component can't rely on the
// `x-admin-token` header to reach a server action. Accept the token as
// an explicit arg and fall back to the header (so existing API routes
// and tests that pass the header keep working).
async function resolveToken(override?: string | null): Promise<string | null> {
  if (typeof override === "string" && override.length > 0) return override;
  return (await headers()).get("x-admin-token");
}

export async function syncSportsAction(
  league?: League,
  token?: string | null
): Promise<ActionResult<{ leagues: number; gamesUpserted: number }>> {
  const start = Date.now();
  try {
    const t = await resolveToken(token);
    const denied = checkAdminToken(t);
    if (!denied.ok) {
      console.warn(`[action.syncSports] denied: ${denied.error}`);
      return { ok: false, error: denied.error };
    }

    const limited = rateLimitAction(
      { key: "action syncSports", windowMs: 30_000, max: 1 },
      t
    );
    if (limited) {
      console.warn(`[action.syncSports] rate-limited: ${limited.error}`);
      return { ok: false, error: limited.error };
    }

    const summaries = league
      ? [await syncLeagueSportsData(league)]
      : (await syncAll()).sports;
    const totalGames = summaries.reduce((n, s) => n + s.gamesUpserted, 0);
    console.info(
      `[action.syncSports] done in ${Date.now() - start}ms — ` +
        `leagues=${summaries.length}, gamesUpserted=${totalGames}`
    );
    revalidatePath("/");
    revalidatePath("/builder");
    return {
      ok: true,
      data: { leagues: summaries.length, gamesUpserted: totalGames },
    };
  } catch (err) {
    console.error(`[action.syncSports] threw after ${Date.now() - start}ms:`, err);
    return { ok: false, error: toMessage(err) };
  }
}

export async function syncKalshiAction(
  league?: League,
  token?: string | null
): Promise<ActionResult<{ marketsUpserted: number; configured: boolean }>> {
  const start = Date.now();
  try {
    const t = await resolveToken(token);
    const denied = checkAdminToken(t);
    if (!denied.ok) {
      console.warn(`[action.syncKalshi] denied: ${denied.error}`);
      return { ok: false, error: denied.error };
    }

    const limited = rateLimitAction(
      { key: "action syncKalshi", windowMs: 30_000, max: 1 },
      t
    );
    if (limited) {
      console.warn(`[action.syncKalshi] rate-limited: ${limited.error}`);
      return { ok: false, error: limited.error };
    }

    const leagues = league ? [league] : ALL_LEAGUES;
    console.info(`[action.syncKalshi] start — leagues=${leagues.join(",")}`);
    const summaries = [];
    for (const l of leagues) {
      summaries.push(await syncKalshiMarketsForLeague(l));
    }
    const totalUpserted = summaries.reduce((n, s) => n + s.marketsUpserted, 0);
    const anyConfigured = summaries.some((s) => s.configured);
    console.info(
      `[action.syncKalshi] done in ${Date.now() - start}ms — ` +
        `leagues=${summaries.length}, configured=${anyConfigured}, upserted=${totalUpserted}`
    );
    revalidatePath("/");
    revalidatePath("/builder");
    return {
      ok: true,
      data: {
        marketsUpserted: totalUpserted,
        configured: anyConfigured,
      },
    };
  } catch (err) {
    console.error(`[action.syncKalshi] threw after ${Date.now() - start}ms:`, err);
    return { ok: false, error: toMessage(err) };
  }
}

export async function retrainAction(
  league?: League,
  token?: string | null
): Promise<ActionResult<{ trained: number; sampleSize: number }>> {
  try {
    const t = await resolveToken(token);
    const denied = checkAdminToken(t);
    if (!denied.ok) return { ok: false, error: denied.error };

    const limited = rateLimitAction(
      { key: "action retrain", windowMs: 60_000, max: 1 },
      t
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
  league: string,
  token?: string | null
): Promise<ActionResult<{ candidates: CandidateLeg[] }>> {
  try {
    const denied = checkAdminToken(await resolveToken(token));
    if (!denied.ok) return { ok: false, error: denied.error };

    if (typeof league !== "string" || !ALL_LEAGUES.includes(league as League) || league === "") {
      return { ok: false, error: "Invalid league" };
    }
    const candidates = await buildParlaySuggestions(league as League);
    return { ok: true, data: { candidates } };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function fetchCalibrationAction(
  league: string,
  token?: string | null
): Promise<ActionResult<CalibrationReport>> {
  try {
    const denied = checkAdminToken(await resolveToken(token));
    if (!denied.ok) return { ok: false, error: denied.error };

    if (typeof league !== "string" || !ALL_LEAGUES.includes(league as League) || league === "") {
      return { ok: false, error: "Invalid league" };
    }
    const report = await computeCalibration(league as League);
    return { ok: true, data: report };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}
