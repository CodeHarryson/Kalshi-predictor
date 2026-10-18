import { describe, expect, it } from "vitest";
import {
  placeAsPick,
  enumerateDistinctGameCombos,
  growthRate,
  MODEL_TRUST,
  rankAggressiveParlays,
  rankBestParlays,
  shrinkToMarket,
} from "./best-parlay";
import type { CandidateLeg } from "./builder";

const leg = (id: string, game: string | null, model: number, market: number): CandidateLeg => ({
  gameId: game,
  kalshiMarketId: id,
  description: id,
  side: "YES",
  legKind: "GAME_WINNER",
  predictedProbability: model,
  marketImpliedProbability: market,
  edge: model - market,
  features: { baseProbability: model },
  startTime: "2026-10-18T18:00:00.000Z",
});

describe("shrinkToMarket", () => {
  it("pulls the model toward the market by the trust factor", () => {
    expect(shrinkToMarket(0.8, 0.6, 1)).toBeCloseTo(0.8);
    expect(shrinkToMarket(0.8, 0.6, 0)).toBeCloseTo(0.6);
    expect(shrinkToMarket(0.8, 0.6)).toBeCloseTo(0.6 + MODEL_TRUST * 0.2);
    expect(shrinkToMarket(0.4, 0.6)).toBeLessThan(0.6);
  });
});

describe("growthRate", () => {
  it("is zero with no edge and positive with one", () => {
    expect(growthRate(0.5, 0.5)).toBe(0);
    expect(growthRate(0.4, 0.5)).toBe(0);
    expect(growthRate(0.6, 0.5)).toBeGreaterThan(0);
  });

  it("grows with the edge, and is guarded against degenerate prices", () => {
    expect(growthRate(0.7, 0.5)).toBeGreaterThan(growthRate(0.6, 0.5));
    expect(growthRate(0.9, 0)).toBe(0);
    expect(growthRate(1, 0.5)).toBe(0);
  });
});

describe("enumerateDistinctGameCombos", () => {
  it("never puts two legs from one game in a combo, or uses gameless legs", () => {
    const pool = [leg("a", "g1", 0.7, 0.5), leg("b", "g1", 0.7, 0.5), leg("c", "g2", 0.7, 0.5), leg("d", null, 0.7, 0.5)];
    const combos = enumerateDistinctGameCombos(pool, 2);
    expect(combos.map((c) => c.map((l) => l.kalshiMarketId).join(""))).toEqual(["ac", "bc"]);
  });
});

describe("rankBestParlays", () => {
  it("returns nothing when no leg keeps an edge after shrinking", () => {
    // Raw edge of 1 point shrinks to 0.5: still positive, so use a negative edge.
    const out = rankBestParlays([leg("a", "g1", 0.5, 0.6), leg("b", "g2", 0.5, 0.6)]);
    expect(out.best).toBeNull();
  });

  it("needs at least two games to form a parlay", () => {
    expect(rankBestParlays([leg("a", "g1", 0.8, 0.5)]).best).toBeNull();
  });

  it("picks the combo with the most growth and excludes same-game pairs", () => {
    const out = rankBestParlays([
      leg("big", "g1", 0.9, 0.6),
      leg("alt-same-game", "g1", 0.95, 0.6), // can't pair with `big`
      leg("good", "g2", 0.8, 0.6),
      leg("meh", "g3", 0.62, 0.6),
    ]);
    expect(out.best).not.toBeNull();
    const ids = out.best!.legs.map((l) => l.kalshiMarketId);
    expect(new Set(out.best!.legs.map((l) => l.gameId)).size).toBe(ids.length);
    expect(out.best!.growth).toBeGreaterThan(0);
    expect(out.best!.edge).toBeGreaterThan(0);
    for (const alt of out.alternatives) expect(alt.growth).toBeLessThanOrEqual(out.best!.growth);
  });

  it("ranks on shrunk, not raw, probability: a huge raw gap is discounted", () => {
    const out = rankBestParlays([
      leg("noisy-a", "g1", 0.95, 0.5), // raw edge 45 points
      leg("noisy-b", "g2", 0.95, 0.5),
      leg("steady-a", "g3", 0.72, 0.62), // raw edge 10 points
      leg("steady-b", "g4", 0.72, 0.62),
    ]);
    const b = out.best!;
    // Shrunk probability sits between the market and the model, never beyond the model.
    expect(b.shrunkProbability).toBeLessThan(b.modelProbability);
    expect(b.shrunkProbability).toBeGreaterThan(b.marketImplied);
  });
});

describe("placeAsPick", () => {
  it("restates a NOT-to-win pick as the other team to win", () => {
    expect(placeAsPick("Dallas Cowboys @ Green Bay Packers — Dallas Cowboys NOT to win")).toBe("Green Bay Packers to win");
    expect(placeAsPick("Los Angeles Chargers @ Kansas City Chiefs — Kansas City Chiefs NOT to win")).toBe("Los Angeles Chargers to win");
  });

  it("leaves other picks alone", () => {
    expect(placeAsPick("Dallas Cowboys @ Green Bay Packers — Green Bay Packers to win")).toBeNull();
    expect(placeAsPick("Real Madrid CF — No draw")).toBeNull();
    expect(placeAsPick("A @ B — C NOT to win")).toBeNull();
  });
});

describe("rankAggressiveParlays", () => {
  it("only uses underdog legs, in combos of 3+ distinct games", () => {
    const out = rankAggressiveParlays([
      leg("fav", "g1", 0.9, 0.8), // favorite: excluded
      leg("d1", "g2", 0.5, 0.35),
      leg("d2", "g3", 0.45, 0.3),
      leg("d3", "g4", 0.4, 0.28),
      leg("d4", "g5", 0.42, 0.3),
    ]);
    expect(out.best).not.toBeNull();
    const ids = out.best!.legs.map((l) => l.kalshiMarketId);
    expect(ids).not.toContain("fav");
    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(out.best!.expectedReturn).toBeGreaterThan(0);
  });

  it("returns nothing when the win chance is below the floor or fewer than 3 games", () => {
    expect(rankAggressiveParlays([leg("a", "g1", 0.5, 0.35), leg("b", "g2", 0.5, 0.35)]).best).toBeNull();
    const tiny = [1, 2, 3].map((i) => leg(`t${i}`, `g${i}`, 0.12, 0.05));
    expect(rankAggressiveParlays(tiny).best).toBeNull();
  });
});
