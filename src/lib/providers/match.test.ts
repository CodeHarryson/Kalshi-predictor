import { describe, expect, it } from "vitest";
import type { Game, Team } from "@/generated/prisma/client";
import { matchMarketByNames, matchMarketByTicker } from "./match";

const team = (name: string, shortName: string) => ({ name, shortName }) as Team;
const game = (id: string, start: string, home: Team, away: Team) =>
  ({ id, startTime: new Date(start), homeTeam: home, awayTeam: away }) as unknown as Game & {
    homeTeam: Team;
    awayTeam: Team;
  };

const wsu = team("Washington State Cougars", "WSU");
const boise = team("Boise State Broncos", "BOIS");
const mich = team("Michigan Wolverines", "MICH");
const miss = team("Michigan State Spartans", "MSU");
const indiana = team("Indiana Hoosiers", "IU");
const games = [
  game("g1", "2026-10-24T22:00:00Z", wsu, boise),
  game("g2", "2026-10-24T16:00:00Z", mich, indiana),
];
const close = new Date("2026-10-26T22:00:00Z");

describe("matchMarketByTicker", () => {
  it("matches on date + team codes in either order", () => {
    const g = [game("a", "2026-10-18T13:00:00Z", team("Leeds United FC", "LEE"), team("Manchester United FC", "MUN"))];
    expect(matchMarketByTicker("KXEPLGAME-26OCT18LEEMUN-LEE", g)?.id).toBe("a");
    expect(matchMarketByTicker("KXEPLGAME-26OCT18MUNLEE-TIE", g)?.id).toBe("a");
  });

  it("applies per-league aliases and rejects far-off dates", () => {
    const g = [game("b", "2026-10-31T16:00:00Z", team("FC Barcelona", "FCB"), team("Deportivo Alavés", "ALA"))];
    expect(matchMarketByTicker("KXLALIGAGAME-26OCT31BARALA-BAR", g, "LALIGA")?.id).toBe("b");
    expect(matchMarketByTicker("KXLALIGAGAME-26OCT31BARALA-BAR", g)).toBeNull();
    expect(matchMarketByTicker("KXLALIGAGAME-26NOV20BARALA-BAR", g, "LALIGA")).toBeNull();
  });
});

describe("matchMarketByNames", () => {
  it("matches sub-titles to team names, ignoring Tie and order", () => {
    expect(matchMarketByNames(["Boise State", "Washington State", "Tie"], close, games)?.id).toBe("g1");
    expect(matchMarketByNames(["Indiana", "Michigan"], close, games)?.id).toBe("g2");
  });

  it("returns null when ambiguous or incomplete", () => {
    const both = [...games, game("g3", "2026-10-24T20:00:00Z", miss, indiana)];
    // "Michigan" is also inside "Michigan State Spartans" -> two candidates -> no guess.
    expect(matchMarketByNames(["Indiana", "Michigan"], close, both)).toBeNull();
    expect(matchMarketByNames(["Indiana"], close, games)).toBeNull();
    expect(matchMarketByNames(["Indiana", "Boise State"], close, games)).toBeNull();
  });
});
