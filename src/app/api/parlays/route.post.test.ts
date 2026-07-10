import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(async () => []),
}));

vi.mock("@/lib/db", () => ({
  db: {
    game: { findMany: mocks.findMany },
    parlay: { findMany: mocks.findMany, findUnique: mocks.findMany },
    $transaction: vi.fn(async () => null),
  },
}));

import { POST } from "@/app/api/parlays/route";

const SECRET = "parlay-post-test-secret";
const makeReq = (token: string | null, body?: unknown): Request => {
  const headers = new Headers();
  if (token !== null) headers.set("x-admin-token", token);
  return new Request("http://localhost/api/parlays", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
};

describe("POST /api/parlays — auth gate (H4)", () => {
  beforeEach(() => {
    process.env.ADMIN_TOKEN = SECRET;
  });

  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
  });

  it("returns 401 with no token", async () => {
    const res = await POST(
      makeReq(null, { legs: [{ gameId: "g1", description: "d", side: "YES", predictedProbability: 0.5, features: {} }] })
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 with bad token", async () => {
    const res = await POST(
      makeReq("wrong", { legs: [{ gameId: "g1", description: "d", side: "YES", predictedProbability: 0.5, features: {} }] })
    );
    expect(res.status).toBe(401);
  });
});
