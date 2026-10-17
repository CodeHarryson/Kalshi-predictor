import { createEspnFootballProvider } from "./espn-football";

// 80 = FBS, 81 = FCS. Kalshi's KXNCAAFGAME series lists both (e.g. Lehigh vs
// Bucknell is FCS), so both are needed for markets to find their games. The
// teams endpoint ignores `groups` and returns every college team (D2/D3 too);
// games between teams we never see in a scoreboard are simply never created.
export const cfbProvider = createEspnFootballProvider({
  league: "CFB",
  sport: "college-football",
  groups: ["80", "81"],
  teamsLimit: 1000,
});
