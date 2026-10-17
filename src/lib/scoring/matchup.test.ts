import { describe, expect, it } from "vitest";
import { applyLogitShift, averageMarginFor, normalizeMargin, MARGIN_FORM, H2H_WEIGHT } from "./matchup";

const g = (h: string, a: string, hs: number | null, as: number | null) => ({
  homeTeamId: h,
  awayTeamId: a,
  homeScore: hs,
  awayScore: as,
});

describe("averageMarginFor", () => {
  it("measures the margin from the given team's side, home or away", () => {
    // A wins by 10 at home, then loses by 4 on the road: average +3.
    expect(averageMarginFor("A", [g("A", "B", 30, 20), g("C", "A", 24, 20)])).toBe(3);
    expect(averageMarginFor("B", [g("A", "B", 30, 20)])).toBe(-10);
  });

  it("ignores unscored games and games the team wasn't in; null when nothing counts", () => {
    expect(averageMarginFor("A", [g("A", "B", null, null), g("C", "D", 1, 0)])).toBeNull();
    expect(averageMarginFor("A", [])).toBeNull();
  });
});

describe("normalizeMargin", () => {
  it("scales by a typical margin and clamps blowouts", () => {
    expect(normalizeMargin(13, 13)).toBe(1);
    expect(normalizeMargin(-6.5, 13)).toBeCloseTo(-0.5);
    expect(normalizeMargin(200, 13)).toBe(2);
  });
});

describe("applyLogitShift", () => {
  it("is the identity at zero, and moves probability in the shift's direction", () => {
    expect(applyLogitShift(0.6, 0)).toBe(0.6);
    expect(applyLogitShift(0.6, 0.3)).toBeGreaterThan(0.6);
    expect(applyLogitShift(0.6, -0.3)).toBeLessThan(0.6);
    expect(applyLogitShift(0.5, 0.2)).toBeCloseTo(1 / (1 + Math.exp(-0.2)), 9);
  });

  it("stays a valid probability at the extremes", () => {
    expect(applyLogitShift(0.9999, 5)).toBeLessThan(1);
    expect(applyLogitShift(0.0001, -5)).toBeGreaterThan(0);
  });
});

describe("configuration", () => {
  it("keeps head-to-head at zero weight and the NBA margin term off (they didn't help out of sample)", () => {
    expect(H2H_WEIGHT).toEqual({});
    expect(MARGIN_FORM.NBA?.weight).toBe(0);
  });
});
