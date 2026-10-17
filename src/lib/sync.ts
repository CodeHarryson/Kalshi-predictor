import { db } from "@/lib/db";
import type { GameStatus, League } from "@/generated/prisma/enums";
import type { Game as GameRow, Team as TeamRow } from "@/generated/prisma/client";
import { nbaProvider } from "./providers/nba";
import { nflProvider } from "./providers/nfl";
import { cfbProvider } from "./providers/cfb";
import { soccerProvider } from "./providers/soccer";
import type { SportsProvider } from "./providers/types";
import { fetchOpenMarkets, fetchOpenPropMarkets, isKalshiConfigured } from "./providers/kalshi";
import { matchMarketByTicker, matchMarketToGame } from "./providers/match";
import { parsePropTicker } from "./providers/kalshi-props";
import { haystackContainsCandidate } from "./providers/text-match";
import { matchFixtureToGame } from "./providers/fixture-match";
import { fetchEspnGameStats } from "./providers/espn-soccer-stats";
import { recomputeRatingsForLeague } from "./scoring/rating-engine";

export const ALL_LEAGUES: League[] = ["NBA", "NFL", "CFB", "EPL", "LALIGA", "WORLD_CUP"];

const PROVIDER_BY_LEAGUE: Record<League, SportsProvider> = {
  NBA: nbaProvider,
  NFL: nflProvider,
  CFB: cfbProvider,
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
    const matchedGame =
      matchMarketToGame(m.title, closeTime, candidateGames) ??
      matchMarketByTicker(m.ticker, candidateGames, league);
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

const DAY_MS = 24 * 60 * 60 * 1000;
// Same asymmetric tolerance as match.ts's matchMarketToGame fix: Kalshi's
// per-game prop markets don't close at kickoff - close_time can be ~2 weeks
// after the game starts (settlement grace period), confirmed live for
// KXWCTCORNERS the same way it was for KXWCGAME. A symmetric ±1-day window
// excludes every real match here, same bug, same fix.
const PROP_CLOSE_BEFORE_START_TOLERANCE_MS = 1 * DAY_MS;
const PROP_CLOSE_AFTER_START_TOLERANCE_MS = 21 * DAY_MS;

/**
 * Links a single-team prop market (e.g. "Switzerland: 8+ corners") to a
 * game. Deliberately separate from `matchMarketToGame`, which requires BOTH
 * team names to appear in the market text - team-corners markets only
 * mention one team, so that matcher would always return null for them.
 * Matches on team identity (home or away) plus the same close-time
 * tolerance as the winner-market matcher.
 */
function matchPropMarketToGame(
  teamId: string,
  closeTime: Date | null,
  candidateGames: (GameRow & { homeTeam: TeamRow; awayTeam: TeamRow })[]
): GameRow | null {
  const teamGames = candidateGames.filter(
    (g) => g.homeTeamId === teamId || g.awayTeamId === teamId
  );
  const inWindow = closeTime
    ? teamGames.filter((g) => {
        const delta = closeTime.getTime() - g.startTime.getTime();
        return (
          delta >= -PROP_CLOSE_BEFORE_START_TOLERANCE_MS &&
          delta <= PROP_CLOSE_AFTER_START_TOLERANCE_MS
        );
      })
    : teamGames;
  return inWindow.length === 1 ? inWindow[0] : null;
}

/**
 * Kalshi's per-game tickers all share a middle "event key" segment encoding
 * date+teams, e.g. "KXWCTCORNERS-26JUL11ARGSUI-SUI8" and
 * "KXWCGAME-26JUL11ARGSUI-ARG" both embed "26JUL11ARGSUI" - confirmed live
 * against both series. The KXWCGAME sync (syncKalshiMarketsForLeague, which
 * runs before this in both syncAll and syncKalshiAction) already links that
 * event's markets to the correct game via title-based matching. Reusing
 * that sibling's gameId is far more reliable than re-deriving the link from
 * team+date proximity: a team playing several games within the 21-day
 * close-time tolerance (routine once a tournament reaches the knockout
 * stage) makes date-only matching genuinely ambiguous, but the ticker's
 * event key isn't.
 */
function extractEventKey(ticker: string): string | null {
  const parts = ticker.split("-");
  return parts.length >= 3 ? parts[1] : null;
}

async function resolveGameIdByEventKey(eventKey: string, league: League): Promise<string | null> {
  const sibling = await db.kalshiMarket.findFirst({
    where: { league, gameId: { not: null }, ticker: { contains: `-${eventKey}-` } },
    select: { gameId: true },
  });
  return sibling?.gameId ?? null;
}

export interface PropMarketSyncSummary {
  league: League;
  propMarketsUpserted: number;
}

/**
 * Syncs prop markets (team corners + player goals) and resolves each one's
 * subject. `propSubjectExternalId` always stores OUR OWN internal id (Team
 * or Player), not a provider id - subjects are resolved by name against
 * our own DB at sync time, so prop-scorer.ts / the settle route can treat
 * that column as a direct primary-key read.
 *
 * TEAM_CORNERS is per-game: resolves a Team and links to a specific game.
 * PLAYER_GOALS is tournament-scoped (see kalshi-props.ts's PROP_SERIES
 * comment): resolves/creates a Player row (by name; `teamId` starts null
 * and gets filled in once syncPropStatsForLeague sees them play) and
 * deliberately leaves `gameId` null - there's no single game to peg it to.
 */
export async function syncPropMarketsForLeague(league: League): Promise<PropMarketSyncSummary> {
  if (!isKalshiConfigured()) return { league, propMarketsUpserted: 0 };

  const propMarkets = await fetchOpenPropMarkets(league);
  if (propMarkets.length === 0) return { league, propMarketsUpserted: 0 };

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
  const teams = await db.team.findMany({ where: { league } });

  function resolveTeam(name: string) {
    return teams.find(
      (t) =>
        haystackContainsCandidate(name, t.name) ||
        (t.shortName ? haystackContainsCandidate(name, t.shortName) : false)
    );
  }

  let propMarketsUpserted = 0;
  for (const { seriesTicker, market: m } of propMarkets) {
    const parsed = parsePropTicker(seriesTicker, m.ticker, m.title, m.yes_sub_title ?? null);
    if (!parsed) continue;

    let subjectId: string;
    let subjectName: string;
    let gameId: string | null = null;

    if (parsed.propKind === "TEAM_CORNERS") {
      const subjectTeam = resolveTeam(parsed.propSubjectName);
      if (!subjectTeam) {
        console.warn(
          `[sync.props] ${league}: could not resolve team "${parsed.propSubjectName}" for ${m.ticker} - skipping`
        );
        continue;
      }
      const closeTime = m.close_time ? new Date(m.close_time) : null;
      const eventKey = extractEventKey(m.ticker);
      gameId =
        (eventKey ? await resolveGameIdByEventKey(eventKey, league) : null) ??
        matchPropMarketToGame(subjectTeam.id, closeTime, candidateGames)?.id ??
        null;
      subjectId = subjectTeam.id;
      subjectName = subjectTeam.name;
    } else {
      // PLAYER_GOALS: find-or-create by {league, name}, same upsert
      // pattern as sync.ts's own Team upserts. teamId stays null until
      // syncPropStatsForLeague resolves it from real appearance data.
      const existing = await db.player.findFirst({ where: { league, name: parsed.propSubjectName } });
      const player =
        existing ?? (await db.player.create({ data: { league, name: parsed.propSubjectName } }));
      subjectId = player.id;
      subjectName = player.name;
    }

    const closeTime = m.close_time ? new Date(m.close_time) : null;
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
        gameId,
        propKind: parsed.propKind,
        propThreshold: parsed.propThreshold,
        propSubjectExternalId: subjectId,
        propSubjectName: subjectName,
        yesPrice: yesPrice ?? undefined,
        noPrice: noPrice ?? undefined,
        closeTime: closeTime ?? undefined,
        status: m.status,
        raw: JSON.stringify(m),
      },
      update: {
        title: m.title,
        yesSubTitle: m.yes_sub_title,
        gameId,
        propKind: parsed.propKind,
        propThreshold: parsed.propThreshold,
        propSubjectExternalId: subjectId,
        propSubjectName: subjectName,
        yesPrice: yesPrice ?? undefined,
        noPrice: noPrice ?? undefined,
        closeTime: closeTime ?? undefined,
        status: m.status,
        raw: JSON.stringify(m),
      },
    });
    propMarketsUpserted += 1;
  }

  console.info(`[sync.props] ${league}: upserted ${propMarketsUpserted} prop market(s)`);
  return { league, propMarketsUpserted };
}

