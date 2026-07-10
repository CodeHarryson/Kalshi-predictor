import { describe, it, expect, beforeEach } from "vitest";
import {
  rateLimitResponse,
  rateLimitAction,
  __resetRateLimit,
} from "@/lib/rate-limit";

function makeReq(): Request {
  return new Request("http://localhost/test", {
    headers: { "x-forwarded-for": "203.0.113.5" },
  });
}

describe("rateLimitResponse", () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  it("first call to a fresh key returns null (allowed)", () => {
    const res = rateLimitResponse(
      { key: "GET /api/x", windowMs: 30_000, max: 1 },
      makeReq()
    );
    expect(res).toBeNull();
  });

  it("second call within the window returns 429", () => {
    const opts = { key: "GET /api/x", windowMs: 30_000, max: 1 };
    rateLimitResponse(opts, makeReq());
    const res = rateLimitResponse(opts, makeReq());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
  });

  it("call after window expires returns null (allowed again)", async () => {
    const opts = { key: "GET /api/x", windowMs: 5, max: 1 };
    rateLimitResponse(opts, makeReq());
    // Sleep just past the window. Use a real timer so the test is honest.
    await new Promise((r) => setTimeout(r, 15));
    const res = rateLimitResponse(opts, makeReq());
    expect(res).toBeNull();
  });

  it("different identity (per-IP) is isolated", () => {
    const opts = { key: "GET /api/x", windowMs: 30_000, max: 1 };
    const a = new Request("http://localhost/test", {
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    const b = new Request("http://localhost/test", {
      headers: { "x-forwarded-for": "2.2.2.2" },
    });
    expect(rateLimitResponse(opts, a)).toBeNull();
    expect(rateLimitResponse(opts, b)).toBeNull(); // different IP, fresh bucket
  });

  it("different key is isolated", () => {
    const a = { key: "GET /api/a", windowMs: 30_000, max: 1 };
    const b = { key: "GET /api/b", windowMs: 30_000, max: 1 };
    expect(rateLimitResponse(a, makeReq())).toBeNull();
    expect(rateLimitResponse(b, makeReq())).toBeNull();
  });

  it("explicit identity overrides IP-derived identity", () => {
    const opts = {
      key: "GET /api/x",
      windowMs: 30_000,
      max: 1,
      identity: "user-1",
    };
    expect(rateLimitResponse(opts, makeReq())).toBeNull();
    const res = rateLimitResponse(opts, makeReq());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
  });

  it("429 response includes a numeric Retry-After header", async () => {
    const opts = { key: "GET /api/x", windowMs: 30_000, max: 1 };
    rateLimitResponse(opts, makeReq());
    const res = rateLimitResponse(opts, makeReq());
    expect(res).not.toBeNull();
    const retry = res!.headers.get("Retry-After");
    expect(retry).not.toBeNull();
    expect(Number(retry)).toBeGreaterThanOrEqual(0);
  });
});

describe("rateLimitAction", () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  it("first call returns null (allowed)", () => {
    expect(
      rateLimitAction(
        { key: "action x", windowMs: 30_000, max: 1 },
        "token-abc"
      )
    ).toBeNull();
  });

  it("second call returns denial", () => {
    const opts = { key: "action x", windowMs: 30_000, max: 1 };
    rateLimitAction(opts, "token-abc");
    const res = rateLimitAction(opts, "token-abc");
    expect(res).not.toBeNull();
    expect(res).toEqual({ ok: false, error: "Too Many Requests" });
  });

  it("different tokens are isolated", () => {
    const opts = { key: "action x", windowMs: 30_000, max: 1 };
    rateLimitAction(opts, "token-a");
    expect(rateLimitAction(opts, "token-b")).toBeNull();
  });
});
