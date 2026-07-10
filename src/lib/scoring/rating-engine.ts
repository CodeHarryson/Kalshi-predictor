import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";
import { DEFAULT_RATING, resultToHomeScore, updateElo } from "./elo";

type TxClient = Parameters<Parameters<typeof db.$transaction>[0]>[0];

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

  let applied = 0;
  for (const game of games) {
    if (game.homeScore == null || game.awayScore == null) continue;

    const actualHomeScore = resultToHomeScore(game.homeScore, game.awayScore);

    await db.$transaction(async (tx) => {
      // Re-read inside the transaction. SQLite serializes writes by default,
      // so the begin-immediate transaction prevents two concurrent
      // recomputeRatingsForLeague calls from both reading the same rating
      // and overwriting each other's delta.
      const [homeRating, awayRating] = await Promise.all([
        getOrCreateRatingInTx(tx, game.homeTeamId, league),
        getOrCreateRatingInTx(tx, game.awayTeamId, league),
      ]);

      const updated = updateElo(league, homeRating.rating, awayRating.rating, actualHomeScore);

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
