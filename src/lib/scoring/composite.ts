import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";
import { DEFAULT_RATING, matchOutcomeProbabilities, type MatchOutcomeProbabilities } from "./elo";

const RECENT_FORM_WINDOW = 5;
const FORM_WEIGHT = 0.1; // max +/-5% nudge from recent-form delta

export interface GameProbabilityEstimate extends MatchOutcomeProbabilities {
  homeRating: number;
  awayRating: number;
  homeRecentForm: number; // win rate over last N games, 0-1
  awayRecentForm: number;
}

async function recentFormWinRate(teamId: string, beforeDate: Date): Promise<number> {
  const games = await db.game.findMany({
    where: {
      status: "FINAL",
      startTime: { lt: beforeDate },
      OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
    },
    orderBy: { startTime: "desc" },
    take: RECENT_FORM_WINDOW,
  });

  if (games.length === 0) return 0.5;

  const wins = games.filter((g) => {
    const isHome = g.homeTeamId === teamId;
    const teamScore = isHome ? g.homeScore : g.awayScore;
    const oppScore = isHome ? g.awayScore : g.homeScore;
    return (teamScore ?? 0) > (oppScore ?? 0);
  }).length;

  return wins / games.length;
}

async function getRating(teamId: string): Promise<number> {
  const r = await db.teamRating.findUnique({ where: { teamId } });
  return r?.rating ?? DEFAULT_RATING;
}

/**
 * Full v1 explainable probability estimate for a game: Elo win/draw/loss
 * probabilities (home-field adjusted), nudged by a small recent-form
 * momentum factor. See elo.ts for the Elo model itself.
 */
export async function estimateGameProbabilities(gameId: string): Promise<GameProbabilityEstimate | null> {
  const game = await db.game.findUnique({ where: { id: gameId } });
  if (!game) return null;

  const [homeRating, awayRating, homeForm, awayForm] = await Promise.all([
    getRating(game.homeTeamId),
    getRating(game.awayTeamId),
    recentFormWinRate(game.homeTeamId, game.startTime),
    recentFormWinRate(game.awayTeamId, game.startTime),
  ]);

  const base = matchOutcomeProbabilities(game.league, homeRating, awayRating);

  const formDelta = homeForm - awayForm; // -1..1
  const adjustment = clamp(formDelta * FORM_WEIGHT, -0.05, 0.05);

  let homeWin = base.homeWin + adjustment;
  let awayWin = base.awayWin - adjustment;
  homeWin = clamp(homeWin, 0.01, 0.98);
  awayWin = clamp(awayWin, 0.01, 0.98);
  const draw = Math.max(1 - homeWin - awayWin, 0);

  return {
    homeWin,
    draw,
    awayWin,
    homeRating,
    awayRating,
    homeRecentForm: homeForm,
    awayRecentForm: awayForm,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Best-effort parse of a Kalshi market title ("Will the Lakers beat the
 * Celtics?") to figure out which team a YES outcome refers to. Kalshi
 * doesn't give us a structured field for this, so we match phrasing against
 * both team names/short names. Returns null when it can't tell confidently -
 * callers should skip scoring that market rather than guess.
 */
export function resolveMarketFavoredSide(
  title: string,
  homeTeamName: string,
  homeTeamShort: string | null,
  awayTeamName: string,
  awayTeamShort: string | null
): "home" | "away" | null {
  const t = title.toLowerCase();
  const homeNames = [homeTeamName, homeTeamShort].filter(Boolean).map((s) => s!.toLowerCase());
  const awayNames = [awayTeamName, awayTeamShort].filter(Boolean).map((s) => s!.toLowerCase());

  const subjectMatch = t.match(/will\s+(?:the\s+)?([a-z0-9 .'-]+?)\s+(win|beat|defeat)/);
  if (subjectMatch) {
    const subject = subjectMatch[1].trim();
    if (homeNames.some((n) => subject.includes(n) || n.includes(subject))) return "home";
    if (awayNames.some((n) => subject.includes(n) || n.includes(subject))) return "away";
  }

  // Fallback: whichever team name appears first in the title text.
  const homeIdx = Math.min(...homeNames.map((n) => indexOfOrInfinity(t, n)));
  const awayIdx = Math.min(...awayNames.map((n) => indexOfOrInfinity(t, n)));
  if (Number.isFinite(homeIdx) && (!Number.isFinite(awayIdx) || homeIdx < awayIdx)) return "home";
  if (Number.isFinite(awayIdx) && (!Number.isFinite(homeIdx) || awayIdx < homeIdx)) return "away";

  return null;
}

function indexOfOrInfinity(haystack: string, needle: string): number {
  const idx = haystack.indexOf(needle);
  return idx === -1 ? Infinity : idx;
}

export type { League };
