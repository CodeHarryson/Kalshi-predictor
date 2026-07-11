import type { League } from "@/generated/prisma/enums";
import type {
  DateRange,
  ProviderGame,
  ProviderPlayerStat,
  ProviderTeam,
  SportsProvider,
} from "./types";

const BASE_URL = "https://v3.football.api-sports.io";

// ProviderPlayerStat extended shape — we read goals + team + player identifiers
// from API-Football's /fixtures/players endpoint. The base ProviderPlayerStat
// in types.ts only covers the basketball shape (points/rebounds/assists/minutes);
// we add a narrow `goals` field for the soccer use case. Goals are stored on
// PlayerGameStat.goals by the sync layer.
export interface ApiFootballPlayerStat extends ProviderPlayerStat {
  goals?: number;
  /** Fixture kickoff time (ISO string), needed to match this row to one of
   *  our `Game` rows via `matchFixtureToGame` - `gameExternalId` alone
   *  (API-Football's own fixture id) isn't something our `Game` rows carry. */
  fixtureDate: string;
  homeTeamName: string;
  awayTeamName: string;
}

export interface ApiFootballTeamStat {
  gameExternalId: string;
  teamExternalId: string;
  teamName: string;
  corners?: number;
  fixtureDate: string;
  homeTeamName: string;
  awayTeamName: string;
}

export function isApiFootballConfigured(): boolean {
  return Boolean(process.env.API_FOOTBALL_KEY);
}

async function afFetch<T>(path: string): Promise<T | null> {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    console.warn("[api-football provider] API_FOOTBALL_KEY not set, skipping fetch");
    return null;
  }
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      headers: { "x-apisports-key": key },
    });
    if (!res.ok) {
      console.warn(`[api-football provider] ${path} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[api-football provider] ${path} failed:`, err);
    return null;
  }
}

function mapStatus(raw: string): ProviderGame["status"] {
  switch (raw) {
    case "FT":
    case "AET":
    case "PEN":
      return "FINAL";
    case "1H":
    case "2H":
    case "ET":
    case "P":
    case "BT":
    case "LIVE":
      return "LIVE";
    case "PST":
      return "POSTPONED";
    case "CANC":
    case "ABD":
    case "AWD":
    case "WO":
      return "CANCELED";
    default:
      // NS (not started) and anything unknown: treat as scheduled.
      return "SCHEDULED";
  }
}

function isSoccerLeague(league: League): league is "WORLD_CUP" {
  // v1: API-Football is only used for World Cup props. The other soccer
  // leagues (EPL, LALIGA) keep using football-data.org via soccer.ts.
  return league === "WORLD_CUP";
}

export const apiFootballProvider: SportsProvider = {
  name: "api-football",
  leagues: ["WORLD_CUP"],

  async fetchTeams(league: League): Promise<ProviderTeam[]> {
    // v1: team/league/fixture data still comes from football-data.org via
    // the existing soccerProvider. API-Football is used only for player +
    // team box-score stats (goals, corners) — i.e. fetchPlayerStats below.
    // Returning [] here lets the WORLD_CUP entry in PROVIDER_BY_LEAGUE
    // (in sync.ts) route to the soccer provider for teams/games and to
    // this provider for stats, if/when we wire it that way.
    if (!isSoccerLeague(league)) return [];
    return [];
  },

  async fetchGames(league: League, _range: DateRange): Promise<ProviderGame[]> {
    // Same as above: games come from football-data.org today. Returning []
    // here keeps the v1 split: soccer.ts owns teams/games, this provider
    // owns stats.
    if (!isSoccerLeague(league)) return [];
    return [];
  },
};

// API-Football-specific fetcher, NOT on the SportsProvider interface (yet).
// The syncPropStatsForLeague function in sync.ts calls this directly so we
// can keep the existing fetchPlayerStats hook on the interface for future
// generalization without forcing the basketball-shaped ProviderPlayerStat
// type to carry the soccer fields.
export async function fetchApiFootballPlayerStats(
  range: DateRange
): Promise<ApiFootballPlayerStat[]> {
  // Endpoint: /fixtures?from=YYYY-MM-DD&to=YYYY-MM-DD&league=3 (World Cup
  // id on API-Football is 3 for the men's senior tournament; we'll need to
  // verify this in the live-verify step, same lesson as the yesSubTitle
  // / yes_ask_dollars surprises). For now the shape is: GET /fixtures +
  // GET /fixtures/players per fixture, since API-Football doesn't have a
  // single combined call.
  void range;
  // Until the live-verify step confirms the actual endpoint shape, the
  // call surface is left intentionally empty. Calling this returns []
  // rather than throwing so the sync layer can run end-to-end against
  // a missing key without blowing up the rest of the pipeline.
  return [];
}

export async function fetchApiFootballTeamStats(
  _range: DateRange
): Promise<ApiFootballTeamStat[]> {
  // Mirrors fetchApiFootballPlayerStats: returns [] until live-verify.
  return [];
}
