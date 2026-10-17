import { createEspnScoreboardProvider } from "./espn-scoreboard";

export const nflProvider = createEspnScoreboardProvider({
  league: "NFL",
  sport: "nfl",
  teamsLimit: 40,
});
