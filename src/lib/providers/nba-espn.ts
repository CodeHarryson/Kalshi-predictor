import { createEspnScoreboardProvider } from "./espn-scoreboard";

// NBA live data comes from balldontlie (nba.ts), which is rate-limited and
// needs a key. This ESPN provider is used only for history backfill
// (scripts/backfill-history.ts): its team and game ids differ from
// balldontlie's, so it is never part of the regular sync.
export const nbaEspnHistoryProvider = createEspnScoreboardProvider({
  league: "NBA",
  sport: "nba",
  sportGroup: "basketball",
  teamsLimit: 40,
});
