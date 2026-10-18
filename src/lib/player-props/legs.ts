import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";
import type { CandidateLeg } from "@/lib/builder";
import { computeEdge, impliedProbabilityFromPriceCents } from "@/lib/scoring/parlay";
import { probAtLeast, weightedMean } from "./model";
import { PLAYER_PROP_KINDS, normalizeName, propLegLabel, statFor, type StatLine } from "./stats";

/** Prices this close to 0 or 1 carry no real payout or information; skip them. */
const MIN_PRICE = 0.04;
const MAX_PRICE = 0.96;
/** Most recent games considered per player (spans into last season early in a year). */
const LOG_WINDOW = 30;
/**
 * A model-versus-market gap this wide on a stat line almost always means the
 * market knows something the game log does not (a new role, a minutes limit, a
 * matchup), so the leg is dropped rather than ranked at the top.
 */
const MAX_EDGE = 0.3;
/** A player with this chance of missing the game is skipped. */
const MAX_ABSENCE = 0.5;

/**
 * Player-stat legs for games that haven't started: one candidate per prop
 * market, on whichever side (YES "N+" or NO "under N") has the better edge over
 * Kalshi's asking price. Game-level only (the stat model has no opponent or
 * minutes input), so these are a recent-form baseline, not a full projection.
 */
export async function buildPlayerPropLegs(
  league: League,
  opts?: { from?: Date; to?: Date; limit?: number }
): Promise<CandidateLeg[]> {
  const now = new Date();
  const earliest = opts?.from && opts.from > now ? opts.from : now;
  const markets = await db.kalshiMarket.findMany({
    where: {
      league,
      propKind: { in: PLAYER_PROP_KINDS },
      closeTime: { gt: now },
      yesPrice: { not: null },
      game: { status: "SCHEDULED", startTime: { gte: earliest, ...(opts?.to ? { lt: opts.to } : {}) } },
    },
    include: { game: { include: { homeTeam: true, awayTeam: true } } },
  });
  if (markets.length === 0) return [];

  const playerIds = [...new Set(markets.map((m) => m.propSubjectExternalId).filter((id): id is string => !!id))];
  const [logRows, injured] = await Promise.all([
    db.playerGameLog.findMany({ where: { playerId: { in: playerIds } }, orderBy: { gameDate: "desc" } }),
    db.injuryReport.findMany({ where: { league, availabilityLoss: { gte: MAX_ABSENCE } }, select: { playerName: true } }),
  ]);
  const logs = new Map<string, StatLine[]>();
  for (const row of logRows) {
    const list = logs.get(row.playerId) ?? [];
    if (list.length < LOG_WINDOW) {
      list.push(JSON.parse(row.stats) as StatLine);
      logs.set(row.playerId, list);
    }
  }
  const out = new Set(injured.map((i) => normalizeName(i.playerName)));

  const legs: CandidateLeg[] = [];
  for (const m of markets) {
    const game = m.game;
    if (!game || !m.propKind || !m.propSubjectExternalId || m.propThreshold === null || m.yesPrice === null) continue;
    if (out.has(normalizeName(m.propSubjectName ?? ""))) continue;

    const values = (logs.get(m.propSubjectExternalId) ?? [])
      .map((line) => statFor(m.propKind!, line))
      .filter((v): v is number => v !== null);
    const pYes = probAtLeast(values, m.propThreshold, m.propKind === "PLAYER_TDS");
    if (pYes === null) continue;

    const yesImplied = impliedProbabilityFromPriceCents(m.yesPrice);
    const noImplied = m.noPrice !== null ? impliedProbabilityFromPriceCents(m.noPrice) : 1 - yesImplied;
    const yesEdge = computeEdge(pYes, yesImplied);
    const noEdge = computeEdge(1 - pYes, noImplied);
    const takeYes = yesEdge >= noEdge;
    const price = takeYes ? yesImplied : noImplied;
    if (price < MIN_PRICE || price > MAX_PRICE) continue;
    if (Math.max(yesEdge, noEdge) > MAX_EDGE) continue;

    const side = takeYes ? "YES" : "NO";
    legs.push({
      gameId: game.id,
      kalshiMarketId: m.id,
      description: `${game.awayTeam.name} @ ${game.homeTeam.name} — ${m.propSubjectName} ${propLegLabel(m.propKind, m.propThreshold, side)}`,
      side,
      legKind: "PLAYER_PROP",
      predictedProbability: takeYes ? pYes : 1 - pYes,
      marketImpliedProbability: price,
      edge: takeYes ? yesEdge : noEdge,
      features: {
        baseProbability: takeYes ? pYes : 1 - pYes,
        gamesObserved: values.length,
        recentAverage: weightedMean(values),
        threshold: m.propThreshold,
      },
      startTime: game.startTime.toISOString(),
    });
  }

  legs.sort((a, b) => b.edge - a.edge);
  return legs.slice(0, opts?.limit ?? 40);
}
