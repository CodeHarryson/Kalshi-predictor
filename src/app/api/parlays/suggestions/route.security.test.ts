import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Adversarial / boundary-case security tests for GET /api/parlays/suggestions.
 * These complement the basic auth-gate test in route.test.ts by probing
 * header casing, multi-header behavior, and the missing-env-var case.
 *
 * IMPORTANT: The H5 RSC boundary check is here — we confirm the route
 * returns 401 (not 200) without an admin token, and 200 with the right token.
 */

vi.mock("@/lib/builder", () => ({
  buildParlaySuggestions: vi.fn(async () => []),
}));

import { GET } from "@/app/api/parlays/suggestions/route";

const SECRET = "suggestions-security-test-secret";

function makeReq(opts: {
  token?: string | null;
  headerName?: string;
  league?: string | null;
} = {}): Request {
  const headers = new Headers();
  if (opts.token !== undefined && opts.token !== null) {
    const name = opts.headerName ?? "x-admin-token";
    headers.set(name, opts.token);
  }
  // Only emit ?league=... when opts.league was explicitly provided (and not null).
  // Default to no query string so callers can test the "no league" path.
  let qs = "";
  if (opts.league !== undefined) {
    qs = opts.league === null ? "" : `?league=${opts.league}`;
  }
  return new Request(`http://localhost/api/parlays/suggestions${qs}`, { headers });
}

describe("GET /api/parlays/suggestions — security boundaries (H5a RSC boundary)", () => {
  beforeEach(() => {
    process.env.ADMIN_TOKEN = SECRET;
  });

  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
  });

  // H5 RSC boundary: this is the smoke test for "is the route really gated?"
  it("H5 RSC boundary: returns 401 (not 200) without admin token", async () => {
    const res = await GET(makeReq({ token: null, league: "NFL" }));
    expect(res.status).toBe(401);
    // Body should not contain the protected payload
    const body = await res.json();
    expect(body).toEqual({ error: "Unauthorized" });
    expect(body).not.toHaveProperty("candidates");
  });

  it("H5 RSC boundary: returns 401 (not 200) with bad token", async () => {
    const res = await GET(makeReq({ token: "wrong", league: "NFL" }));
    expect(res.status).toBe(401);
  });

  it("H5 RSC boundary: returns 200 (positive case) with valid token", async () => {
    const res = await GET(makeReq({ token: SECRET, league: "NFL" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("candidates");
  });
});

describe("GET /api/parlays/suggestions — header abuse", () => {
  const ORIGINAL = process.env.ADMIN_TOKEN;
  beforeEach(() => {
    process.env.ADMIN_TOKEN = SECRET;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = ORIGINAL;
  });

  it("case-insensitive header matching: 'X-Admin-Token' header is accepted", async () => {
    // Node's Headers get() is case-insensitive per the Fetch spec.
    const res = await GET(makeReq({ token: SECRET, headerName: "X-Admin-Token", league: "NFL" }));
    expect(res.status).toBe(200);
  });

  it("wrong header name (e.g. 'authorization') is rejected", async () => {
    const res = await GET(makeReq({ token: SECRET, headerName: "authorization", league: "NFL" }));
    expect(res.status).toBe(401);
  });

  it("empty-string x-admin-token header is rejected as 401", async () => {
    const res = await GET(makeReq({ token: "", league: "NFL" }));
    expect(res.status).toBe(401);
  });

  it("whitespace-only x-admin-token is rejected (not equal to a real token)", async () => {
    const res = await GET(makeReq({ token: "   ", league: "NFL" }));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/parlays/suggestions — missing / misconfigured env", () => {
  const ORIGINAL = process.env.ADMIN_TOKEN;
  beforeEach(() => {
    delete process.env.ADMIN_TOKEN;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = ORIGINAL;
  });

  it("returns 503 when ADMIN_TOKEN is unset (NOT 200, NOT 401)", async () => {
    const res = await GET(makeReq({ token: "anything", league: "NFL" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "Service Unavailable" });
    expect(body).not.toHaveProperty("candidates");
  });

  it("returns 503 with empty-string ADMIN_TOKEN (treated as unset)", async () => {
    process.env.ADMIN_TOKEN = "";
    const res = await GET(makeReq({ token: "anything", league: "NFL" }));
    expect(res.status).toBe(503);
  });

  it("503 message does not leak 'ADMIN_TOKEN' or 'env' (defense in depth)", async () => {
    const res = await GET(makeReq({ token: "anything", league: "NFL" }));
    const body = await res.json();
    expect(body.error).not.toMatch(/ADMIN_TOKEN|env|configured/i);
  });
});

describe("GET /api/parlays/suggestions — invalid league returns 400 AFTER auth", () => {
  beforeEach(() => {
    process.env.ADMIN_TOKEN = SECRET;
  });
  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
  });

  it("returns 400 for missing league, even with a valid token", async () => {
    const res = await GET(makeReq({ token: SECRET, league: null }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown league string, even with a valid token", async () => {
    const res = await GET(makeReq({ token: SECRET, league: "FAKE_LEAGUE_XYZ" }));
    expect(res.status).toBe(400);
  });

  it("auth check runs FIRST — invalid league does NOT bypass the 401", async () => {
    // Even with a request that has a bad league, no token → 401, not 400.
    const res = await GET(makeReq({ token: null, league: "FAKE" }));
    expect(res.status).toBe(401);
  });
});
