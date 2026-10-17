import { createEspnFootballProvider } from "./espn-football";

export const nflProvider = createEspnFootballProvider({
  league: "NFL",
  sport: "nfl",
  teamsLimit: 40,
});
