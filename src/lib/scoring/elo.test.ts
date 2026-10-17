import { describe, it, expect } from "vitest";
import {
  eloExpectedScore,
  matchOutcomeProbabilities,
  updateElo,
  resultToHomeScore,
  ELO_CONFIG,
  DEFAULT_RATING,
  marginMultiplier,
} from "./elo";

describe("margin of victory", () => {
  it("grows with the margin and is capped", () => {
    expect(marginMultiplier(20, 0, 30)).toBeGreaterThan(marginMultiplier(3, 0, 30));
    expect(marginMultiplier(100, 0, 30)).toBeCloseTo(marginMultiplier(30, 0, 30), 9);
  });

  it("is damped when the winner was already far stronger", () => {
    expect(marginMultiplier(14, 300, 30)).toBeLessThan(marginMultiplier(14, 0, 30));
    expect(marginMultiplier(14, -300, 30)).toBeGreaterThan(marginMultiplier(14, 0, 30));
  });

  it("makes a blowout move NFL ratings more than a one-point win, symmetrically", () => {
    const narrow = updateElo("NFL", 1500, 1500, 1, 1);
    const blowout = updateElo("NFL", 1500, 1500, 1, 28);
    expect(blowout.homeRating - 1500).toBeGreaterThan(narrow.homeRating - 1500);
    expect(blowout.homeRating - 1500).toBeCloseTo(1500 - blowout.awayRating, 9);
  });

  it("ignores the margin for leagues that don't use it (soccer) and when omitted", () => {
    expect(updateElo("EPL", 1500, 1500, 1, 5)).toEqual(updateElo("EPL", 1500, 1500, 1));
    expect(updateElo("NFL", 1500, 1500, 1)).toEqual(updateElo("NFL", 1500, 1500, 1, undefined));
  });
});

describe("eloExpectedScore", () => {
  it("returns 0.5 for equal ratings", () => {
    expect(eloExpectedScore(1500, 1500)).toBeCloseTo(0.5, 6);
  });
});

describe("matchOutcomeProbabilities", () => {
  it("NBA at equal ratings: no draw, home advantage applied", () => {
    const p = matchOutcomeProbabilities("NBA", 1500, 1500);
    expect(p.draw).toBe(0);
    // Equal ratings, so only the configured home bonus separates the sides.
    const expected = 1 / (1 + Math.pow(10, -ELO_CONFIG.NBA.homeAdvantage / 400));
    expect(p.homeWin).toBeCloseTo(expected, 6);
    expect(p.homeWin).toBeGreaterThan(0.5);
    expect(p.homeWin + p.awayWin).toBeCloseTo(1, 6);
  });

  it("EPL at equal ratings: home/away/draw sum to 1 with home edge", () => {
    const p = matchOutcomeProbabilities("EPL", 1500, 1500);
    // EPL home advantage pushes homeWin above 0.5; draw is the largest share
    expect(p.draw).toBeGreaterThan(0.2);
    expect(p.homeWin).toBeGreaterThan(p.awayWin);
    expect(p.homeWin + p.draw + p.awayWin).toBeCloseTo(1, 2);
  });

  it("probs sum to 1 for a heavy favorite EPL", () => {
    const p = matchOutcomeProbabilities("EPL", 1800, 1500);
    expect(p.homeWin + p.draw + p.awayWin).toBeCloseTo(1, 2);
    expect(p.homeWin).toBeGreaterThan(0.75);
  });

  it("probs sum to 1 for NFL at equal ratings (no draws)", () => {
    const p = matchOutcomeProbabilities("NFL", 1500, 1500);
    expect(p.draw).toBe(0);
    expect(p.homeWin + p.awayWin).toBeCloseTo(1, 6);
  });
});

describe("updateElo", () => {
  it("EPL equal teams, draw: home drops, away gains by same magnitude", () => {
    const cfg = ELO_CONFIG.EPL;
    const expectedHome = eloExpectedScore(1500 + cfg.homeAdvantage, 1500);
    const delta = cfg.k * (0.5 - expectedHome);
    const r = updateElo("EPL", 1500, 1500, 0.5);
    expect(r.homeRating).toBeCloseTo(1500 + delta, 6);
    expect(r.awayRating).toBeCloseTo(1500 - delta, 6);
    // home drops (under-performed as favorite due to homeAdvantage)
    expect(delta).toBeLessThan(0);
  });

  it("EPL equal teams, draw: delta is bounded by k in magnitude", () => {
    const cfg = ELO_CONFIG.EPL;
    const expectedHome = eloExpectedScore(1500 + cfg.homeAdvantage, 1500);
    const delta = cfg.k * (0.5 - expectedHome);
    expect(Math.abs(delta)).toBeLessThanOrEqual(cfg.k);
  });

  it("EPL heavy favorite, home win: rating change bounded by k", () => {
    const cfg = ELO_CONFIG.EPL;
    const r = updateElo("EPL", 1700, 1500, 1);
    const expectedHome = eloExpectedScore(1700 + cfg.homeAdvantage, 1500);
    const expectedDelta = cfg.k * (1 - expectedHome);
    expect(r.homeRating).toBeCloseTo(1700 + expectedDelta, 6);
    expect(r.awayRating).toBeCloseTo(1500 - expectedDelta, 6);
    // sanity: rating change can never exceed k
    expect(Math.abs(r.homeRating - 1700)).toBeLessThanOrEqual(cfg.k + 1e-9);
  });

  it("NBA equal teams, draw: home drops (homeAdvantage > 0)", () => {
    const cfg = ELO_CONFIG.NBA;
    const expectedHome = eloExpectedScore(1500 + cfg.homeAdvantage, 1500);
    const delta = cfg.k * (0.5 - expectedHome);
    const r = updateElo("NBA", 1500, 1500, 0.5);
    expect(r.homeRating).toBeCloseTo(1500 + delta, 6);
    expect(delta).toBeLessThan(0);
  });
});

describe("resultToHomeScore", () => {
  it("returns 1 for home win", () => expect(resultToHomeScore(3, 1)).toBe(1));
  it("returns 0 for away win", () => expect(resultToHomeScore(1, 3)).toBe(0));
  it("returns 0.5 for draw", () => expect(resultToHomeScore(2, 2)).toBe(0.5));
});

describe("ELO_CONFIG + DEFAULT_RATING", () => {
  it("every league has a positive k and a non-negative homeAdvantage", () => {
    for (const league of Object.keys(ELO_CONFIG) as Array<keyof typeof ELO_CONFIG>) {
      expect(ELO_CONFIG[league].k).toBeGreaterThan(0);
      expect(ELO_CONFIG[league].homeAdvantage).toBeGreaterThanOrEqual(0);
    }
  });
  it("DEFAULT_RATING is 1500", () => {
    expect(DEFAULT_RATING).toBe(1500);
  });
});
