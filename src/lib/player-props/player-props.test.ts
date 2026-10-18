import { describe, expect, it } from "vitest";
import { MIN_GAMES, probAtLeast } from "./model";
import { normalizeName, parsePlayerPropTitle, propLegLabel, statFor } from "./stats";
import { capPerGame } from "../best-parlay";
import type { CandidateLeg } from "../builder";

describe("probAtLeast", () => {
  const steady = [24, 26, 22, 25, 27, 23, 24, 26, 25, 24];

  it("needs a minimum sample", () => {
    expect(probAtLeast(steady.slice(0, MIN_GAMES - 1), 20)).toBeNull();
  });

  it("is high well below the typical line, low well above it, and monotone", () => {
    expect(probAtLeast(steady, 15)!).toBeGreaterThan(0.95);
    expect(probAtLeast(steady, 35)!).toBeLessThan(0.05);
    expect(probAtLeast(steady, 22)!).toBeGreaterThan(probAtLeast(steady, 25)!);
    expect(probAtLeast(steady, 25)!).toBeGreaterThan(probAtLeast(steady, 28)!);
  });

  it("weights recent games more", () => {
    const rising = [30, 30, 30, 30, 10, 10, 10, 10, 10, 10];
    const falling = [...rising].reverse();
    expect(probAtLeast(rising, 25)!).toBeGreaterThan(probAtLeast(falling, 25)!);
  });

  it("uses a Poisson for touchdown counts", () => {
    const tds = [1, 0, 1, 0, 0, 1, 0, 1, 0, 0]; // 0.4 per game
    const p1 = probAtLeast(tds, 1, true)!;
    expect(p1).toBeGreaterThan(0.25);
    expect(p1).toBeLessThan(0.45);
    expect(probAtLeast(tds, 2, true)!).toBeLessThan(p1);
  });
});

describe("player prop parsing", () => {
  it("reads name and threshold from a Kalshi sub-title", () => {
    expect(parsePlayerPropTitle("Victor Wembanyama: 35+")).toEqual({ name: "Victor Wembanyama", threshold: 35 });
    expect(parsePlayerPropTitle("Tyrone Tracy Jr.: 4+")).toEqual({ name: "Tyrone Tracy Jr.", threshold: 4 });
    expect(parsePlayerPropTitle("Victor Wembanyama: Double Double")).toBeNull();
    expect(parsePlayerPropTitle(undefined)).toBeNull();
  });

  it("normalizes names across feeds", () => {
    expect(normalizeName("Tyrone Tracy Jr.")).toBe(normalizeName("Tyrone Tracy"));
    expect(normalizeName("Nikola Jokić")).toBe("nikola jokic");
    expect(normalizeName("Amon-Ra St. Brown")).toBe("amon ra st brown");
  });

  it("reads the right stat per kind", () => {
    expect(statFor("PLAYER_POINTS", { points: 31 })).toBe(31);
    expect(statFor("PLAYER_REBOUNDS", { totalRebounds: 9 })).toBe(9);
    expect(statFor("PLAYER_TDS", { rushingTouchdowns: 1, receivingTouchdowns: 2 })).toBe(3);
    expect(statFor("PLAYER_TDS", { rushingTouchdowns: 1 })).toBe(1);
    expect(statFor("PLAYER_TDS", { passingYards: 200 })).toBeNull();
    expect(statFor("PLAYER_PASS_YDS", { points: 3 })).toBeNull();
  });

  it("words legs both ways", () => {
    expect(propLegLabel("PLAYER_POINTS", 25, "YES")).toBe("25+ points");
    expect(propLegLabel("PLAYER_REC_YDS", 60, "NO")).toBe("under 60 receiving yards");
  });
});

describe("capPerGame", () => {
  const leg = (id: string, game: string, edge: number) => ({ kalshiMarketId: id, gameId: game, edge }) as CandidateLeg;
  it("keeps each game's best legs only", () => {
    const out = capPerGame([leg("a", "g1", 0.1), leg("b", "g1", 0.3), leg("c", "g1", 0.2), leg("d", "g2", 0.05)], 2);
    expect(out.map((l) => l.kalshiMarketId)).toEqual(["b", "c", "d"]);
  });
});
