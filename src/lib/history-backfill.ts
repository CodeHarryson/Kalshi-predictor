import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";
import type { SportsProvider } from "./providers/types";

export interface BackfillSummary {
  league: League;
  gamesUpserted: number;
  gamesSkippedUnknownTeam: number;
}

/**
 * Loads completed games from the last `daysBack` days so ratings, recent
 * form and head-to-head have a real history to work from (the regular sync
 * only reaches back three weeks).
 *
 * Teams are matched to existing rows by provider id, then by name, and
 * existing teams are never modified: the NBA backfill uses ESPN while live
 * NBA data comes from balldontlie, and rewriting externalId here would
 * make the two providers fight over it. Only FINAL games with scores are
 * stored, and preseason/offseason games are skipped. Callers should rebuild ratings afterwards (rebuildRatingsForLeague).
 */
export async function backfillHistory(
  league: League,
  provider: SportsProvider,
  daysBack: number,
  /**
   * "provider-id" trusts externalId (right when the live sync uses the same
   * provider). "name" ignores ids: required when the live provider differs,
   * because two providers can number teams 1-30 differently, so an id match
   * silently attaches games to the wrong team.
   */
  matchTeamsBy: "provider-id" | "name" = "provider-id"
): Promise<BackfillSummary> {
  const now = new Date();
  const startDate = new Date(now.getTime() - daysBack * 86_400_000);

  const providerTeams = await provider.fetchTeams(league);
  const existing = await db.team.findMany({ where: { league } });
  const byExternalId = new Map(existing.filter((t) => t.externalId).map((t) => [t.externalId!, t.id]));
  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t.id]));

  const teamIdByExternal = new Map<string, string>();
  for (const pt of providerTeams) {
    let id =
      (matchTeamsBy === "provider-id" ? byExternalId.get(pt.externalId) : undefined) ??
      byName.get(pt.name.toLowerCase());
    if (!id) {
      id = (
        await db.team.create({
          data: { league, name: pt.name, shortName: pt.shortName, externalId: pt.externalId },
        })
      ).id;
    }
    teamIdByExternal.set(pt.externalId, id);
  }

  const games = await provider.fetchGames(league, { startDate, endDate: now });
  let gamesUpserted = 0;
  let gamesSkippedUnknownTeam = 0;

  for (const g of games) {
    if (g.status !== "FINAL" || g.homeScore == null || g.awayScore == null) continue;
    // Preseason / offseason games field backups and would distort ratings.
    if (g.seasonType === 1 || g.seasonType === 4) continue;
    const homeTeamId = teamIdByExternal.get(g.homeTeamExternalId);
    const awayTeamId = teamIdByExternal.get(g.awayTeamExternalId);
    if (!homeTeamId || !awayTeamId) {
      gamesSkippedUnknownTeam += 1;
      continue;
    }
    await db.game.upsert({
      where: { league_externalId: { league, externalId: g.externalId } },
      create: {
        league,
        externalId: g.externalId,
        startTime: g.startTime,
        status: "FINAL",
        homeTeamId,
        awayTeamId,
        homeScore: g.homeScore,
        awayScore: g.awayScore,
      },
      update: { startTime: g.startTime, status: "FINAL", homeScore: g.homeScore, awayScore: g.awayScore },
    });
    gamesUpserted += 1;
  }

  return { league, gamesUpserted, gamesSkippedUnknownTeam };
}
