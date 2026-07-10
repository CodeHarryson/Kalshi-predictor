import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock db BEFORE importing the route. The gated route never reaches db when
// the token check fails, but the 200 path needs a stub.
vi.mock("@/lib/db", () => ({
  db: {
    parlay: {
      findMany: vi.fn(async () => []),
    },
  },
}));

import { GET } from "@/app/api/parlays/route";

const SECRET = "parlay-test-secret";
const makeReq = (token: string | null): Request => {
  const headers = new Headers();
  if (token !== null) headers.set("x-admin-token", token);
  return new Request("http://localhost/api/parlays", { headers });
};

describe("GET /api/parlays — auth gate (H4)", () => {
  beforeEach(() => {
    process.env.ADMIN_TOKEN = SECRET;
  });

  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
  });

  it("returns 401 with no token", async () => {
    const res = await GET(makeReq(null));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 401 with bad token", async () => {
    const res = await GET(makeReq("wrong"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid token", async () => {
    const res = await GET(makeReq(SECRET));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("parlays");
  });
});
