/**
 * Per-event rate estimation for prop bets (player goals, team corners).
 *
 * The naive estimator "goals / games_observed" is wildly overconfident
 * when the sample size is small. A player who's scored 1 goal in 1 game
 * gets a 1.0 goal-per-game estimate, which makes Poisson(1.0) predict
 * P(0+ goals) ≈ 0.63 — far too high relative to the player's true
 * talent. With two more games of zeros, the estimate drops to 0.33 —
 * equally too low. The estimate oscillates with every new observation
 * because there's no notion of "the league typical rate this player's
 * talent is being drawn from."
 *
 * The fix is empirical-Bayes shrinkage toward a league prior. The
 * shrunk estimate is
 *
 *     shrunken_rate = (n * observed + alpha * prior) / (n + alpha)
 *
 * where n is games observed, observed is the empirical rate, and alpha
 * is the "pseudo-count" of league-typical games (e.g. alpha=5 means we
 * treat the prior as if it were informed by 5 league-typical games).
 * Early in the player's history the prior dominates; as n grows the
 * prior's weight fades and the empirical rate takes over.
 *
 * Priors below are rough v1 estimates from recent World Cup data and
 * are deliberately simple — a hierarchical model that pools per-position
 * priors is tracked as deferred in the plan.
 */

import { poissonProbAtLeast } from "./poisson";

/** League-typical rate for a player's goals-per-game, weighted across positions. */
export const LEAGUE_PRIOR_PLAYER_GOALS_PER_GAME = 0.18;

/** League-typical rate for a team's corners-per-game. */
export const LEAGUE_PRIOR_TEAM_CORNERS_PER_GAME = 5.2;

/** Pseudo-count of league-typical games used to shrink empirical rates. */
const PLAYER_GOALS_SHRINKAGE_ALPHA = 5;
const TEAM_CORNERS_SHRINKAGE_ALPHA = 3;

export interface EmpiricalRateInput {
  /** Total events observed (e.g. total goals across all observed games). */
  totalEvents: number;
  /** Number of games the events were observed across. */
  gamesObserved: number;
  /** League-typical rate per game. Different for goals vs corners. */
  priorPerGame: number;
  /** Pseudo-count of league-typical games for the prior. */
  alpha: number;
}

/**
 * Returns the empirical-Bayes shrunk rate per game. With n=0, returns
 * exactly the prior. With n → ∞, returns the observed rate. With small
 * n, the result is a weighted blend dominated by the prior.
 */
export function shrinkRate(input: EmpiricalRateInput): number {
  const { totalEvents, gamesObserved, priorPerGame, alpha } = input;
  if (gamesObserved < 0 || totalEvents < 0 || !Number.isInteger(gamesObserved)) {
    throw new Error(
      `shrinkRate: gamesObserved must be a non-negative integer and totalEvents >= 0 (got games=${gamesObserved}, events=${totalEvents})`
    );
  }
  if (alpha < 0 || priorPerGame < 0) {
    throw new Error(`shrinkRate: alpha and priorPerGame must be >= 0`);
  }
  if (gamesObserved === 0 && alpha === 0) {
    // No information at all. Return 0 rather than NaN; callers can decide
    // whether to fall back to the prior manually.
    return 0;
  }
  const observed = gamesObserved > 0 ? totalEvents / gamesObserved : 0;
  return (gamesObserved * observed + alpha * priorPerGame) / (gamesObserved + alpha);
}

/**
 * Convenience wrapper for a player-goal prop. The builder's prop branch
 * (builder.ts) calls this with the player's PlayerGameStat history
 * (sum of `goals` over recent games) and the threshold ("0.5+", "1.5+", …)
 * parsed from Kalshi's prop market.
 */
export function playerGoalProbAtLeast(params: {
  totalGoalsObserved: number;
  gamesObserved: number;
  threshold: number; // e.g. 0.5, 1.5; rounded up to the next integer (>=1)
}): number {
  const { totalGoalsObserved, gamesObserved, threshold } = params;
  const rate = shrinkRate({
    totalEvents: totalGoalsObserved,
    gamesObserved,
    priorPerGame: LEAGUE_PRIOR_PLAYER_GOALS_PER_GAME,
    alpha: PLAYER_GOALS_SHRINKAGE_ALPHA,
  });
  // Thresholds like "0.5+" mean "at least one event" → integer k=1.
  // "1.5+" means "at least two" → k=2. Floor: 0.5 -> 1, 1.5 -> 2, etc.
  const k = Math.max(1, Math.floor(threshold + 0.5));
  return poissonProbAtLeast(rate, k);
}

export function teamCornerProbAtLeast(params: {
  totalCornersObserved: number;
  gamesObserved: number;
  threshold: number; // e.g. 3.5, 5.5, 9.5
}): number {
  const { totalCornersObserved, gamesObserved, threshold } = params;
  const rate = shrinkRate({
    totalEvents: totalCornersObserved,
    gamesObserved,
    priorPerGame: LEAGUE_PRIOR_TEAM_CORNERS_PER_GAME,
    alpha: TEAM_CORNERS_SHRINKAGE_ALPHA,
  });
  const k = Math.max(1, Math.floor(threshold + 0.5));
  return poissonProbAtLeast(rate, k);
}
