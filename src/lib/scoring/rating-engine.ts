import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";
import { DEFAULT_RATING, ELO_CONFIG, OFFSEASON_GAP_MS, resultToHomeScore, updateElo } from "./elo";

type TxClient = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/** rating <- mean + (rating - mean) * (1 - fraction), for every team in the league. */
async function regressRatingsToMean(league: League, fraction: number): Promise<void> {
  await db.$transaction([
    db.teamRating.updateMany({ where: { league }, data: { rating: { multiply: 1 - fraction } } }),
    db.teamRating.updateMany({ where: { league }, data: { rating: { increment: DEFAULT_RATING * fraction } } }),
  ]);
}

/**
 * Throws away a league's ratings and replays every completed game in order.
 * Needed after backfilling older games: incremental recompute only moves
 * forward from the current ratings, so games inserted behind them would be
 * applied out of order. Ratings are derived data, so this is safe to repeat.
 */
export async function rebuildRatingsForLeague(league: League): Promise<number> {
  await db.$transaction([
    db.teamRating.deleteMany({ where: { league } }),
    db.game.updateMany({ where: { league, status: "FINAL" }, data: { ratingApplied: false } }),
  ]);
  return recomputeRatingsForLeague(league);
}

/**
 * Walks completed games for a league in chronological order and applies
 * Elo updates for any game that hasn't been applied yet (Game.ratingApplied).
 * Safe to call repeatedly after every sync - already-applied games are
 * skipped so ratings never get double counted.
 */
export async function recomputeRatingsForLeague(league: League): Promise<number> {
  const games = await db.game.findMany({
    where: { league, status: "FINAL", ratingApplied: false, homeScore: { not: null }, awayScore: { not: null } },
    orderBy: { startTime: "asc" },
  });

  // The previous game already folded into the ratings, so an offseason gap
  // is detected even when the first new game of a run follows a long break.
  let prevStart =
    (
      await db.game.findFirst({
        where: { league, ratingApplied: true },
        orderBy: { startTime: "desc" },
        select: { startTime: true },
      })
    )?.startTime ?? null;
  const regression = ELO_CONFIG[league].offseasonRegression ?? 0;

  let applied = 0;
  for (const game of games) {
    if (game.homeScore == null || game.awayScore == null) continue;

    if (regression > 0 && prevStart && game.startTime.getTime() - prevStart.getTime() > OFFSEASON_GAP_MS) {
      await regressRatingsToMean(league, regression);
    }
    prevStart = game.startTime;

    const actualHomeScore = resultToHomeScore(game.homeScore, game.awayScore);
    const margin = game.homeScore - game.awayScore;

    await db.$transaction(async (tx) => {
      // Re-read inside the transaction. SQLite serializes writes by default,
      // so the begin-immediate transaction prevents two concurrent
      // recomputeRatingsForLeague calls from both reading the same rating
      // and overwriting each other's delta.
      const [homeRating, awayRating] = await Promise.all([
        getOrCreateRatingInTx(tx, game.homeTeamId, league),
        getOrCreateRatingInTx(tx, game.awayTeamId, league),
      ]);

      const updated = updateElo(league, homeRating.rating, awayRating.rating, actualHomeScore, margin);

      await Promise.all([
        tx.teamRating.update({
          where: { id: homeRating.id },
          data: { rating: updated.homeRating },
        }),
        tx.teamRating.update({
          where: { id: awayRating.id },
          data: { rating: updated.awayRating },
        }),
        tx.game.update({ where: { id: game.id }, data: { ratingApplied: true } }),
      ]);
    });

    applied += 1;
  }

  return applied;
}

async function getOrCreateRatingInTx(
  tx: TxClient,
  teamId: string,
  league: League
) {
  return tx.teamRating.upsert({
    where: { teamId },
    create: { teamId, league, rating: DEFAULT_RATING },
    update: {}, // no-op: row exists, we just want the current value
  });
}
