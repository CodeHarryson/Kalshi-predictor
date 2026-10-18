import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";
import { fetchOpenSeriesMarkets, isKalshiConfigured } from "@/lib/providers/kalshi";
import { haystackContainsCandidate } from "@/lib/providers/text-match";
import { fetchGameLog, fetchRosters, mapPool, type RosterEntry } from "./espn";
import { PLAYER_PROP_SERIES, normalizeName, parsePlayerPropTitle } from "./stats";

const LOG_REFRESH_MS = 6 * 60 * 60 * 1000;

export interface PlayerPropSyncSummary {
  league: League;
  markets: number;
  players: number;
  logsUpserted: number;
}

function eventKey(ticker: string): string | null {
  const parts = ticker.split("-");
  return parts.length >= 3 ? parts[1] : null;
}

/**
 * Syncs Kalshi's NBA / NFL player-prop markets and the game logs behind them.
 * Each market is linked to its game through the game's winner market (same
 * event key in the ticker), and to a Player row resolved by name against
 * ESPN's rosters. propSubjectExternalId stores our own Player.id, matching the
 * other prop kinds.
 */
export async function syncPlayerPropsForLeague(league: League): Promise<PlayerPropSyncSummary> {
  const series = PLAYER_PROP_SERIES[league];
  const empty = { league, markets: 0, players: 0, logsUpserted: 0 };
  if (!series || !isKalshiConfigured()) return empty;

  const fetched = await fetchOpenSeriesMarkets(Object.keys(series));
  if (fetched.length === 0) return empty;

  const rosterByName = new Map<string, RosterEntry[]>();
  for (const r of await fetchRosters(league)) {
    const key = normalizeName(r.name);
    rosterByName.set(key, [...(rosterByName.get(key) ?? []), r]);
  }

  const players = await db.player.findMany({ where: { league } });
  const gameByEvent = new Map<string, { id: string; teams: string[] } | null>();

  async function gameFor(key: string) {
    if (gameByEvent.has(key)) return gameByEvent.get(key)!;
    const sibling = await db.kalshiMarket.findFirst({
      where: { league, gameId: { not: null }, propKind: null, ticker: { contains: `-${key}-` } },
      select: { game: { select: { id: true, homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } } } },
    });
    const g = sibling?.game;
    const value = g ? { id: g.id, teams: [g.homeTeam.name, g.awayTeam.name] } : null;
    gameByEvent.set(key, value);
    return value;
  }

  // One Player row (with ESPN id) per distinct name.
  const playerIdByName = new Map<string, { id: string; espnId: string }>();
  async function resolvePlayer(name: string, teams: string[]) {
    const norm = normalizeName(name);
    const cached = playerIdByName.get(norm);
    if (cached) return cached;
    const candidates = rosterByName.get(norm) ?? [];
    const roster = candidates.find((c) => teams.some((t) => haystackContainsCandidate(t, c.teamName))) ?? (candidates.length === 1 ? candidates[0] : null);
    if (!roster) return null;
    let player = players.find((p) => {
      try { return JSON.parse(p.externalIds).espn === roster.espnId; } catch { return false; }
    }) ?? players.find((p) => normalizeName(p.name) === norm);
    if (!player) {
      player = await db.player.create({ data: { league, name: roster.name, externalIds: JSON.stringify({ espn: roster.espnId }) } });
      players.push(player);
    } else if (!player.externalIds.includes(roster.espnId)) {
      player = await db.player.update({ where: { id: player.id }, data: { externalIds: JSON.stringify({ espn: roster.espnId }) } });
    }
    const value = { id: player.id, espnId: roster.espnId };
    playerIdByName.set(norm, value);
    return value;
  }

  let markets = 0;
  for (const { seriesTicker, market: m } of fetched) {
    const propKind = series[seriesTicker];
    const parsed = parsePlayerPropTitle(m.yes_sub_title ?? m.title);
    const key = eventKey(m.ticker);
    const yesPrice = m.yes_ask ?? m.last_price ?? null;
    if (!propKind || !parsed || !key || yesPrice === null) continue;

    const game = await gameFor(key);
    if (!game) continue;
    const player = await resolvePlayer(parsed.name, game.teams);
    if (!player) continue;

    const noPrice = m.no_ask ?? 100 - yesPrice;
    const closeTime = m.close_time ? new Date(m.close_time) : undefined;
    const data = {
      title: m.title,
      yesSubTitle: m.yes_sub_title,
      category: m.category,
      league,
      gameId: game.id,
      propKind,
      propThreshold: parsed.threshold,
      propSubjectExternalId: player.id,
      propSubjectName: parsed.name,
      yesPrice,
      noPrice,
      closeTime,
      status: m.status,
      raw: JSON.stringify(m),
    };
    await db.kalshiMarket.upsert({ where: { ticker: m.ticker }, create: { ticker: m.ticker, ...data }, update: data });
    markets += 1;
  }

  // Refresh game logs for players that have a market and a stale (or no) log.
  const wanted = [...playerIdByName.values()];
  const latest = await db.playerGameLog.groupBy({
    by: ["playerId"],
    where: { playerId: { in: wanted.map((p) => p.id) } },
    _max: { updatedAt: true },
  });
  const fresh = new Set(
    latest.filter((l) => l._max.updatedAt && Date.now() - l._max.updatedAt.getTime() < LOG_REFRESH_MS).map((l) => l.playerId)
  );
  let logsUpserted = 0;
  await mapPool(wanted.filter((p) => !fresh.has(p.id)), 6, async (p) => {
    const rows = await fetchGameLog(league, p.espnId);
    if (rows.length === 0) return;
    const have = new Set((await db.playerGameLog.findMany({ where: { playerId: p.id }, select: { eventId: true } })).map((r) => r.eventId));
    const created = rows.filter((r) => !have.has(r.eventId));
    if (created.length > 0) {
      await db.playerGameLog.createMany({
        data: created.map((r) => ({ playerId: p.id, eventId: r.eventId, gameDate: r.gameDate, stats: JSON.stringify(r.stats) })),
      });
      logsUpserted += created.length;
    } else {
      // Touch one row so the player counts as refreshed.
      await db.playerGameLog.updateMany({ where: { playerId: p.id, eventId: rows[0].eventId }, data: { stats: JSON.stringify(rows[0].stats) } });
    }
  });

  console.info(`[sync.playerProps] ${league}: ${markets} market(s), ${wanted.length} player(s), ${logsUpserted} new log row(s)`);
  return { league, markets, players: wanted.length, logsUpserted };
}
