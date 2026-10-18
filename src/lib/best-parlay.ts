import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";
import { buildParlaySuggestions, type CandidateLeg } from "./builder";

/**
 * How far to trust the model against the market when ranking. Comparing the
 * model with Kalshi's prices on upcoming games, the market's logit regressed
 * on the model's with a slope of 0.48-0.63 (NFL 0.56, CFB 0.48, NBA 0.63): the
 * model gets the direction right but is roughly twice as extreme as the
 * market. So each leg's probability is pulled halfway back toward its market
 * price before ranking. 0 = trust the market entirely, 1 = trust the model.
 */
export const MODEL_TRUST = 0.5;

/**
 * Leagues the best-parlay pick draws from. Only the ones whose ratings were
 * built from full seasons of history and tuned against results. Soccer's
 * ratings still rest on about three weeks of games, so its model-versus-market
 * gaps are mostly noise (e.g. rating Real Madrid at home as a coin flip), and
 * a "best parlay" built on them would mislead.
 */
export const BEST_PARLAY_LEAGUES: League[] = ["NBA", "NFL", "CFB"];

/** Legs considered per league, and across the whole slate, before building combos. */
const PER_LEAGUE_POOL = 25;
const SLATE_POOL = 24;
const COMBO_SIZES = [2, 3];

export interface ScoredLeg extends CandidateLeg {
  /** Model probability pulled toward the market by MODEL_TRUST. */
  shrunkProbability: number;
  shrunkEdge: number;
}

export interface BestParlay {
  legs: ScoredLeg[];
  /** Product of the raw model probabilities. */
  modelProbability: number;
  /** Product of the shrunk probabilities: what ranking is based on. */
  shrunkProbability: number;
  /** Product of the legs' market prices (an estimate of the combo's price). */
  marketImplied: number;
  /** shrunkProbability - marketImplied, in probability points. */
  edge: number;
  /** Expected profit per $1 staked at the market price, using the shrunk probability. */
  expectedReturn: number;
  /** Expected log-growth of a bankroll that stakes optimally on this bet (see growthRate). */
  growth: number;
}

export interface BestParlayResult {
  best: BestParlay | null;
  alternatives: BestParlay[];
  /** Games in the window that were scored (not started, with open markets). */
  gamesInWindow: number;
  /** Games that have started and are excluded: the model has no live information. */
  inProgress: number;
}

export function shrinkToMarket(modelProbability: number, marketProbability: number, trust = MODEL_TRUST): number {
  return marketProbability + trust * (modelProbability - marketProbability);
}

/**
 * Expected log-growth from staking the optimal (Kelly) fraction on a bet that
 * wins with probability p at market price m: the KL divergence of p from m.
 * It rewards both a bigger edge and a likelier win, so it prefers a solid
 * 2-leg combo over a long-shot 3-leg one with the same raw edge. Zero when
 * there is no edge (p <= m).
 */
export function growthRate(p: number, m: number): number {
  if (!(p > m) || m <= 0 || p >= 1 || m >= 1) return 0;
  return p * Math.log(p / m) + (1 - p) * Math.log((1 - p) / (1 - m));
}

export function scoreLegs(legs: ScoredLeg[]): BestParlay {
  const modelProbability = legs.reduce((a, l) => a * l.predictedProbability, 1);
  const shrunkProbability = legs.reduce((a, l) => a * l.shrunkProbability, 1);
  const marketImplied = legs.reduce((a, l) => a * l.marketImpliedProbability, 1);
  return {
    legs,
    modelProbability,
    shrunkProbability,
    marketImplied,
    edge: shrunkProbability - marketImplied,
    expectedReturn: marketImplied > 0 ? shrunkProbability / marketImplied - 1 : 0,
    growth: growthRate(shrunkProbability, marketImplied),
  };
}

