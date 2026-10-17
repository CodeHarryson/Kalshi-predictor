import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";

/**
 * Margin-based recent form and head-to-head history for two-outcome leagues.
 *
 * Margin of victory is already inside the Elo update (elo.ts), which is
 * where almost all of its value comes from. These are extra terms on top:
 * how the two teams have scored lately, and how this pairing has gone. They
 * were measured, not assumed, by fitting each on the first half of two
 * seasons of games and scoring the second half:
 *   - recent margin helped slightly in the NFL (5 games) and CFB (10 games),
 *     and did nothing for the NBA;
 *   - head-to-head never helped reliably (the NFL fit even went negative),
 *     so it is computed and logged but carries no weight.
 * Weights are logit shifts per normalized unit and are deliberately small.
 * Re-fit them as more seasons are backfilled.
 */

/** Per-league recent-margin settings. `scale` is a typical margin used to normalize. */
export const MARGIN_FORM: Partial<Record<League, { window: number; scale: number; weight: number }>> = {
  NBA: { window: 5, scale: 12, weight: 0 },
  NFL: { window: 5, scale: 13, weight: 0.1 },
  CFB: { window: 10, scale: 18, weight: 0.2 },
};

/** Head-to-head weight per league: zero everywhere until it earns one. */
export const H2H_WEIGHT: Partial<Record<League, number>> = {};

const H2H_LOOKBACK_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_NORMALIZED = 2;

export interface ScoredGame {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
}

export function normalizeMargin(margin: number, scale: number): number {
  return Math.max(-MAX_NORMALIZED, Math.min(MAX_NORMALIZED, margin / scale));
}

/** Average margin from `teamId`'s side across games it played in; null if none have scores. */
export function averageMarginFor(teamId: string, games: ScoredGame[]): number | null {
  const margins: number[] = [];
  for (const g of games) {
    if (g.homeScore == null || g.awayScore == null) continue;
    if (g.homeTeamId === teamId) margins.push(g.homeScore - g.awayScore);
    else if (g.awayTeamId === teamId) margins.push(g.awayScore - g.homeScore);
  }
  return margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : null;
}

/** Moves a probability by `shift` on the logit scale. */
export function applyLogitShift(p: number, shift: number): number {
  if (shift === 0) return p;
  const c = Math.max(1e-4, Math.min(1 - 1e-4, p));
  return 1 / (1 + Math.exp(-(Math.log(c / (1 - c)) + shift)));
}

export interface MatchupContext {
  /** Normalized average margin over the last N games, from each side's view. */
  homeRecentMargin: number;
  awayRecentMargin: number;
  /** Normalized average margin of past meetings from the home team's view. */
  h2hMargin: number;
  h2hGames: number;
  /** Logit shift to apply to the home side's win probability (0 when weights are 0). */
  logitShift: number;
}

const EMPTY: MatchupContext = {
  homeRecentMargin: 0,
  awayRecentMargin: 0,
  h2hMargin: 0,
  h2hGames: 0,
  logitShift: 0,
};

/**
 * `ignoreRecent` is set across an offseason, when "recent" games are last
 * season's and say little about this one; head-to-head still applies.
 */
export async function getMatchupContext(
  game: { league: League; startTime: Date; homeTeamId: string; awayTeamId: string },
  ignoreRecent: boolean
): Promise<MatchupContext> {
  const cfg = MARGIN_FORM[game.league];
  if (!cfg) return EMPTY;

  const recentOf = async (teamId: string) => {
    if (ignoreRecent) return 0;
    const games = await db.game.findMany({
      where: {
        league: game.league,
        status: "FINAL",
        startTime: { lt: game.startTime },
        OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
      },
      orderBy: { startTime: "desc" },
      take: cfg.window,
      select: { homeTeamId: true, awayTeamId: true, homeScore: true, awayScore: true },
    });
    const avg = averageMarginFor(teamId, games);
    return avg == null ? 0 : normalizeMargin(avg, cfg.scale);
  };

  const [homeRecentMargin, awayRecentMargin, meetings] = await Promise.all([
    recentOf(game.homeTeamId),
    recentOf(game.awayTeamId),
    db.game.findMany({
      where: {
        league: game.league,
        status: "FINAL",
        startTime: { lt: game.startTime, gte: new Date(game.startTime.getTime() - H2H_LOOKBACK_MS) },
        OR: [
          { homeTeamId: game.homeTeamId, awayTeamId: game.awayTeamId },
          { homeTeamId: game.awayTeamId, awayTeamId: game.homeTeamId },
        ],
      },
      select: { homeTeamId: true, awayTeamId: true, homeScore: true, awayScore: true },
    }),
  ]);

  const h2hAvg = averageMarginFor(game.homeTeamId, meetings);
  const h2hMargin = h2hAvg == null ? 0 : normalizeMargin(h2hAvg, cfg.scale);

  const logitShift =
    cfg.weight * (homeRecentMargin - awayRecentMargin) + (H2H_WEIGHT[game.league] ?? 0) * h2hMargin;

  return { homeRecentMargin, awayRecentMargin, h2hMargin, h2hGames: meetings.length, logitShift };
}