export interface PropStatsSyncSummary {
  league: League;
  gamesProcessed: number;
  teamStatsUpserted: number;
  playerStatsUpserted: number;
}

const EMPTY_PROP_STATS_SUMMARY = (league: League): PropStatsSyncSummary => ({
  league,
  gamesProcessed: 0,
  teamStatsUpserted: 0,
  playerStatsUpserted: 0,
});

/**
 * Populates `TeamGameStat` (corners) and `PlayerGameStat` (goals, plus
 * 0-goal appearance rows) from ESPN's public site API for games that just
 * went FINAL and don't have stats yet - the `teamStats: { none: {} } }`
 * filter avoids re-fetching a game already stat'd.
 *
 * Originally designed around API-Football, but its free tier turned out to
 * be walled off from the live 2026 season entirely ("Free plans do not have
 * access to this season, try from 2022 to 2024" - confirmed live, not a
 * guess). ESPN's public API (already used for NFL in nfl.ts) is free,
 * keyless, and does expose real stats for the current World Cup via
 * `boxscore.teams[].statistics` (`wonCorners`), `rosters` (appearances),
 * and `keyEvents` (goal scorers) - see espn-soccer-stats.ts.
 */
export async function syncPropStatsForLeague(league: League): Promise<PropStatsSyncSummary> {
  if (league !== "WORLD_CUP") return EMPTY_PROP_STATS_SUMMARY(league); // v1: props are World Cup only

  const finalGames = await db.game.findMany({
    where: { league, status: "FINAL", teamStats: { none: {} } },
  });
  if (finalGames.length === 0) return EMPTY_PROP_STATS_SUMMARY(league);

  const startDate = new Date(Math.min(...finalGames.map((g) => g.startTime.getTime())) - 86_400_000);
  const endDate = new Date(Math.max(...finalGames.map((g) => g.startTime.getTime())) + 86_400_000);

  const { teamStats: teamStatRows, playerStats: playerStatRows } = await fetchEspnGameStats({
    startDate,
    endDate,
  });

  const teams = await db.team.findMany({ where: { league } });
  const resolvedGameCache = new Map<string, string | null>();

  async function resolveGameId(row: {
    gameExternalId: string;
    fixtureDate: string;
    homeTeamName: string;
    awayTeamName: string;
  }): Promise<string | null> {
    if (resolvedGameCache.has(row.gameExternalId)) return resolvedGameCache.get(row.gameExternalId)!;
    const matched = await matchFixtureToGame({
      homeTeamName: row.homeTeamName,
      awayTeamName: row.awayTeamName,
      startTime: new Date(row.fixtureDate),
      league: "WORLD_CUP",
    });
    const id = matched?.id ?? null;
    resolvedGameCache.set(row.gameExternalId, id);
    return id;
  }

  function resolveTeamId(teamName: string): string | null {
    return (
      teams.find(
        (t) =>
          haystackContainsCandidate(teamName, t.name) ||
          (t.shortName ? haystackContainsCandidate(teamName, t.shortName) : false)
      )?.id ?? null
    );
  }

  let teamStatsUpserted = 0;
  for (const row of teamStatRows) {
    const gameId = await resolveGameId(row);
    const teamId = resolveTeamId(row.teamName);
    if (!gameId || !teamId || row.corners == null) continue;
    await db.teamGameStat.upsert({
      where: { gameId_teamId: { gameId, teamId } },
      create: { gameId, teamId, corners: row.corners, raw: JSON.stringify(row) },
      update: { corners: row.corners, raw: JSON.stringify(row) },
    });
    teamStatsUpserted += 1;
  }

  // Player find-or-create matches by name against existing Player rows
  // (which may already exist from syncPropMarketsForLeague's PLAYER_GOALS
  // branch, created from Kalshi's yes_sub_title name) via the same
  // haystackContainsCandidate heuristic used for team resolution, rather
  // than an exact string match - Kalshi's and ESPN's name formatting don't
  // always agree character-for-character.
  let playerStatsUpserted = 0;
  const playersCache = await db.player.findMany({ where: { league } });
  for (const row of playerStatRows) {
    const gameId = await resolveGameId(row);
    if (!gameId) continue;
    const teamId = resolveTeamId(row.teamName);

    let player = playersCache.find(
      (p) => haystackContainsCandidate(row.playerName, p.name) || haystackContainsCandidate(p.name, row.playerName)
    );
    if (!player) {
      player = await db.player.create({
        data: {
          league,
          name: row.playerName,
          teamId,
          externalIds: JSON.stringify({ espn: row.playerExternalId }),
        },
      });
      playersCache.push(player);
    } else if (teamId && player.teamId !== teamId) {
      player = await db.player.update({ where: { id: player.id }, data: { teamId } });
    }

    await db.playerGameStat.upsert({
      where: { gameId_playerId: { gameId, playerId: player.id } },
      create: { gameId, playerId: player.id, goals: row.goals, raw: JSON.stringify(row) },
      update: { goals: row.goals, raw: JSON.stringify(row) },
    });
    playerStatsUpserted += 1;
  }

  console.info(
    `[sync.propStats] ${league}: ${finalGames.length} FINAL game(s) considered, ` +
      `${teamStatsUpserted} team stat(s), ${playerStatsUpserted} player stat(s) upserted`
  );
  return {
    league,
    gamesProcessed: finalGames.length,
    teamStatsUpserted,
    playerStatsUpserted,
  };
}

export interface FullSyncSummary {
  sports: SportsSyncSummary[];
  markets: KalshiSyncSummary[];
  propMarkets: PropMarketSyncSummary[];
  propStats: PropStatsSyncSummary[];
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

  const propMarkets: PropMarketSyncSummary[] = [];
  for (const league of leagues) {
    propMarkets.push(await syncPropMarketsForLeague(league));
  }

  const propStats: PropStatsSyncSummary[] = [];
  for (const league of leagues) {
    propStats.push(await syncPropStatsForLeague(league));
  }

  return { sports, markets, propMarkets, propStats };
}
