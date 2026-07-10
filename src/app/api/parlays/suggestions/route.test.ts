import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/builder", () => ({
  buildParlaySuggestions: vi.fn(async () => []),
}));

import { GET } from "@/app/api/parlays/suggestions/route";

const SECRET = "suggestions-test-secret";
const makeReq = (token: string | null, league: string | null): Request => {
  const headers = new Headers();
  if (token !== null) headers.set("x-admin-token", token);
  const qs = league === null ? "" : `?league=${league}`;
  return new Request(`http://localhost/api/parlays/suggestions${qs}`, { headers });
};

describe("GET /api/parlays/suggestions — auth gate (H5a)", () => {
  beforeEach(() => {
    process.env.ADMIN_TOKEN = SECRET;
  });

  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
  });

  it("returns 401 with no token", async () => {
    const res = await GET(makeReq(null, "NFL"));
    expect(res.status).toBe(401);
  });

  it("returns 401 with bad token", async () => {
    const res = await GET(makeReq("wrong", "NFL"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid token and valid league", async () => {
    const res = await GET(makeReq(SECRET, "NFL"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("candidates");
  });
});
