import { describe, it, expect } from "vitest";
import {
  shrinkRate,
  playerGoalProbAtLeast,
  teamCornerProbAtLeast,
  LEAGUE_PRIOR_PLAYER_GOALS_PER_GAME,
  LEAGUE_PRIOR_TEAM_CORNERS_PER_GAME,
} from "./prop-rate";

describe("shrinkRate", () => {
  it("with n=0 returns the prior", () => {
    const r = shrinkRate({
      totalEvents: 0,
      gamesObserved: 0,
      priorPerGame: 0.18,
      alpha: 5,
    });
    expect(r).toBeCloseTo(0.18, 10);
  });

  it("with large n converges to the empirical rate", () => {
    // 100 games, 30 goals → empirical rate 0.3. With alpha=5 and prior 0.18,
    // the shrunk rate is (100*0.3 + 5*0.18) / (100+5) = 30.9/105 ≈ 0.2943.
    // Close to 0.3 but not exactly — that's the whole point.
    const r = shrinkRate({
      totalEvents: 30,
      gamesObserved: 100,
      priorPerGame: 0.18,
      alpha: 5,
    });
    expect(r).toBeCloseTo(0.2943, 3);
  });

  it("with 1 game and 1 goal is shrunk toward the prior, not 1.0", () => {
    // Naive estimate would be 1.0 goals/game. Shrunken:
    //   (1 * 1.0 + 5 * 0.18) / (1 + 5) = 1.9 / 6 ≈ 0.317
    // Still closer to the prior (0.18) than to 1.0 — that's the win.
    const r = shrinkRate({
      totalEvents: 1,
      gamesObserved: 1,
      priorPerGame: 0.18,
      alpha: 5,
    });
    expect(r).toBeCloseTo(0.317, 2);
    expect(r).toBeLessThan(0.5); // shrunk, not naive
  });

  it("with 1 game and 1 goal differs from 3 games and 1 goal", () => {
    // 1 game, 1 goal: (1 + 5*0.18) / 6 = 0.317
    // 3 games, 1 goal: (3*0.333 + 5*0.18) / 8 = (1.0 + 0.9) / 8 = 0.237
    // The rate DECREASES as we see more games of zeros — exactly the
    // behavior we want, vs the naive estimator which would be 0.333
    // both times.
    const r1 = shrinkRate({
      totalEvents: 1,
      gamesObserved: 1,
      priorPerGame: 0.18,
      alpha: 5,
    });
    const r3 = shrinkRate({
      totalEvents: 1,
      gamesObserved: 3,
      priorPerGame: 0.18,
      alpha: 5,
    });
    expect(r1).toBeGreaterThan(r3);
  });

  it("returns 0 when both n=0 and alpha=0 (no information at all)", () => {
    expect(
      shrinkRate({
        totalEvents: 0,
        gamesObserved: 0,
        priorPerGame: 0.18,
        alpha: 0,
      })
    ).toBe(0);
  });

  it("throws on negative gamesObserved", () => {
    expect(() =>
      shrinkRate({
        totalEvents: 0,
        gamesObserved: -1,
        priorPerGame: 0.18,
        alpha: 5,
      })
    ).toThrow();
  });

  it("throws on negative alpha or prior", () => {
    expect(() =>
      shrinkRate({
        totalEvents: 0,
        gamesObserved: 0,
        priorPerGame: 0.18,
        alpha: -1,
      })
    ).toThrow();
    expect(() =>
      shrinkRate({
        totalEvents: 0,
        gamesObserved: 0,
        priorPerGame: -0.1,
        alpha: 5,
      })
    ).toThrow();
  });
});

describe("playerGoalProbAtLeast", () => {
  it("with no history returns P(>=1 goal) at the league prior", () => {
    // No games observed → rate = prior (0.18) → P(>=1) = 1 - e^-0.18
    const p = playerGoalProbAtLeast({
      totalGoalsObserved: 0,
      gamesObserved: 0,
      threshold: 0.5,
    });
    expect(p).toBeCloseTo(1 - Math.exp(-LEAGUE_PRIOR_PLAYER_GOALS_PER_GAME), 3);
    // Sanity: league-prior P(>=1 goal) is small but meaningful (~16-17%).
    expect(p).toBeGreaterThan(0.1);
    expect(p).toBeLessThan(0.25);
  });

  it("threshold 0.5+ rounds up to k=1, 1.5+ to k=2", () => {
    // With rate ~0.18 (no history), P(>=1) > P(>=2) — should hold.
    const p1 = playerGoalProbAtLeast({
      totalGoalsObserved: 0,
      gamesObserved: 0,
      threshold: 0.5,
    });
    const p2 = playerGoalProbAtLeast({
      totalGoalsObserved: 0,
      gamesObserved: 0,
      threshold: 1.5,
    });
    expect(p1).toBeGreaterThan(p2);
  });

  it("a player with 5 goals in 5 games gets a higher prob than the prior", () => {
    // 5 goals in 5 games → empirical rate 1.0 → shrunken:
    //   (5*1.0 + 5*0.18) / 10 = 0.59
    // P(>=1 | λ=0.59) ≈ 1 - e^-0.59 ≈ 0.446
    const p = playerGoalProbAtLeast({
      totalGoalsObserved: 5,
      gamesObserved: 5,
      threshold: 0.5,
    });
    const priorP = playerGoalProbAtLeast({
      totalGoalsObserved: 0,
      gamesObserved: 0,
      threshold: 0.5,
    });
    expect(p).toBeGreaterThan(priorP);
    expect(p).toBeLessThan(0.7); // shrunk, not naive 0.63 from raw rate=1.0
  });
});

describe("teamCornerProbAtLeast", () => {
  it("with no history returns P(>=threshold) at the league prior", () => {
    // rate = 5.2 corners/game → P(>=5) for threshold 4.5 (rounds to k=5)
    // ≈ 0.557
    const p = teamCornerProbAtLeast({
      totalCornersObserved: 0,
      gamesObserved: 0,
      threshold: 4.5,
    });
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.7);
  });

  it("threshold 9.5+ (k=10) on prior rate of 5.2 corners is rare", () => {
    // P(>=10 | λ=5.2) ≈ 0.034
    const p = teamCornerProbAtLeast({
      totalCornersObserved: 0,
      gamesObserved: 0,
      threshold: 9.5,
    });
    expect(p).toBeLessThan(0.1);
    expect(p).toBeGreaterThan(0);
  });

  it("a team with 8 corners in 1 game doesn't push P(>=5) above 0.99", () => {
    // Empirical rate 8.0. Shrunken: (1*8 + 3*5.2) / 4 = 5.9
    // P(>=5 | λ=5.9) ≈ 0.71. Without shrinkage, raw rate 8.0 → P(>=5) ≈ 0.90.
    const p = teamCornerProbAtLeast({
      totalCornersObserved: 8,
      gamesObserved: 1,
      threshold: 4.5,
    });
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThan(0.85);
  });

  it("is monotone in games observed for the same rate", () => {
    // 10 corners / 5 games (rate 2.0) should give a lower P(>=5) than
    // 50 corners / 5 games (rate 10.0) — same n, different rates.
    const lowP = teamCornerProbAtLeast({
      totalCornersObserved: 10,
      gamesObserved: 5,
      threshold: 4.5,
    });
    const highP = teamCornerProbAtLeast({
      totalCornersObserved: 50,
      gamesObserved: 5,
      threshold: 4.5,
    });
    expect(highP).toBeGreaterThan(lowP);
  });
});
