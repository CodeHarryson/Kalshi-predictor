import { db } from "@/lib/db";
import type { League } from "@/generated/prisma/enums";
import { fetchInjuries, INJURY_LEAGUES } from "./providers/espn-injuries";
import { availabilityLoss, footballImpactElo, nbaImpactElo } from "./scoring/injuries";

/**
 * Replaces a league's stored injury report with ESPN's current one. Returns
 * the number of rows stored (0 for leagues without an injury feed).
 *
 * The feed is replaced wholesale rather than merged: ESPN drops players when
 * they return, so merging would leave healthy players flagged as out. An
 * empty result is treated as "feed unavailable" and leaves the previous rows
 * alone, since a failed fetch and an empty report look the same here.
 */
export async function syncInjuriesForLeague(league: League): Promise<number> {
  if (!INJURY_LEAGUES.includes(league)) return 0;

  const injuries = await fetchInjuries(league);
  if (injuries.length === 0) {
    console.info(`[sync.injuries] ${league}: no current injuries returned, keeping existing rows`);
    return 0;
  }

  const teams = await db.team.findMany({
    where: { league },
    select: { id: true, name: true, externalId: true },
  });
  const byExternalId = new Map(teams.filter((t) => t.externalId).map((t) => [t.externalId!, t.id]));
  const byName = new Map(teams.map((t) => [t.name.toLowerCase(), t.id]));

  // NBA teams are keyed by balldontlie ids, ESPN's differ, so fall back to name.
  const resolveTeam = (externalId: string, name: string) =>
    (league !== "NBA" ? byExternalId.get(externalId) : undefined) ?? byName.get(name.toLowerCase());

  const data = [];
  for (const inj of injuries) {
    const teamId = resolveTeam(inj.teamExternalId, inj.teamName);
    if (!teamId) continue;
    data.push({
      league,
      teamId,
      playerExternalId: inj.playerExternalId,
      playerName: inj.playerName,
      position: inj.position,
      status: inj.status,
      isStarter: inj.isStarter,
      availabilityLoss: availabilityLoss(inj.status),
      impactElo:
        league === "NBA"
          ? nbaImpactElo(inj.nbaStats)
          : footballImpactElo(league, inj.position, inj.isStarter),
      reportedAt: inj.reportedAt,
    });
  }

  await db.$transaction([
    db.injuryReport.deleteMany({ where: { league } }),
    db.injuryReport.createMany({ data }),
  ]);

  console.info(`[sync.injuries] ${league}: stored ${data.length} of ${injuries.length} injury row(s)`);
  return data.length;
}
