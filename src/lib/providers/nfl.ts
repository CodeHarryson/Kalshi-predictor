import type { DateRange, ProviderGame, ProviderTeam, SportsProvider } from "./types";

const BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

async function espnFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`);
    if (!res.ok) {
      console.warn(`[nfl provider] ${path} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[nfl provider] ${path} failed:`, err);
    return null;
  }
}

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

export const nflProvider: SportsProvider = {
  name: "espn",
  leagues: ["NFL"],

  async fetchTeams(): Promise<ProviderTeam[]> {
    const data = await espnFetch<EspnTeamsResponse>("/teams?limit=40");
    if (!data) return [];
    const teams = data.sports?.[0]?.leagues?.[0]?.teams ?? [];
    return teams.map(({ team }) => ({
      externalId: team.id,
      name: team.displayName,
      shortName: team.abbreviation,
    }));
  },

  async fetchGames(_league, range: DateRange): Promise<ProviderGame[]> {
    const data = await espnFetch<EspnScoreboardResponse>(
      `/scoreboard?dates=${fmt(range.startDate)}-${fmt(range.endDate)}&limit=100`
    );
    if (!data) return [];

    const games: ProviderGame[] = [];
    for (const event of data.events ?? []) {
      const competitors = event.competitions?.[0]?.competitors ?? [];
      const home = competitors.find((c) => c.homeAway === "home");
      const away = competitors.find((c) => c.homeAway === "away");
      if (!home || !away) continue;

      games.push({
        externalId: event.id,
        league: "NFL",
        startTime: new Date(event.date),
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
