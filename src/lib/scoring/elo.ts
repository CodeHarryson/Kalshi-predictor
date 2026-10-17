import type { League } from "@/generated/prisma/enums";

export const DEFAULT_RATING = 1500;

/**
 * A league-wide gap this long between games is an offseason: no league plays
 * 90 days apart in season, and the shortest offseason (NBA) is ~4 months.
 */
export const OFFSEASON_GAP_MS = 90 * 24 * 60 * 60 * 1000;

/** Pulls a rating back toward the mean by `fraction` (0 = unchanged, 1 = reset). */
export function regressRating(rating: number, fraction: number): number {
  return DEFAULT_RATING + (rating - DEFAULT_RATING) * (1 - fraction);
}

interface LeagueEloConfig {
  k: number;
  homeAdvantage: number; // added to home team's rating before computing expectation
  hasDraws: boolean;
  baseDrawProbability: number; // used only when hasDraws is true
  /**
   * Scale updates by the winning margin (see marginMultiplier). Because the
   * multiplier averages well above 1, leagues that use it need a smaller k.
   */
  marginOfVictory?: { cap: number };
  /** Fraction of each rating pulled back to the mean after an offseason gap. */
  offseasonRegression?: number;
}

export const ELO_CONFIG: Record<League, LeagueEloConfig> = {
  // NBA/NFL/CFB were tuned by loading two seasons plus this year's games
  // (scripts/backfill-history.ts), replaying them in order, and minimizing log
  // loss on each pre-game prediction. The optima are shallow, so values are
  // rounded. NBA's offseasonRegression agrees with an independent check
  // against Kalshi's early-season prices (best ~0.55). Re-tune after more
  // seasons are backfilled; do not treat these as permanent.
  NBA: { k: 12, homeAdvantage: 40, hasDraws: false, baseDrawProbability: 0, marginOfVictory: { cap: 40 }, offseasonRegression: 0.5 },
  NFL: { k: 28, homeAdvantage: 35, hasDraws: false, baseDrawProbability: 0, marginOfVictory: { cap: 30 }, offseasonRegression: 0.5 },
  CFB: { k: 44, homeAdvantage: 90, hasDraws: false, baseDrawProbability: 0, marginOfVictory: { cap: 45 }, offseasonRegression: 0.35 },
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

/**
 * Margin-of-victory multiplier (the FiveThirtyEight form): grows with the
 * log of the margin so a blowout counts more than a one-score game, but is
 * damped when the winner was already the much stronger side, so favorites
 * can't farm rating by running up the score. The margin is capped.
 */
export function marginMultiplier(absMargin: number, winnerEloDiff: number, cap: number): number {
  const m = Math.min(absMargin, cap);
  return (Math.log(m + 1) * 2.2) / (winnerEloDiff * 0.001 + 2.2);
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
  actualHomeScore: number,
  /** Home score minus away score; only used by leagues with marginOfVictory. */
  margin?: number
): EloUpdateResult {
  const cfg = ELO_CONFIG[league];
  const expectedHome = eloExpectedScore(homeRating + cfg.homeAdvantage, awayRating);

  let multiplier = 1;
  if (cfg.marginOfVictory && margin !== undefined && margin !== 0) {
    const homeWon = margin > 0;
    const winnerEloDiff = homeWon
      ? homeRating + cfg.homeAdvantage - awayRating
      : awayRating - (homeRating + cfg.homeAdvantage);
    multiplier = marginMultiplier(Math.abs(margin), winnerEloDiff, cfg.marginOfVictory.cap);
  }

  const delta = cfg.k * multiplier * (actualHomeScore - expectedHome);

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
