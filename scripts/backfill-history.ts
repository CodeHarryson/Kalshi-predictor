/**
 * Backfills completed games and rebuilds Elo ratings.
 *
 *   npx tsx scripts/backfill-history.ts [LEAGUE ...] [--days=420]
 *
 * Defaults to NBA NFL CFB. Safe to repeat: games are upserted and ratings
 * are rebuilt from scratch from the games table each time.
 */
import { db } from "../src/lib/db";
import { backfillHistory } from "../src/lib/history-backfill";
import { rebuildRatingsForLeague } from "../src/lib/scoring/rating-engine";
import { nflProvider } from "../src/lib/providers/nfl";
import { cfbProvider } from "../src/lib/providers/cfb";
import { nbaEspnHistoryProvider } from "../src/lib/providers/nba-espn";
import type { League } from "../src/generated/prisma/enums";
import type { SportsProvider } from "../src/lib/providers/types";

const PROVIDERS: Partial<Record<League, SportsProvider>> = {
  NBA: nbaEspnHistoryProvider,
  NFL: nflProvider,
  CFB: cfbProvider,
};

async function main() {
  const args = process.argv.slice(2);
  const days = Number(args.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 420);
  const leagues = (args.filter((a) => !a.startsWith("--")) as League[]);
  const targets = leagues.length ? leagues : (["NBA", "NFL", "CFB"] as League[]);

  for (const league of targets) {
    const provider = PROVIDERS[league];
    if (!provider) {
      console.warn(`${league}: no history provider, skipping`);
      continue;
    }
    const t = Date.now();
    // NBA history comes from ESPN but live games from balldontlie: ids differ.
    const summary = await backfillHistory(league, provider, days, league === "NBA" ? "name" : "provider-id");
    const applied = await rebuildRatingsForLeague(league);
    const r = await db.teamRating.aggregate({
      where: { league },
      _min: { rating: true },
      _max: { rating: true },
      _avg: { rating: true },
    });
    console.log(
      `${league}: ${summary.gamesUpserted} games (${summary.gamesSkippedUnknownTeam} skipped, unknown team), ` +
        `${applied} rating updates, ratings ${r._min.rating?.toFixed(0)}..${r._max.rating?.toFixed(0)} ` +
        `(avg ${r._avg.rating?.toFixed(0)}) in ${((Date.now() - t) / 1000).toFixed(0)}s`
    );
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
