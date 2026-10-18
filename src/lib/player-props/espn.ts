import type { League } from "@/generated/prisma/enums";
import type { StatLine } from "./stats";

const SITE = "https://site.api.espn.com/apis/site/v2/sports";
const WEB = "https://site.web.api.espn.com/apis/common/v3/sports";
const PATH: Partial<Record<League, string>> = { NBA: "basketball/nba", NFL: "football/nfl" };

export interface RosterEntry {
  espnId: string;
  name: string;
  teamName: string;
}

export interface GameLogRow {
  eventId: string;
  gameDate: Date;
  stats: StatLine;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Runs `fn` over `items` with a small fixed concurrency. */
export async function mapPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

interface EspnAthlete { id: string; fullName?: string; displayName?: string }

/** Every player on every roster in the league (NBA rosters are flat lists, NFL's are grouped by unit). */
export async function fetchRosters(league: League): Promise<RosterEntry[]> {
  const path = PATH[league];
  if (!path) return [];
  const teams = await getJson<{ sports: { leagues: { teams: { team: { id: string; displayName: string } }[] }[] }[] }>(
    `${SITE}/${path}/teams?limit=100`
  );
  const list = teams?.sports?.[0]?.leagues?.[0]?.teams?.map((t) => t.team) ?? [];
  const rosters = await mapPool(list, 6, async (team) => {
    const data = await getJson<{ athletes?: (EspnAthlete | { items?: EspnAthlete[] })[] }>(`${SITE}/${path}/teams/${team.id}/roster`);
    const athletes = (data?.athletes ?? []).flatMap((a) => ("items" in a && a.items ? a.items : [a as EspnAthlete]));
    return athletes
      .filter((a) => a.id && (a.fullName || a.displayName))
      .map((a) => ({ espnId: String(a.id), name: (a.fullName ?? a.displayName)!, teamName: team.displayName }));
  });
  return rosters.flat();
}

interface RawGameLog {
  names?: string[];
  events?: Record<string, { gameDate?: string }>;
  seasonTypes?: { displayName?: string; categories?: { events?: { eventId: string; stats: string[] }[] }[] }[];
}

function parseGameLog(data: RawGameLog | null, into: Map<string, GameLogRow>) {
  if (!data?.names || !data.events) return;
  for (const season of data.seasonTypes ?? []) {
    // Preseason games are dropped: starters barely play in them.
    if (/preseason/i.test(season.displayName ?? "")) continue;
    for (const category of season.categories ?? []) {
      for (const ev of category.events ?? []) {
        const date = data.events[ev.eventId]?.gameDate;
        if (!date || into.has(ev.eventId)) continue;
        const stats: StatLine = {};
        data.names.forEach((name, i) => {
          const raw = ev.stats[i];
          if (raw === undefined) return;
          const n = Number(raw);
          stats[name] = raw !== "" && Number.isFinite(n) ? n : raw;
        });
        // "made-attempted" strings: keep the made count as its own stat.
        const threes = stats["threePointFieldGoalsMade-threePointFieldGoalsAttempted"];
        if (typeof threes === "string") stats.threes = Number(threes.split("-")[0]);
        into.set(ev.eventId, { eventId: ev.eventId, gameDate: new Date(date), stats });
      }
    }
  }
}

/**
 * A player's per-game stat lines, newest first: ESPN's default season (the
 * current one, or the last finished one in the offseason) plus the year before,
 * so there is enough history early in a season.
 */
export async function fetchGameLog(league: League, espnId: string): Promise<GameLogRow[]> {
  const path = PATH[league];
  if (!path) return [];
  const url = `${WEB}/${path}/athletes/${espnId}/gamelog`;
  const rows = new Map<string, GameLogRow>();
  parseGameLog(await getJson<RawGameLog>(url), rows);
  parseGameLog(await getJson<RawGameLog>(`${url}?season=${new Date().getFullYear() - 1}`), rows);
  return [...rows.values()].sort((a, b) => b.gameDate.getTime() - a.gameDate.getTime());
}
