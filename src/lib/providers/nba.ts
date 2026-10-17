import type { DateRange, ProviderGame, ProviderTeam, SportsProvider } from "./types";

const BASE_URL = "https://api.balldontlie.io/v1";

// balldontlie requires a free API key (https://balldontlie.io) sent as the
// Authorization header. Without one, requests fail with 401 and this
// provider returns empty results rather than throwing, so the rest of the
// app degrades gracefully until a key is added to .env.
function authHeaders(): HeadersInit {
  const key = process.env.BALLDONTLIE_API_KEY;
  return key ? { Authorization: key } : {};
}

async function bdlFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
    if (!res.ok) {
      console.warn(`[nba provider] ${path} -> HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[nba provider] ${path} failed:`, err);
    return null;
  }
}

interface BdlTeam {
  id: number;
  full_name: string;
  abbreviation: string;
}

interface BdlGame {
  id: number;
  date: string;
  status: string;
  home_team: BdlTeam;
  visitor_team: BdlTeam;
  home_team_score: number;
  visitor_team_score: number;
}

function mapStatus(raw: string): ProviderGame["status"] {
  const s = raw.toLowerCase();
  if (s.includes("final")) return "FINAL";
  if (s.includes("postponed")) return "POSTPONED";
  if (s.includes("canceled") || s.includes("cancelled")) return "CANCELED";
  // Upcoming games carry their tip-off as an ISO timestamp in `status` (e.g.
  // "2026-10-22T23:30:00Z"), which must not be mistaken for a live clock.
  if (s.includes("qtr") || s.includes("half") || s === "in progress") return "LIVE";
  return "SCHEDULED";
}

// `date` is date-only; the real tip-off time is the ISO `status` when present.
function tipoff(g: { date: string; status: string }): Date {
  return /^\d{4}-\d{2}-\d{2}T/.test(g.status) ? new Date(g.status) : new Date(g.date);
}

export const nbaProvider: SportsProvider = {
  name: "balldontlie",
  leagues: ["NBA"],

  async fetchTeams(): Promise<ProviderTeam[]> {
    const data = await bdlFetch<{ data: BdlTeam[] }>("/teams");
    if (!data) return [];
    return data.data.map((t) => ({
      externalId: String(t.id),
      name: t.full_name,
      shortName: t.abbreviation,
    }));
  },

  async fetchGames(_league, range: DateRange): Promise<ProviderGame[]> {
    const start = range.startDate.toISOString().slice(0, 10);
    const end = range.endDate.toISOString().slice(0, 10);
    const games: ProviderGame[] = [];
    let cursor: string | null = null;

    do {
      const qs = new URLSearchParams({
        start_date: start,
        end_date: end,
        per_page: "100",
      });
      if (cursor) qs.set("cursor", cursor);
      const data = await bdlFetch<{ data: BdlGame[]; meta: { next_cursor?: string | null } }>(
        `/games?${qs.toString()}`
      );
      if (!data) break;
      for (const g of data.data) {
        games.push({
          externalId: String(g.id),
          league: "NBA",
          startTime: tipoff(g),
          status: mapStatus(g.status),
          homeTeamExternalId: String(g.home_team.id),
          awayTeamExternalId: String(g.visitor_team.id),
          homeScore: g.home_team_score ?? undefined,
          awayScore: g.visitor_team_score ?? undefined,
        });
      }
      cursor = data.meta?.next_cursor ? String(data.meta.next_cursor) : null;
    } while (cursor);

    return games;
  },
};
