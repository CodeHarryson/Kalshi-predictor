import { db } from "@/lib/db";
import type { GameStatus, League } from "@/generated/prisma/enums";
import { nbaProvider } from "./providers/nba";
import { nflProvider } from "./providers/nfl";
import { soccerProvider } from "./providers/soccer";
import type { SportsProvider } from "./providers/types";
import { fetchOpenMarkets, isKalshiConfigured } from "./providers/kalshi";
import { matchMarketToGame } from "./providers/match";
import { recomputeRatingsForLeague } from "./scoring/rating-engine";

export const ALL_LEAGUES: League[] = ["NBA", "NFL", "EPL", "LALIGA", "WORLD_CUP"];

const PROVIDER_BY_LEAGUE: Record<League, SportsProvider> = {
  NBA: nbaProvider,
  NFL: nflProvider,
  EPL: soccerProvider,
  LALIGA: soccerProvider,
  WORLD_CUP: soccerProvider,
};

export interface SportsSyncSummary {
  league: League;
  teamsUpserted: number;
  gamesUpserted: number;
  ratingsApplied: number;
}

export async function syncLeagueSportsData(
  league: League,
  opts?: { daysBack?: number; daysForward?: number }
): Promise<SportsSyncSummary> {
  const provider = PROVIDER_BY_LEAGUE[league];
  const now = new Date();
  const startDate = new Date(now.getTime() - (opts?.daysBack ?? 21) * 86400_000);
  const endDate = new Date(now.getTime() + (opts?.daysForward ?? 14) * 86400_000);

  const providerTeams = await provider.fetchTeams(league);
  const teamIdByExternal = new Map<string, string>();

  for (const pt of providerTeams) {
    const existing = await db.team.findFirst({
      where: { league, OR: [{ externalId: pt.externalId }, { name: pt.name }] },
    });

    const teamId = existing
      ? (
          await db.team.update({
            where: { id: existing.id },
            data: {
              externalId: pt.externalId,
              shortName: pt.shortName ?? existing.shortName,
              name: pt.name,
            },
          })
        ).id
      : (
          await db.team.create({
            data: { league, name: pt.name, shortName: pt.shortName, externalId: pt.externalId },
          })
        ).id;

    teamIdByExternal.set(pt.externalId, teamId);
  }

  const providerGames = await provider.fetchGames(league, { startDate, endDate });
  let gamesUpserted = 0;

  for (const pg of providerGames) {
    const homeTeamId = teamIdByExternal.get(pg.homeTeamExternalId);
    const awayTeamId = teamIdByExternal.get(pg.awayTeamExternalId);
    if (!homeTeamId || !awayTeamId) continue;

    await db.game.upsert({
      where: { league_externalId: { league, externalId: pg.externalId } },
      create: {
        league,
        externalId: pg.externalId,
        startTime: pg.startTime,
        status: pg.status as GameStatus,
        homeTeamId,
        awayTeamId,
        homeScore: pg.homeScore ?? null,
        awayScore: pg.awayScore ?? null,
      },
      update: {
        startTime: pg.startTime,
        status: pg.status as GameStatus,
        homeScore: pg.homeScore ?? null,
        awayScore: pg.awayScore ?? null,
      },
    });
    gamesUpserted += 1;
  }

  const ratingsApplied = await recomputeRatingsForLeague(league);

  return { league, teamsUpserted: teamIdByExternal.size, gamesUpserted, ratingsApplied };
}

export interface KalshiSyncSummary {
  league: League;
  marketsUpserted: number;
  configured: boolean;
}

export async function syncKalshiMarketsForLeague(league: League): Promise<KalshiSyncSummary> {
  const start = Date.now();
  if (!isKalshiConfigured()) {
    console.warn(`[sync.kalshi] ${league}: skipped (KALSHI_KEY_ID / KALSHI_PRIVATE_KEY not set)`);
    return { league, marketsUpserted: 0, configured: false };
  }

  const markets = await fetchOpenMarkets(league);
  console.info(`[sync.kalshi] ${league}: fetched ${markets.length} market(s) from Kalshi in ${Date.now() - start}ms`);
  const now = new Date();
  const candidateGames = await db.game.findMany({
    where: {
      league,
      startTime: {
        gte: new Date(now.getTime() - 86_400_000),
        lte: new Date(now.getTime() + 14 * 86_400_000),
      },
    },
    include: { homeTeam: true, awayTeam: true },
  });

  let marketsUpserted = 0;
  for (const m of markets) {
    const closeTime = m.close_time ? new Date(m.close_time) : null;
    const matchedGame = matchMarketToGame(m.title, closeTime, candidateGames);
    const yesPrice = m.yes_ask ?? m.last_price ?? null;
    const noPrice = m.no_ask ?? (yesPrice != null ? 100 - yesPrice : null);

    await db.kalshiMarket.upsert({
      where: { ticker: m.ticker },
      create: {
        ticker: m.ticker,
        title: m.title,
        yesSubTitle: m.yes_sub_title,
        category: m.category,
        league,
        gameId: matchedGame?.id,
        yesPrice: yesPrice ?? undefined,
        noPrice: noPrice ?? undefined,
        closeTime: closeTime ?? undefined,
        status: m.status,
        raw: JSON.stringify(m),
      },
      update: {
        title: m.title,
        yesSubTitle: m.yes_sub_title,
        gameId: matchedGame?.id,
        yesPrice: yesPrice ?? undefined,
        noPrice: noPrice ?? undefined,
        closeTime: closeTime ?? undefined,
        status: m.status,
        raw: JSON.stringify(m),
      },
    });
    marketsUpserted += 1;
  }

  if (marketsUpserted === 0) {
    // Loud signal: action returns ok:true with 0 markets, which the UI
    // surfaces as "Sync complete" — easy to mistake for success. If we
    // were configured but got nothing, almost certainly an auth or
    // signature failure upstream.
    console.warn(`[sync.kalshi] ${league}: configured=true but 0 markets upserted — check dev-server logs for HTTP 401/403/429`);
  } else {
    console.info(`[sync.kalshi] ${league}: upserted ${marketsUpserted} market(s) in ${Date.now() - start}ms`);
  }

  return { league, marketsUpserted, configured: true };
}

export interface FullSyncSummary {
  sports: SportsSyncSummary[];
  markets: KalshiSyncSummary[];
}

export async function syncAll(leagues: League[] = ALL_LEAGUES): Promise<FullSyncSummary> {
  const sports: SportsSyncSummary[] = [];
  for (const league of leagues) {
    sports.push(await syncLeagueSportsData(league));
  }

  const markets: KalshiSyncSummary[] = [];
  for (const league of leagues) {
    markets.push(await syncKalshiMarketsForLeague(league));
  }

  return { sports, markets };
}
