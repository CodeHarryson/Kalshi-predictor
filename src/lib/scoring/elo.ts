import type { League } from "@/generated/prisma/enums";

export const DEFAULT_RATING = 1500;

interface LeagueEloConfig {
  k: number;
  homeAdvantage: number; // added to home team's rating before computing expectation
  hasDraws: boolean;
  baseDrawProbability: number; // used only when hasDraws is true
}

export const ELO_CONFIG: Record<League, LeagueEloConfig> = {
  NBA: { k: 20, homeAdvantage: 100, hasDraws: false, baseDrawProbability: 0 },
  NFL: { k: 25, homeAdvantage: 55, hasDraws: false, baseDrawProbability: 0 },
  // College home-field edge is larger than the NFL's; starting estimate, not fitted.
  CFB: { k: 25, homeAdvantage: 70, hasDraws: false, baseDrawProbability: 0 },
  EPL: { k: 22, homeAdvantage: 60, hasDraws: true, baseDrawProbability: 0.26 },
  LALIGA: { k: 22, homeAdvantage: 60, hasDraws: true, baseDrawProbability: 0.26 },
  WORLD_CUP: { k: 22, homeAdvantage: 40, hasDraws: true, baseDrawProbability: 0.24 },
};

/** Standard logistic Elo expectation: P(A) if A and B played with no draws. */
export function eloExpectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

export interface MatchOutcomeProbabilities {
  homeWin: number;
  draw: number;
  awayWin: number;
}

/**
 * Converts a home/away Elo gap into win/draw/loss probabilities.
 *
 * For two-outcome leagues (NBA/NFL) this is just the logistic Elo formula.
 * For draw-eligible leagues (soccer) the "expected score" from the logistic
 * formula represents winProb + 0.5*drawProb; draw probability is modeled as
 * a Gaussian that peaks at baseDrawProbability when teams are evenly matched
 * and decays as the rating gap grows, since heavy favorites draw less often.
 * This is an explainable approximation, not a fitted model - it's meant to
 * be a reasonable v1, replaced over time by the logged-outcome retrain once
 * there's enough settled history (see retrain.ts).
 */
export function matchOutcomeProbabilities(
  league: League,
  homeRating: number,
  awayRating: number
): MatchOutcomeProbabilities {
  const cfg = ELO_CONFIG[league];
  const expected = eloExpectedScore(homeRating + cfg.homeAdvantage, awayRating);

  if (!cfg.hasDraws) {
    return { homeWin: expected, draw: 0, awayWin: 1 - expected };
  }

  const gap = homeRating + cfg.homeAdvantage - awayRating;
  const draw = cfg.baseDrawProbability * Math.exp(-Math.pow(gap / 400, 2));
  let homeWin = expected - draw / 2;
  let awayWin = 1 - expected - draw / 2;

  // Guard against pathological inputs pushing a probability negative.
  homeWin = Math.max(homeWin, 0.01);
  awayWin = Math.max(awayWin, 0.01);
  const drawClamped = Math.max(1 - homeWin - awayWin, 0);

  return { homeWin, draw: drawClamped, awayWin };
}

export interface EloUpdateResult {
  homeRating: number;
  awayRating: number;
}

/**
 * Updates both teams' ratings after a completed game.
 * actualHomeScore: 1 = home win, 0.5 = draw, 0 = away win.
 */
export function updateElo(
  league: League,
  homeRating: number,
  awayRating: number,
  actualHomeScore: number
): EloUpdateResult {
  const cfg = ELO_CONFIG[league];
  const expectedHome = eloExpectedScore(homeRating + cfg.homeAdvantage, awayRating);
  const delta = cfg.k * (actualHomeScore - expectedHome);

  return {
    homeRating: homeRating + delta,
    awayRating: awayRating - delta,
  };
}

export function resultToHomeScore(homeScore: number, awayScore: number): number {
  if (homeScore > awayScore) return 1;
  if (homeScore < awayScore) return 0;
  return 0.5;
}