function scoreLeg(leg: CandidateLeg): ScoredLeg {
  const shrunkProbability = shrinkToMarket(leg.predictedProbability, leg.marketImpliedProbability);
  return { ...leg, shrunkProbability, shrunkEdge: shrunkProbability - leg.marketImpliedProbability };
}

/** Every combo of `size` legs from `pool`, never two legs from the same game. */
export function enumerateDistinctGameCombos<T extends { gameId: string | null }>(pool: T[], size: number): T[][] {
  const out: T[][] = [];
  const stack: T[] = [];
  const walk = (start: number) => {
    if (stack.length === size) {
      out.push([...stack]);
      return;
    }
    for (let i = start; i < pool.length; i++) {
      const leg = pool[i];
      if (leg.gameId === null || stack.some((s) => s.gameId === leg.gameId)) continue;
      stack.push(leg);
      walk(i + 1);
      stack.pop();
    }
  };
  walk(0);
  return out;
}

/** Pure ranking step, split out so it can be tested without a database. */
export function rankBestParlays(candidates: CandidateLeg[], alternatives = 2): { best: BestParlay | null; alternatives: BestParlay[] } {
  const pool = candidates
    .map(scoreLeg)
    // Only legs that still have an edge after shrinking can help a parlay.
    .filter((l) => l.shrunkEdge > 0 && l.gameId !== null)
    .sort((a, b) => b.shrunkEdge - a.shrunkEdge)
    .slice(0, SLATE_POOL);

  const scored: BestParlay[] = [];
  for (const size of COMBO_SIZES) {
    for (const legs of enumerateDistinctGameCombos(pool, size)) {
      const parlay = scoreLegs(legs);
      if (parlay.growth > 0) scored.push(parlay);
    }
  }
  scored.sort((a, b) => b.growth - a.growth);
  return { best: scored[0] ?? null, alternatives: scored.slice(1, 1 + alternatives) };
}

/**
 * The best parlay to place for games between `from` and `to` (usually "the
 * rest of today"). Only games that haven't started are used. Kalshi keeps
 * markets open during a game and reprices them live, but the model only has
 * pre-game information, so it would "find" huge edges on whichever team is
 * losing. Those games are counted and reported instead.
 */
export async function buildBestParlayForWindow(
  window: { from: Date; to: Date },
  alternatives = 2,
  leagues: League[] = BEST_PARLAY_LEAGUES
): Promise<BestParlayResult> {
  const now = new Date();
  const from = window.from > now ? window.from : now;

  const [pools, gamesInWindow, inProgress] = await Promise.all([
    Promise.all(
      leagues.map((league) =>
        buildParlaySuggestions(league, { limit: PER_LEAGUE_POOL, from, to: window.to })
      )
    ),
    db.game.count({
      where: { league: { in: leagues }, status: "SCHEDULED", startTime: { gte: from, lt: window.to }, markets: { some: {} } },
    }),
    db.game.count({
      where: {
        league: { in: leagues },
        markets: { some: {} },
        startTime: { gte: new Date(now.getTime() - 12 * 60 * 60 * 1000), lt: now },
        status: { in: ["LIVE", "SCHEDULED"] },
      },
    }),
  ]);

  return { ...rankBestParlays(pools.flat(), alternatives), gamesInWindow, inProgress };
}

/**
 * Rewrites "Dallas Cowboys @ Green Bay Packers — Dallas Cowboys NOT to win" as
 * "Green Bay Packers to win": in a two-team game they are the same bet, and the
 * second form is how Kalshi's combo builder lists it ("yes Green Bay"). Returns
 * null when the description isn't a two-team "NOT to win" pick.
 */
export function placeAsPick(description: string): string | null {
  const m = /^(.+?) @ (.+?) — (.+?) NOT to win$/.exec(description);
  if (!m) return null;
  const [, away, home, excluded] = m;
  if (excluded === away) return `${home} to win`;
  if (excluded === home) return `${away} to win`;
  return null;
}
