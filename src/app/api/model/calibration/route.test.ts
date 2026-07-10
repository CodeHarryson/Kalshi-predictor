import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/scoring/calibration", () => ({
  computeCalibration: vi.fn(async () => ({
    buckets: [],
    brierScore: null,
    sampleSize: 0,
  })),
}));

import { GET } from "@/app/api/model/calibration/route";

const SECRET = "calibration-test-secret";
const makeReq = (token: string | null, league: string | null): Request => {
  const headers = new Headers();
  if (token !== null) headers.set("x-admin-token", token);
  const qs = league === null ? "" : `?league=${league}`;
  return new Request(`http://localhost/api/model/calibration${qs}`, { headers });
};

describe("GET /api/model/calibration — auth gate (H5b)", () => {
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
    expect(body).toHaveProperty("buckets");
  });
});
