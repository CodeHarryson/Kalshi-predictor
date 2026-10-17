import type { League } from "@/generated/prisma/enums";

export type ProviderGameStatus =
  | "SCHEDULED"
  | "LIVE"
  | "FINAL"
  | "POSTPONED"
  | "CANCELED";

export interface ProviderTeam {
  externalId: string;
  name: string;
  shortName?: string;
}

export interface ProviderGame {
  externalId: string;
  league: League;
  startTime: Date;
  status: ProviderGameStatus;
  homeTeamExternalId: string;
  awayTeamExternalId: string;
  homeScore?: number;
  awayScore?: number;
  /** ESPN season type: 1 preseason, 2 regular season, 3 postseason, 4 offseason. */
  seasonType?: number;
}

export interface ProviderPlayerStat {
  gameExternalId: string;
  playerExternalId: string;
  playerName: string;
  teamExternalId: string;
  points?: number;
  rebounds?: number;
  assists?: number;
  minutes?: number;
  raw?: Record<string, unknown>;
}

export interface DateRange {
  startDate: Date;
  endDate: Date;
}

export interface SportsProvider {
  readonly name: string;
  readonly leagues: League[];
  fetchTeams(league: League): Promise<ProviderTeam[]>;
  fetchGames(league: League, range: DateRange): Promise<ProviderGame[]>;
  fetchPlayerStats?(league: League, range: DateRange): Promise<ProviderPlayerStat[]>;
}
