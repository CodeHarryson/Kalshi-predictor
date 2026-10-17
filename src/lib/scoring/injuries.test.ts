import { describe, expect, it } from "vitest";
import {
  availabilityLoss,
  footballImpactElo,
  MAX_TEAM_INJURY_ELO,
  nbaImpactElo,
  teamInjuryPenaltyElo,
} from "./injuries";

describe("availabilityLoss", () => {
  it("maps report statuses to a chance of missing the game", () => {
    expect(availabilityLoss("Out")).toBe(1);
    expect(availabilityLoss("Injured Reserve")).toBe(1);
    expect(availabilityLoss("Doubtful")).toBeGreaterThan(availabilityLoss("Questionable"));
    expect(availabilityLoss("Questionable")).toBeGreaterThan(availabilityLoss("Probable"));
    expect(availabilityLoss("Active")).toBe(0);
    expect(availabilityLoss("something new")).toBe(0);
  });
});

describe("nbaImpactElo", () => {
  it("values a high-minute scorer far above a bench player", () => {
    const star = nbaImpactElo({ minutesPerGame: 36, pointsPerGame: 28 });
    const starter = nbaImpactElo({ minutesPerGame: 30, pointsPerGame: 14 });
    const bench = nbaImpactElo({ minutesPerGame: 10, pointsPerGame: 3 });
    expect(star).toBeGreaterThan(starter);
    expect(starter).toBeGreaterThan(0);
    expect(bench).toBe(0);
  });

  it("is zero without stats (e.g. a rookie) rather than a guess", () => {
    expect(nbaImpactElo(null)).toBe(0);
  });
});

describe("footballImpactElo", () => {
  it("makes a starting QB matter far more than any other starter", () => {
    expect(footballImpactElo("NFL", "QB", true)).toBeGreaterThan(3 * footballImpactElo("NFL", "WR", true));
  });

  it("makes a backup nearly irrelevant and unknown depth a half-weight", () => {
    const starter = footballImpactElo("NFL", "QB", true);
    expect(footballImpactElo("NFL", "QB", false)).toBeCloseTo(starter * 0.1);
    expect(footballImpactElo("NFL", "QB", null)).toBeCloseTo(starter * 0.5);
  });

  it("ignores unknown positions", () => {
    expect(footballImpactElo("CFB", "XYZ", true)).toBe(0);
    expect(footballImpactElo("CFB", null, true)).toBe(0);
  });
});

describe("teamInjuryPenaltyElo", () => {
  it("is zero with no injuries and weights by availability", () => {
    expect(teamInjuryPenaltyElo([])).toBe(0);
    const sure = teamInjuryPenaltyElo([{ availabilityLoss: 1, impactElo: 100 }]);
    const maybe = teamInjuryPenaltyElo([{ availabilityLoss: 0.35, impactElo: 100 }]);
    expect(sure).toBeGreaterThan(maybe);
    expect(maybe).toBeGreaterThan(0);
  });

  it("has diminishing returns and never exceeds the cap", () => {
    const one = teamInjuryPenaltyElo([{ availabilityLoss: 1, impactElo: 100 }]);
    const two = teamInjuryPenaltyElo([
      { availabilityLoss: 1, impactElo: 100 },
      { availabilityLoss: 1, impactElo: 100 },
    ]);
    expect(two).toBeGreaterThan(one);
    expect(two).toBeLessThan(2 * one);
    expect(teamInjuryPenaltyElo([{ availabilityLoss: 1, impactElo: 1e6 }])).toBeLessThanOrEqual(MAX_TEAM_INJURY_ELO);
  });
});
