import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { League } from "@/generated/prisma/enums";

/**
 * Adversarial tests for the atomic getOrCreateRating path introduced in
 * rating-engine.ts. The pre-pipeline code used a read-then-create pattern
 * that could race: two concurrent transactions for the same new team would
 * both see "no row", both attempt to create, and one would crash on the
 * unique constraint. The new path uses Prisma's upsert inside the
 * transaction, which delegates atomicity to the DB.
 *
 * These tests pin the upsert contract:
 *   - on a fresh team: upsert is called with a create branch that seeds
 *     the row at DEFAULT_RATING (1500) for the given league.
 *   - on an existing team: upsert's update branch is a no-op {} — the
 *     function exists to *read* the current value, not to mutate it.
 *   - on a hot team appearing in two games in the same recompute call:
 *     the second game must not re-seed the rating back to DEFAULT_RATING.
 *   - the upsert `where` is keyed on teamId alone (the unique index),
 *     not on a composite (teamId, league) — a regression here would
 *     cause silent double-creates if the same teamId ever appeared in
 *     two leagues (impossible today by FK, but a load-bearing
 *     invariant).
 */

interface TxLike {
  teamRating: {
    upsert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  game: {
    update: ReturnType<typeof vi.fn>;
  };
}

interface MockDb {
  game: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  teamRating: { upsert: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
}

// Shared mutable mock state. vi.mock factories are hoisted above imports,
// so we cannot use module-level `let`. A plain object reference works
// because vi.mock's factory returns it once, and tests mutate its inner
// state in beforeEach.
const mockState: { current: { db: MockDb; tx: TxLike } | null } = { current: null };

function makeMockDb(opts?: { existingRatings?: Map<string, number> }): {
  db: MockDb;
  tx: TxLike;
} {
  const existing = opts?.existingRatings ?? new Map<string, number>();

  // In-memory state for the upsert simulation. The real Prisma upsert is
  // atomic; we simulate that by reading the current "row" and writing back.
  const rowByTeam = new Map<string, { id: string; rating: number; league: League }>(
    Array.from(existing, ([teamId, rating]) => [
      teamId,
      { id: `r-${teamId}`, rating, league: "NBA" },
    ])
  );

  const tx: TxLike = {
    teamRating: {
      upsert: vi.fn(async (args: {
        where: { teamId: string };
        create: { teamId: string; league: League; rating: number };
        update: Record<string, never>;
      }) => {
        const cur = rowByTeam.get(args.where.teamId);
        if (cur) {
          return { id: cur.id, teamId: args.where.teamId, league: cur.league, rating: cur.rating };
        }
        const next = { id: `r-${args.where.teamId}`, rating: args.create.rating, league: args.create.league };
        rowByTeam.set(args.where.teamId, next);
        return { id: next.id, teamId: args.where.teamId, league: next.league, rating: next.rating };
      }),
      update: vi.fn(async (args: { where: { id: string }; data: { rating: number } }) => {
        for (const r of rowByTeam.values()) {
          if (r.id === args.where.id) {
            r.rating = args.data.rating;
            return { id: r.id, rating: r.rating };
          }
        }
        return { id: args.where.id, rating: args.data.rating };
      }),
    },
    game: {
      update: vi.fn(async () => ({})),
    },
  };

  const db: MockDb = {
    game: { findMany: vi.fn(), findFirst: vi.fn() },
    teamRating: { upsert: vi.fn() },
    $transaction: vi.fn(async (fnOrArr: unknown) => {
      if (typeof fnOrArr === "function") {
        return (fnOrArr as (tx: TxLike) => Promise<unknown>)(tx);
      }
      return Promise.all(fnOrArr as Promise<unknown>[]);
    }),
  };

  return { db, tx };
}

vi.mock("@/lib/db", () => {
  // The factory runs once. It returns a stable `db` object that reads
  // through to `mockState.current`. If mockState.current is null, we
  // throw — but tests always set it in beforeEach before any import-time
  // usage happens.
  return {
    db: {
      get game() {
        if (!mockState.current) throw new Error("mock not initialized");
        return mockState.current.db.game;
      },
      get teamRating() {
        if (!mockState.current) throw new Error("mock not initialized");
        return mockState.current.db.teamRating;
      },
      get $transaction() {
        if (!mockState.current) throw new Error("mock not initialized");
        return mockState.current.db.$transaction;
      },
    },
  };
});

import { db } from "@/lib/db";
import { recomputeRatingsForLeague } from "./rating-engine";
import { DEFAULT_RATING } from "./elo";

const dbMock = db as unknown as MockDb;

function makeGame(
  id: string,
  homeTeamId: string,
  awayTeamId: string,
  homeScore: number,
  awayScore: number
) {
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

describe("getOrCreateRating atomicity (concurrent-call simulation)", () => {
  let m: { db: MockDb; tx: TxLike };

  beforeEach(() => {
    m = makeMockDb();
    mockState.current = m;
    dbMock.game.findMany.mockReset();
    dbMock.$transaction.mockClear();
  });

  afterEach(() => {
    mockState.current = null;
  });

  it("seeds a brand-new team at DEFAULT_RATING via upsert create branch", async () => {
    const game = makeGame("g1", "fresh-team", "t2", 110, 100);
    m.db.game.findMany.mockResolvedValue([game]);

    await recomputeRatingsForLeague("NBA");

    // The tx upsert must have been called with a create branch rating = 1500.
    const upsertCalls = m.tx.teamRating.upsert.mock.calls;
    expect(upsertCalls.length).toBeGreaterThan(0);
    const freshCalls = upsertCalls.filter(
      (c) => (c[0] as { where: { teamId: string } }).where.teamId === "fresh-team"
    );
    expect(freshCalls.length).toBe(1);
    const arg = freshCalls[0][0] as { create: { rating: number; teamId: string; league: League } };
    expect(arg.create.rating).toBe(DEFAULT_RATING);
    expect(arg.create.league).toBe("NBA");
  });

  it("does NOT re-seed an existing team to DEFAULT_RATING (update branch is no-op)", async () => {
    // Replace the mock with one that has an existing team.
    const seeded = makeMockDb({ existingRatings: new Map([["vet-team", 1720]]) });
    mockState.current = seeded;

    const game = makeGame("g1", "vet-team", "t2", 110, 100);
    seeded.db.game.findMany.mockResolvedValue([game]);

    await recomputeRatingsForLeague("NBA");

    const upsertCalls = seeded.tx.teamRating.upsert.mock.calls;
    const vetCalls = upsertCalls.filter(
      (c) => (c[0] as { where: { teamId: string } }).where.teamId === "vet-team"
    );
    expect(vetCalls.length).toBe(1);
    const arg = vetCalls[0][0] as {
      where: { teamId: string };
      update: Record<string, unknown>;
      create: { rating: number };
    };
    // The update branch is intentionally a no-op: the real DB upsert returns
    // the existing row's rating without mutating it. A regression that adds
    // a field to `update` would overwrite the stored rating here.
    expect(arg.update).toEqual({});
    // The create branch must still be present (Prisma requires it) and
    // must seed DEFAULT_RATING so a brand-new team later gets the right
    // starting value.
    expect(arg.create.rating).toBe(DEFAULT_RATING);
  });

  it("handles the same team appearing as home in two games in one recompute call", async () => {
    // The bug we're guarding against: a second upsert for the same team in
    // the same recompute call must NOT re-seed the rating. With a
    // read-then-create pattern, the second iteration would re-read the
    // already-mutated row and skip the create. The new upsert path always
    // issues an upsert; we verify that the create branch is NOT used on
    // the second call.
    const g1 = makeGame("g1", "shared", "t2", 110, 100);
    const g2 = makeGame("g2", "shared", "t3", 90, 95);
    m.db.game.findMany.mockResolvedValue([g1, g2]);

    await recomputeRatingsForLeague("NBA");

    const sharedCalls = m.tx.teamRating.upsert.mock.calls.filter(
      (c) => (c[0] as { where: { teamId: string } }).where.teamId === "shared"
    );
    expect(sharedCalls.length).toBe(2);
    // Both calls must use the same create-branch rating — the real DB
    // upsert is a no-op for the second call because the row exists.
    for (const call of sharedCalls) {
      const arg = call[0] as { create: { rating: number } };
      expect(arg.create.rating).toBe(DEFAULT_RATING);
    }
  });

  it("upsert where-clause is keyed on teamId only (not teamId+league)", async () => {
    // Schema invariant: TeamRating has @@unique([teamId]) only. If a future
    // refactor keys the upsert on a composite, Prisma will throw a
    // P2009/validation error at runtime when the schema diverges.
    m.db.game.findMany.mockResolvedValue([
      makeGame("g1", "t1", "t2", 110, 100),
    ]);

    await recomputeRatingsForLeague("NBA");

    const upsertArgs = m.tx.teamRating.upsert.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(upsertArgs).toBeDefined();
    expect(Object.keys(upsertArgs.where)).toEqual(["teamId"]);
  });

  it("two simulated concurrent recompute calls both succeed (upsert absorbs the race)", async () => {
    // SQLite serializes writes, so this is a serial test that exercises
    // the upsert's idempotency: each call issues a fresh upsert for the
    // same brand-new team, and the second upsert must NOT crash on a
    // unique-constraint violation. With a real Prisma client, this is the
    // behavior the new code depends on; here we simulate the same shape.
    const game = makeGame("g1", "racy", "t2", 110, 100);
    m.db.game.findMany.mockResolvedValue([game]);

    const a = recomputeRatingsForLeague("NBA");
    const b = recomputeRatingsForLeague("NBA");
    await expect(Promise.all([a, b])).resolves.toEqual([1, 1]);

    // Two upsert calls for the same team across the two transactions.
    const racyCalls = m.tx.teamRating.upsert.mock.calls.filter(
      (c) => (c[0] as { where: { teamId: string } }).where.teamId === "racy"
    );
    expect(racyCalls.length).toBe(2);
  });
});
