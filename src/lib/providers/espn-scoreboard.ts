import type { League } from "@/generated/prisma/enums";
import type { DateRange, ProviderGame, ProviderTeam, SportsProvider } from "./types";

const ESPN_SPORTS = "https://site.api.espn.com/apis/site/v2/sports";

interface EspnTeamsResponse {
  sports: {
    leagues: {
      teams: { team: { id: string; displayName: string; abbreviation: string } }[];
    }[];
  }[];
}

interface EspnCompetitor {
  homeAway: "home" | "away";
  score?: string;
  team: { id: string };
}

interface EspnEvent {
  id: string;
  date: string;
  season?: { type?: number };
  status: { type: { name: string } };
  competitions: { competitors: EspnCompetitor[] }[];
}

interface EspnScoreboardResponse {
  events: EspnEvent[];
}

function mapStatus(name: string): ProviderGame["status"] {
  if (name === "STATUS_FINAL") return "FINAL";
  if (name === "STATUS_POSTPONED") return "POSTPONED";
  if (name === "STATUS_CANCELED") return "CANCELED";
  if (name === "STATUS_IN_PROGRESS" || name === "STATUS_HALFTIME") return "LIVE";
  return "SCHEDULED";
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export interface EspnScoreboardConfig {
  league: League;
  /** ESPN sport path segment, e.g. "nfl" or "college-football". */
  sport: string;
  /** ESPN sport family: "football" (default) or "basketball". */
  sportGroup?: string;
  /** ESPN scoreboard `groups` filters (college only: 80 = FBS, 81 = FCS). Empty = unfiltered. */
  groups?: string[];
  teamsLimit: number;
}

/**
 * ESPN's football and basketball scoreboards reject `dates=A-B` ranges with HTTP 400, so
 * games are fetched one day at a time (a week of days per batch) and deduped
 * by event id.
 */
export function createEspnScoreboardProvider(cfg: EspnScoreboardConfig): SportsProvider {
  const tag = `[${cfg.league.toLowerCase()} provider]`;
  const baseUrl = `${ESPN_SPORTS}/${cfg.sportGroup ?? "football"}/${cfg.sport}`;

  async function espnFetch<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(`${baseUrl}${path}`);
      if (!res.ok) {
        console.warn(`${tag} ${path} -> HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      console.warn(`${tag} ${path} failed:`, err);
      return null;
    }
  }

  return {
    name: "espn",
    leagues: [cfg.league],

    async fetchTeams(): Promise<ProviderTeam[]> {
      const data = await espnFetch<EspnTeamsResponse>(`/teams?limit=${cfg.teamsLimit}`);
      if (!data) return [];
      const teams = data.sports?.[0]?.leagues?.[0]?.teams ?? [];
      return teams.map(({ team }) => ({
        externalId: team.id,
        name: team.displayName,
        shortName: team.abbreviation,
      }));
    },

    async fetchGames(_league, range: DateRange): Promise<ProviderGame[]> {
      const days: string[] = [];
      for (let t = range.startDate.getTime(); t <= range.endDate.getTime(); t += 86_400_000) {
        days.push(fmt(new Date(t)));
      }
      const groups = cfg.groups?.length ? cfg.groups : [null];
      const urls = days.flatMap((d) =>
        groups.map((g) => `/scoreboard?dates=${d}&limit=300${g ? `&groups=${g}` : ""}`)
      );

      const events = new Map<string, EspnEvent>();
      for (let i = 0; i < urls.length; i += 7) {
        const batch = await Promise.all(
          urls.slice(i, i + 7).map((u) => espnFetch<EspnScoreboardResponse>(u))
        );
        for (const data of batch) for (const e of data?.events ?? []) events.set(e.id, e);
      }

      const games: ProviderGame[] = [];
      for (const event of events.values()) {
        const competitors = event.competitions?.[0]?.competitors ?? [];
        const home = competitors.find((c) => c.homeAway === "home");
        const away = competitors.find((c) => c.homeAway === "away");
        if (!home || !away) continue;

        games.push({
          externalId: event.id,
          league: cfg.league,
          startTime: new Date(event.date),
          seasonType: event.season?.type,
          status: mapStatus(event.status?.type?.name ?? ""),
          homeTeamExternalId: home.team.id,
          awayTeamExternalId: away.team.id,
          homeScore: home.score !== undefined ? Number(home.score) : undefined,
          awayScore: away.score !== undefined ? Number(away.score) : undefined,
        });
      }
      return games;
    },
  };
}
