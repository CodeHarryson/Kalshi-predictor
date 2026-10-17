import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";
import {
  DEFAULT_RATING,
  ELO_CONFIG,
  matchOutcomeProbabilities,
  OFFSEASON_GAP_MS,
  regressRating,
  type MatchOutcomeProbabilities,
} from "./elo";
import { INJURY_SCALE, teamInjuryPenaltyElo } from "./injuries";
import { applyLogitShift, getMatchupContext } from "./matchup";

const RECENT_FORM_WINDOW = 5;
const FORM_WEIGHT = 0.1; // max +/-5% nudge from recent-form delta

export interface GameProbabilityEstimate extends MatchOutcomeProbabilities {
  homeRating: number;
  awayRating: number;
  homeRecentForm: number; // win rate over last N games, 0-1
  awayRecentForm: number;
  /** Elo points each side loses to injuries (already applied to homeWin/awayWin). */
  homeInjuryElo: number;
  awayInjuryElo: number;
  /** Normalized average scoring margin over recent games (see matchup.ts). */
  homeRecentMargin: number;
  awayRecentMargin: number;
  /** Normalized average margin of past meetings from the home side's view, and how many. */
  h2hMargin: number;
  h2hGames: number;
}

async function getInjuryPenalty(teamId: string, league: League): Promise<number> {
  const rows = await db.injuryReport.findMany({
    where: { teamId },
    select: { availabilityLoss: true, impactElo: true },
  });
  return (INJURY_SCALE[league] ?? 1) * teamInjuryPenaltyElo(rows);
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

  const [storedHome, storedAway, rawHomeForm, rawAwayForm, homeInjuryElo, awayInjuryElo, lastFinal] =
    await Promise.all([
      getRating(game.homeTeamId),
      getRating(game.awayTeamId),
      recentFormWinRate(game.homeTeamId, game.startTime),
      recentFormWinRate(game.awayTeamId, game.startTime),
      getInjuryPenalty(game.homeTeamId, game.league),
      getInjuryPenalty(game.awayTeamId, game.league),
      db.game.findFirst({
        where: { league: game.league, status: "FINAL", startTime: { lt: game.startTime } },
        orderBy: { startTime: "desc" },
        select: { startTime: true },
      }),
    ]);

  // Stored ratings only move when a game is processed, so before the first
  // game of a new season they still carry last season's full spread. Apply
  // the offseason pull toward the mean here, and ignore form from games a
  // whole offseason ago. Once a new-season game is processed, the stored
  // rating has been regressed itself and this stops applying.
  const regression = ELO_CONFIG[game.league].offseasonRegression ?? 0;
  const afterOffseason =
    regression > 0 &&
    lastFinal != null &&
    game.startTime.getTime() - lastFinal.startTime.getTime() > OFFSEASON_GAP_MS;
  const homeRating = afterOffseason ? regressRating(storedHome, regression) : storedHome;
  const awayRating = afterOffseason ? regressRating(storedAway, regression) : storedAway;
  const homeForm = afterOffseason ? 0.5 : rawHomeForm;
  const awayForm = afterOffseason ? 0.5 : rawAwayForm;

  // Injuries only matter for games that haven't happened: the report is a
  // snapshot of right now, so applying it to a finished game would be wrong.
  const applyInjuries = game.status === "SCHEDULED" || game.status === "LIVE";
  const homePenalty = applyInjuries ? homeInjuryElo : 0;
  const awayPenalty = applyInjuries ? awayInjuryElo : 0;

  const base = matchOutcomeProbabilities(game.league, homeRating - homePenalty, awayRating - awayPenalty);

  const formDelta = homeForm - awayForm; // -1..1
  const adjustment = clamp(formDelta * FORM_WEIGHT, -0.05, 0.05);

  let homeWin = base.homeWin + adjustment;
  let awayWin = base.awayWin - adjustment;
  homeWin = clamp(homeWin, 0.01, 0.98);
  awayWin = clamp(awayWin, 0.01, 0.98);
  const draw = Math.max(1 - homeWin - awayWin, 0);

  // Margin-based form / head-to-head: only for two-outcome leagues, where a
  // logit shift on the home side's share is well defined.
  const matchup = await getMatchupContext(game, afterOffseason);
  if (matchup.logitShift !== 0 && draw === 0) {
    const total = homeWin + awayWin;
    const shifted = applyLogitShift(homeWin / total, matchup.logitShift);
    homeWin = clamp(shifted * total, 0.01, 0.98);
    awayWin = clamp((1 - shifted) * total, 0.01, 0.98);
  }

  return {
    homeWin,
    draw,
    awayWin,
    homeRating,
    awayRating,
    homeRecentForm: homeForm,
    awayRecentForm: awayForm,
    homeInjuryElo: homePenalty,
    awayInjuryElo: awayPenalty,
    homeRecentMargin: matchup.homeRecentMargin,
    awayRecentMargin: matchup.awayRecentMargin,
    h2hMargin: matchup.h2hMargin,
    h2hGames: matchup.h2hGames,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Best-effort parse of Kalshi market text to figure out which outcome a YES
 * contract refers to: a specific team, or a draw. Callers should pass
 * `yesSubTitle` when available (e.g. "Reg Time: Argentina", "Reg Time: Tie") -
 * it's the only reliable signal on 3-way markets, since `title` alone is
 * identical across all of a game's outcome tickers ("Argentina vs
 * Switzerland Winner?" is the title for the Argentina-win, Switzerland-win,
 * AND Tie contracts). Falls back to matching the title's phrasing for older
 * 2-way markets without a sub-title. Returns null when it can't tell
 * confidently - callers should skip scoring that market rather than guess.
 */
export function resolveMarketFavoredSide(
  text: string,
  homeTeamName: string,
  homeTeamShort: string | null,
  awayTeamName: string,
  awayTeamShort: string | null
): "home" | "away" | "draw" | null {
  const t = text.toLowerCase();
  if (/\btie\b|\bdraw\b/.test(t)) return "draw";

  // Short, exact sub-titles ("New York J", "Washington St.", "Reg Time: Argentina")
  // are resolved by token prefix first: it distinguishes the Jets from the
  // Giants and Washington from Washington State, which substring checks can't.
  const byTokens = sideFromSubTitle(text, homeTeamName, awayTeamName);
  if (byTokens) return byTokens;

  // Abbreviations under 3 characters ("ne", "la") are substrings of ordinary
  // words ("new", "los angeles"), so they are never used for matching.
  const usable = (s: string | null) => (s && s.length >= 3 ? s.toLowerCase() : null);
  const homeNames = [usable(homeTeamName), usable(homeTeamShort)].filter((s): s is string => !!s);
  const awayNames = [usable(awayTeamName), usable(awayTeamShort)].filter((s): s is string => !!s);

  const subjectMatch = t.match(/will\s+(?:the\s+)?([a-z0-9 .'-]+?)\s+(win|beat|defeat)/);
  if (subjectMatch) {
    const subject = subjectMatch[1].trim();
    if (homeNames.some((n) => subject.includes(n) || n.includes(subject))) return "home";
    if (awayNames.some((n) => subject.includes(n) || n.includes(subject))) return "away";
  }

  // Fallback: whichever team name appears first in the text.
  const homeIdx = Math.min(...homeNames.map((n) => indexOfOrInfinity(t, n)));
  const awayIdx = Math.min(...awayNames.map((n) => indexOfOrInfinity(t, n)));
  if (Number.isFinite(homeIdx) && (!Number.isFinite(awayIdx) || homeIdx < awayIdx)) return "home";
  if (Number.isFinite(awayIdx) && (!Number.isFinite(homeIdx) || awayIdx < homeIdx)) return "away";

  return null;
}

// Whole-word search, so "kc" doesn't match inside another word.
function indexOfOrInfinity(haystack: string, needle: string): number {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).exec(haystack);
  return m ? m.index + m[1].length : Infinity;
}

function tokens(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Number of team-name tokens left over when `sub` matches as a run of token
 * prefixes ("st" matches "state", "j" matches "jets"), or null if it doesn't.
 * Fewer leftovers = a tighter match, which separates "Michigan" (Michigan
 * Wolverines, 1 left) from "Michigan State Spartans" (2 left).
 */
function prefixMatchLeftover(sub: string[], team: string[]): number | null {
  for (let i = 0; i + sub.length <= team.length; i++) {
    if (sub.every((tok, j) => team[i + j].startsWith(tok))) return team.length - sub.length;
  }
  return null;
}

function sideFromSubTitle(text: string, homeName: string, awayName: string): "home" | "away" | null {
  // "Reg Time: Argentina" -> "Argentina"
  const sub = tokens(text.split(":").pop() ?? text);
  if (sub.length === 0 || sub.length > 5) return null;
  const home = prefixMatchLeftover(sub, tokens(homeName));
  const away = prefixMatchLeftover(sub, tokens(awayName));
  if (home !== null && away === null) return "home";
  if (away !== null && home === null) return "away";
  if (home !== null && away !== null && home !== away) return home < away ? "home" : "away";
  return null;
}

export type { League };
