"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import type { League } from "@/generated/prisma/enums";
import {
  syncAll,
  syncLeagueSportsData,
  syncKalshiMarketsForLeague,
  syncPropMarketsForLeague,
  ALL_LEAGUES,
} from "@/lib/sync";
import { syncPlayerPropsForLeague } from "@/lib/player-props/sync";
import { maybeRetrainLeague, maybeRetrainAllLeagues } from "@/lib/scoring/retrain";
import { buildParlaySuggestions } from "@/lib/builder";
import type { CandidateLeg } from "@/lib/builder";
import { computeCalibration } from "@/lib/scoring/calibration";
import type { CalibrationReport } from "@/lib/scoring/calibration";
import { checkAdminToken } from "@/lib/admin-auth";
import { importKalshiPortfolio, type KalshiImportSummary } from "@/lib/kalshi-import";
import { rateLimitAction } from "@/lib/rate-limit";
import { db } from "@/lib/db";

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
      await syncPropMarketsForLeague(l);
      await syncPlayerPropsForLeague(l);
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

// Pulls the signed-in Kalshi account's bets (combos and singles, with entry
// price, stake and settled results) into History. Read-only against Kalshi.
export async function importKalshiBetsAction(
  token?: string | null
): Promise<ActionResult<KalshiImportSummary>> {
  const start = Date.now();
  try {
    const t = await resolveToken(token);
    const denied = checkAdminToken(t);
    if (!denied.ok) {
      console.warn(`[action.importKalshiBets] denied: ${denied.error}`);
      return { ok: false, error: denied.error };
    }

    const limited = rateLimitAction({ key: "action importKalshiBets", windowMs: 30_000, max: 1 }, t);
    if (limited) return { ok: false, error: limited.error };

    const summary = await importKalshiPortfolio();
    console.info(
      `[action.importKalshiBets] done in ${Date.now() - start}ms — ` +
        `bets=${summary.bets}, created=${summary.created}, updated=${summary.updated}, adopted=${summary.adopted}`
    );
    revalidatePath("/");
    revalidatePath("/history");
    return { ok: true, data: summary };
  } catch (err) {
    console.error(`[action.importKalshiBets] threw after ${Date.now() - start}ms:`, err);
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

// A day filter arrives as two ISO timestamps computed in the browser, since
// "today" depends on the viewer's timezone, not the server's.
const MAX_RANGE_MS = 8 * 24 * 60 * 60 * 1000;

function parseRange(range?: { from: string; to: string } | null): { from: Date; to: Date } | "invalid" | null {
  if (!range) return null;
  const from = new Date(range.from);
  const to = new Date(range.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return "invalid";
  if (to <= from || to.getTime() - from.getTime() > MAX_RANGE_MS) return "invalid";
  return { from, to };
}

export async function fetchSuggestionsAction(
  league: string,
  token?: string | null,
  range?: { from: string; to: string } | null
): Promise<ActionResult<{ candidates: CandidateLeg[] }>> {
  try {
    const denied = checkAdminToken(await resolveToken(token));
    if (!denied.ok) return { ok: false, error: denied.error };

    if (typeof league !== "string" || !ALL_LEAGUES.includes(league as League) || league === "") {
      return { ok: false, error: "Invalid league" };
    }
    const window = parseRange(range);
    if (window === "invalid") return { ok: false, error: "Invalid day range" };
    const candidates = await buildParlaySuggestions(league as League, window ?? undefined);
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

// Manual outcome for a parlay the user built. The auto-settle path at
// /api/parlays/[id]/settle owns the data-driven WON/LOST/PUSH rollup;
// this action is for the case where the user wants to mark a parlay
// before settlement runs (or after, in case settlement never fires).
// Refuses to overwrite a parlay that has already been settled, so a
// race with the auto-settler can't silently rewrite history.
export async function markParlayOutcomeAction(
  parlayId: string,
  outcome: "WON" | "LOST",
  token?: string | null
): Promise<ActionResult<{ id: string; status: "WON" | "LOST" }>> {
  const start = Date.now();
  try {
    if (typeof parlayId !== "string" || parlayId.length === 0) {
      return { ok: false, error: "parlayId is required" };
    }
    if (outcome !== "WON" && outcome !== "LOST") {
      return { ok: false, error: "outcome must be 'WON' or 'LOST'" };
    }

    const t = await resolveToken(token);
    const denied = checkAdminToken(t);
    if (!denied.ok) {
      console.warn(`[action.markParlayOutcome] denied: ${denied.error}`);
      return { ok: false, error: denied.error };
    }

    // 5/30s instead of 1/30s — the user may tap multiple pending rows
    // in one session while grading paper trades.
    const limited = rateLimitAction(
      { key: "action markParlayOutcome", windowMs: 30_000, max: 5 },
      t
    );
    if (limited) {
      console.warn(`[action.markParlayOutcome] rate-limited: ${limited.error}`);
      return { ok: false, error: limited.error };
    }

    // Atomic guard: the update only succeeds if the row is still
    // PENDING. If a concurrent /api/parlays/[id]/settle call already
    // resolved it, the user-facing write is rejected with a clear
    // message instead of silently clobbering the auto-settled result.
    const result = await db.parlay.updateMany({
      where: { id: parlayId, status: "PENDING" },
      data: { status: outcome },
    });
    if (result.count === 0) {
      return { ok: false, error: "Parlay is not pending — already settled." };
    }

    console.info(
      `[action.markParlayOutcome] done in ${Date.now() - start}ms — ` +
        `id=${parlayId}, outcome=${outcome}`
    );
    revalidatePath("/history");
    revalidatePath("/");
    return { ok: true, data: { id: parlayId, status: outcome } };
  } catch (err) {
    console.error(
      `[action.markParlayOutcome] threw after ${Date.now() - start}ms:`,
      err
    );
    return { ok: false, error: toMessage(err) };
  }
}
