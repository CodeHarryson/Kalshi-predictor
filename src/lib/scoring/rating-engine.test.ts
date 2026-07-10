import { describe, it, expect, vi, beforeEach } from "vitest";

interface MockTx {
  teamRating: {
    upsert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  game: {
    update: ReturnType<typeof vi.fn>;
  };
}

vi.mock("@/lib/db", () => {
  const tx: MockTx = {
    teamRating: {
      upsert: vi.fn(async (args: { where: { teamId: string }; create?: { rating: number } }) => ({
        id: `r-${args.where.teamId}`,
        teamId: args.where.teamId,
        rating: args.create?.rating ?? 1500,
      })),
      update: vi.fn(async () => ({})),
    },
    game: {
      update: vi.fn(async () => ({})),
    },
  };
  const db = {
    game: {
      findMany: vi.fn(),
    },
    teamRating: {
      upsert: vi.fn(),
    },
    $transaction: vi.fn(async (fnOrArr: unknown) => {
      // interactive transaction form
      if (typeof fnOrArr === "function") {
        return (fnOrArr as (tx: MockTx) => Promise<unknown>)(tx);
      }
      // array form
      return Promise.all(fnOrArr as Promise<unknown>[]);
    }),
  };
  return { db, _tx: tx };
});

import { db } from "@/lib/db";
import { recomputeRatingsForLeague } from "./rating-engine";
import { DEFAULT_RATING } from "./elo";

const mockDb = db as unknown as {
  game: { findMany: ReturnType<typeof vi.fn> };
  teamRating: { upsert: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

function makeGame(id: string, homeTeamId: string, awayTeamId: string, homeScore: number, awayScore: number) {
  return {
    id,
    homeTeamId,
    awayTeamId,
    homeScore,
    awayScore,
    league: "NBA" as const,
    status: "FINAL" as const,
    ratingApplied: false,
    startTime: new Date(),
  };
}

describe("recomputeRatingsForLeague", () => {
  beforeEach(() => {
    mockDb.game.findMany.mockReset();
    mockDb.$transaction.mockClear();
  });

  it("applies rating exactly once per game (idempotent)", async () => {
    const game = makeGame("g1", "t1", "t2", 110, 100);
    mockDb.game.findMany.mockResolvedValue([game]);

    const applied = await recomputeRatingsForLeague("NBA");
    expect(applied).toBe(1);
    // interactive transaction was used
    expect(mockDb.$transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it("returns 0 when no games need applying", async () => {
    mockDb.game.findMany.mockResolvedValue([]);
    const applied = await recomputeRatingsForLeague("NBA");
    expect(applied).toBe(0);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("uses DEFAULT_RATING for new teams in the transaction", async () => {
    const game = makeGame("g1", "t-new", "t2", 110, 100);
    mockDb.game.findMany.mockResolvedValue([game]);

    // pull the tx from the imported module
    const { _tx } = (await import("@/lib/db")) as unknown as { _tx: MockTx };
    _tx.teamRating.upsert.mockImplementation((args: { where: { teamId: string }; create?: { rating: number } }) => {
      return Promise.resolve({ id: `r-${args.where.teamId}`, teamId: args.where.teamId, rating: args.create?.rating ?? 1500 });
    });
    _tx.teamRating.update.mockResolvedValue({});

    await recomputeRatingsForLeague("NBA");
    // verify the tx upsert was called with DEFAULT_RATING for the create branch
    const upsertCalls = _tx.teamRating.upsert.mock.calls;
    expect(upsertCalls.length).toBeGreaterThan(0);
    for (const call of upsertCalls) {
      const arg = call[0] as { create?: { rating: number } };
      if (arg.create) {
        expect(arg.create.rating).toBe(DEFAULT_RATING);
      }
    }
  });
});
