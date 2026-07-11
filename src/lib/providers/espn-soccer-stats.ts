import type { DateRange } from "./types";

const BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";

// Same shape as ApiFootballTeamStat (see api-football.ts) so sync.ts's
// syncPropStatsForLeague can consume either source unchanged. ESPN's public
// site API is free and keyless (already used for NFL in nfl.ts) and, unlike
// API-Football's free tier, isn't walled off from the current live season -
// confirmed live: `boxscore.teams[].statistics` includes `wonCorners` for
// real, already-finished 2026 World Cup matches.
export interface EspnTeamCornerStat {
  gameExternalId: string;
  teamExternalId: string;
  teamName: string;
  corners?: number;
  fixtureDate: string;
  homeTeamName: string;
  awayTeamName: string;
}

// One row per player who appeared in the match (goals: 0 baseline), plus
// however many they actually scored. The 0-goal appearance rows matter as
// much as the scoring ones - without them, a player's "goals per game" rate
// would only ever be computed over games where they scored, which biases
// the rate upward (undercounts the denominator). Own goals are excluded
// (see the "own goal" text filter in fetchEspnGameStats) since crediting
// them to the scoring player would be wrong for a goalscorer market.
export interface EspnPlayerGoalStat {
  gameExternalId: string;
  playerExternalId: string;
  playerName: string;
  teamName: string;
  goals: number;
  fixtureDate: string;
  homeTeamName: string;
  awayTeamName: string;
}

export interface EspnGameStats {
  teamStats: EspnTeamCornerStat[];
  playerStats: EspnPlayerGoalStat[];
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

interface EspnEvent {
  id: string;
  date: string;
  status?: { type?: { completed?: boolean } };
}

async function fetchScoreboard(range: DateRange): Promise<EspnEvent[]> {
  const from = formatDate(range.startDate);
  const to = formatDate(range.endDate);
  try {
    const res = await fetch(`${BASE_URL}/scoreboard?dates=${from}-${to}`);
    if (!res.ok) {
      console.warn(`[espn-soccer-stats] scoreboard -> HTTP ${res.status}`);
      return [];
    }
    const json = (await res.json()) as { events?: EspnEvent[] };
    return json.events ?? [];
  } catch (err) {
    console.warn("[espn-soccer-stats] scoreboard failed:", err);
    return [];
  }
}

interface EspnBoxscoreTeam {
  homeAway: "home" | "away";
  team?: { id?: string; displayName?: string };
  statistics?: { name?: string; displayValue?: string }[];
}

interface EspnRosterAthlete {
  athlete?: { id?: string; fullName?: string; displayName?: string };
  active?: boolean;
}

interface EspnRosterTeam {
  team?: { displayName?: string };
  roster?: EspnRosterAthlete[];
}

interface EspnKeyEvent {
  scoringPlay?: boolean;
  text?: string;
  team?: { displayName?: string };
}

interface EspnSummary {
  boxscore?: { teams?: EspnBoxscoreTeam[] };
  rosters?: EspnRosterTeam[];
  keyEvents?: EspnKeyEvent[];
}

/**
 * Parses "Goal! England 0, Congo DR 1. Brian Cipenga (Congo DR) right footed
 * shot..." into the scorer's name. Text-based because ESPN's `keyEvents`
 * doesn't expose a structured scorer field (unlike `team`, which is
 * structured) - confirmed live against real 2026 World Cup key events.
 * Returns null for own goals: crediting an own goal to a "player scores a
 * goal" market would be wrong, so those are deliberately excluded rather
 * than guessed at.
 */
function parseGoalScorer(text: string | undefined): string | null {
  if (!text) return null;
  if (/own goal/i.test(text)) return null;
  const match = text.match(/\.\s+([A-Za-z][A-Za-z .'\-]*?)\s+\(([^)]+)\)/);
  return match ? match[1].trim() : null;
}

/**
 * Fetches team-corner and player-goal/appearance stats for every completed
 * World Cup fixture in `range` in a single pass - one `/scoreboard` request
 * to list events, then one `/summary?event=` request per completed fixture
 * (shared between both stat kinds, so this doesn't double the request count
 * versus fetching them separately).
 */
export async function fetchEspnGameStats(range: DateRange): Promise<EspnGameStats> {
  const events = await fetchScoreboard(range);
  const finished = events.filter((e) => e.status?.type?.completed);

  const teamStats: EspnTeamCornerStat[] = [];
  const playerStats: EspnPlayerGoalStat[] = [];

  for (const event of finished) {
    try {
      const res = await fetch(`${BASE_URL}/summary?event=${event.id}`);
      if (!res.ok) {
        console.warn(`[espn-soccer-stats] summary?event=${event.id} -> HTTP ${res.status}`);
        continue;
      }
      const summary = (await res.json()) as EspnSummary;
      const teams = summary.boxscore?.teams ?? [];
      const home = teams.find((t) => t.homeAway === "home");
      const away = teams.find((t) => t.homeAway === "away");
      if (!home?.team?.displayName || !away?.team?.displayName) continue;

      for (const t of teams) {
        if (!t.team?.displayName || !t.team.id) continue;
        const stat = t.statistics?.find((s) => s.name === "wonCorners");
        const corners = stat?.displayValue != null ? Number.parseFloat(stat.displayValue) : undefined;
        teamStats.push({
          gameExternalId: String(event.id),
          teamExternalId: t.team.id,
          teamName: t.team.displayName,
          corners: Number.isFinite(corners) ? corners : undefined,
          fixtureDate: event.date,
          homeTeamName: home.team.displayName,
          awayTeamName: away.team.displayName,
        });
      }

      // Baseline: every rostered player gets a 0-goal appearance row so the
      // per-player rate denominator (games observed) is accurate.
      const goalsByPlayer = new Map<string, EspnPlayerGoalStat>();
      for (const rosterTeam of summary.rosters ?? []) {
        const teamName = rosterTeam.team?.displayName;
        if (!teamName) continue;
        for (const entry of rosterTeam.roster ?? []) {
          const name = entry.athlete?.fullName ?? entry.athlete?.displayName;
          const id = entry.athlete?.id;
          if (!name || !id) continue;
          goalsByPlayer.set(id, {
            gameExternalId: String(event.id),
            playerExternalId: id,
            playerName: name,
            teamName,
            goals: 0,
            fixtureDate: event.date,
            homeTeamName: home.team.displayName,
            awayTeamName: away.team.displayName,
          });
        }
      }

      // Increment scorers found via keyEvents. Matched by name against the
      // roster built above (exact match on ESPN's own fullName/displayName
      // - both come from the same provider, so this is reliable, unlike
      // cross-provider name matching elsewhere in this codebase).
      for (const event_ of summary.keyEvents ?? []) {
        if (!event_.scoringPlay) continue;
        const scorerName = parseGoalScorer(event_.text);
        if (!scorerName) continue;
        const scorer = [...goalsByPlayer.values()].find(
          (p) => p.playerName === scorerName || p.playerName.endsWith(scorerName)
        );
        if (scorer) scorer.goals += 1;
      }

      playerStats.push(...goalsByPlayer.values());
    } catch (err) {
      console.warn(`[espn-soccer-stats] summary?event=${event.id} failed:`, err);
    }
  }
  return { teamStats, playerStats };
}

/** Back-compat wrapper for callers that only need corner stats. */
export async function fetchEspnTeamCornerStats(range: DateRange): Promise<EspnTeamCornerStat[]> {
  return (await fetchEspnGameStats(range)).teamStats;
}
