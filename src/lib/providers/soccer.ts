import type { League } from "@/generated/prisma/enums";
import type { DateRange, ProviderGame, ProviderTeam, SportsProvider } from "./types";

const BASE_URL = "https://api.football-data.org/v4";

const COMPETITION_CODE: Record<"EPL" | "LALIGA" | "WORLD_CUP", string> = {
  EPL: "PL",
  LALIGA: "PD",
  WORLD_CUP: "WC",
};

async function fdFetch<T>(path: string): Promise<T | null> {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) {
    console.warn("[soccer provider] FOOTBALL_DATA_API_KEY not set, skipping fetch");
    return null;
  }
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { "X-Auth-Token": key },
    });
    if (!res.ok) {
      console.warn(`[soccer provider] ${path} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[soccer provider] ${path} failed:`, err);
    return null;
  }
}

interface FdTeam {
  id: number;
  name: string;
  shortName?: string;
  tla?: string;
}

interface FdMatch {
  id: number;
  utcDate: string;
  status: string;
  homeTeam: { id: number };
  awayTeam: { id: number };
  score: { fullTime: { home: number | null; away: number | null } };
}

function mapStatus(raw: string): ProviderGame["status"] {
  switch (raw) {
    case "FINISHED":
      return "FINAL";
    case "POSTPONED":
      return "POSTPONED";
    case "CANCELLED":
    case "SUSPENDED":
      return "CANCELED";
    case "IN_PLAY":
    case "PAUSED":
      return "LIVE";
    default:
      return "SCHEDULED";
  }
}

function isSoccerLeague(
  league: League
): league is "EPL" | "LALIGA" | "WORLD_CUP" {
  return league === "EPL" || league === "LALIGA" || league === "WORLD_CUP";
}

export const soccerProvider: SportsProvider = {
  name: "football-data.org",
  leagues: ["EPL", "LALIGA", "WORLD_CUP"],

  async fetchTeams(league: League): Promise<ProviderTeam[]> {
    if (!isSoccerLeague(league)) return [];
    const code = COMPETITION_CODE[league];
    const data = await fdFetch<{ teams: FdTeam[] }>(`/competitions/${code}/teams`);
    if (!data) return [];
    return data.teams.map((t) => ({
      externalId: String(t.id),
      name: t.name,
      shortName: t.tla ?? t.shortName,
    }));
  },

  async fetchGames(league: League, range: DateRange): Promise<ProviderGame[]> {
    if (!isSoccerLeague(league)) return [];
    const code = COMPETITION_CODE[league];
    const qs = new URLSearchParams({
      dateFrom: range.startDate.toISOString().slice(0, 10),
      dateTo: range.endDate.toISOString().slice(0, 10),
    });
    const data = await fdFetch<{ matches: FdMatch[] }>(
      `/competitions/${code}/matches?${qs.toString()}`
    );
    if (!data) return [];
    return data.matches.map((m) => ({
      externalId: String(m.id),
      league,
      startTime: new Date(m.utcDate),
      status: mapStatus(m.status),
      homeTeamExternalId: String(m.homeTeam.id),
      awayTeamExternalId: String(m.awayTeam.id),
      homeScore: m.score.fullTime.home ?? undefined,
      awayScore: m.score.fullTime.away ?? undefined,
    }));
  },
};
