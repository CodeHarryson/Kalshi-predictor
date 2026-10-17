import type { League } from "@/generated/prisma/enums";
import type { NbaPlayerStats } from "@/lib/scoring/injuries";
import { availabilityLoss } from "@/lib/scoring/injuries";

const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const CORE = "https://sports.core.api.espn.com/v2/sports";

const SPORT_PATH: Partial<Record<League, string>> = {
  NBA: "basketball/nba",
  NFL: "football/nfl",
  CFB: "football/college-football",
};

/**
 * Leagues whose ESPN injury feed is unmaintained: the college-football feed
 * returns a handful of teams with entries from 2020, so anything older than
 * this is dropped rather than treated as a current absence. NBA/NFL feeds
 * are curated (stale entries are removed), so they take no age filter.
 */
const MAX_AGE_DAYS: Partial<Record<League, number>> = { CFB: 21 };

export const INJURY_LEAGUES: League[] = ["NBA", "NFL", "CFB"];

export interface ProviderInjury {
  teamExternalId: string;
  teamName: string;
  playerExternalId: string;
  playerName: string;
  position: string | null;
  status: string;
  reportedAt: Date | null;
  /** NBA only: last-season/current averages, null when unavailable (rookies). */
  nbaStats: NbaPlayerStats | null;
  /** Football only: null when no depth chart is available. */
  isStarter: boolean | null;
}

interface EspnInjuryEntry {
  id: string;
  status: string;
  date?: string;
  athlete: {
    displayName: string;
    links?: { href: string }[];
    position?: { abbreviation?: string };
  };
}

interface EspnInjuriesResponse {
  season?: { year?: number };
  injuries: { id: string; displayName: string; injuries: EspnInjuryEntry[] }[];
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Runs `fn` over `items` a few at a time so one sync doesn't open hundreds of sockets. */
async function mapInBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

function athleteId(e: EspnInjuryEntry): string {
  const href = e.athlete.links?.find((l) => /\/id\/\d+/.test(l.href))?.href;
  return href?.match(/\/id\/(\d+)/)?.[1] ?? e.id;
}

async function fetchNbaStats(id: string, seasonYear: number): Promise<NbaPlayerStats | null> {
  // The new season has no stats before it starts; fall back to the last one.
  for (const year of [seasonYear, seasonYear - 1]) {
    const data = await getJson<{
      splits?: { categories?: { stats?: { name: string; value: number }[] }[] };
    }>(`${CORE}/basketball/leagues/nba/seasons/${year}/types/2/athletes/${id}/statistics`);
    const stats = data?.splits?.categories?.flatMap((c) => c.stats ?? []) ?? [];
    const mpg = stats.find((s) => s.name === "avgMinutes")?.value;
    const ppg = stats.find((s) => s.name === "avgPoints")?.value;
    if (typeof mpg === "number" && typeof ppg === "number") {
      return { minutesPerGame: mpg, pointsPerGame: ppg };
    }
  }
  return null;
}

/** Athlete ids listed first at any slot of the team's depth chart (i.e. starters). */
async function fetchNflStarters(sportPath: string, teamId: string): Promise<Set<string> | null> {
  const data = await getJson<{
    depthchart?: { positions: Record<string, { athletes: { id: string }[] }> }[];
  }>(`${SITE}/${sportPath}/teams/${teamId}/depthcharts`);
  if (!data?.depthchart?.length) return null;
  const starters = new Set<string>();
  for (const group of data.depthchart) {
    for (const slot of Object.values(group.positions)) {
      const first = slot.athletes?.[0];
      if (first) starters.add(first.id);
    }
  }
  return starters;
}

/**
 * Current injury report for a league, enriched with what's needed to weigh
 * each absence. Only players with a non-zero chance of missing the game are
 * enriched (stats / depth lookups are per-player or per-team requests).
 */
export async function fetchInjuries(league: League): Promise<ProviderInjury[]> {
  const sportPath = SPORT_PATH[league];
  if (!sportPath) return [];

  const data = await getJson<EspnInjuriesResponse>(`${SITE}/${sportPath}/injuries`);
  if (!data) {
    console.warn(`[injuries] ${league}: injury feed unavailable`);
    return [];
  }

  const maxAgeDays = MAX_AGE_DAYS[league];
  const cutoff = maxAgeDays ? Date.now() - maxAgeDays * 86_400_000 : null;

  const rows: ProviderInjury[] = [];
  for (const team of data.injuries ?? []) {
    for (const e of team.injuries ?? []) {
      if (availabilityLoss(e.status) === 0) continue;
      const reportedAt = e.date ? new Date(e.date) : null;
      if (cutoff !== null && (!reportedAt || reportedAt.getTime() < cutoff)) continue;
      rows.push({
        teamExternalId: team.id,
        teamName: team.displayName,
        playerExternalId: athleteId(e),
        playerName: e.athlete.displayName,
        position: e.athlete.position?.abbreviation ?? null,
        status: e.status,
        reportedAt,
        nbaStats: null,
        isStarter: null,
      });
    }
  }

  if (league === "NBA") {
    const year = data.season?.year ?? new Date().getUTCFullYear();
    await mapInBatches(rows, 8, async (r) => {
      r.nbaStats = await fetchNbaStats(r.playerExternalId, year);
    });
  } else if (league === "NFL") {
    const teamIds = [...new Set(rows.map((r) => r.teamExternalId))];
    const startersByTeam = new Map<string, Set<string> | null>();
    await mapInBatches(teamIds, 8, async (id) => {
      startersByTeam.set(id, await fetchNflStarters(sportPath, id));
    });
    for (const r of rows) {
      const starters = startersByTeam.get(r.teamExternalId);
      r.isStarter = starters ? starters.has(r.playerExternalId) : null;
    }
  }

  return rows;
}
