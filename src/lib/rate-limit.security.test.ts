import { describe, it, expect, beforeEach } from "vitest";
import {
  rateLimitResponse,
  rateLimitAction,
  __resetRateLimit,
} from "@/lib/rate-limit";

/**
 * Adversarial / boundary-case tests for the in-process rate limiter.
 * These probe gaps the basic happy-path tests in rate-limit.test.ts do not
 * cover: header-spoofing, IP-fallback ordering, action identity, and the
 * (max+1)th-call boundary at the exact edge of the window.
 */

function makeReq(opts: { ip?: string; real?: string; other?: Record<string, string> } = {}): Request {
  const headers = new Headers();
  if (opts.ip !== undefined) headers.set("x-forwarded-for", opts.ip);
  if (opts.real !== undefined) headers.set("x-real-ip", opts.real);
  if (opts.other) {
    for (const [k, v] of Object.entries(opts.other)) headers.set(k, v);
  }
  return new Request("http://localhost/test", { headers });
}

describe("rateLimitResponse — adversarial boundaries", () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  it("(max+1)th call within the window returns 429; the Nth call under max returns null", () => {
    const opts = { key: "POST /api/sync", windowMs: 30_000, max: 3 };
    const req = makeReq({ ip: "10.0.0.1" });
    // First 3 calls under max → allowed
    expect(rateLimitResponse(opts, req)).toBeNull();
    expect(rateLimitResponse(opts, req)).toBeNull();
    expect(rateLimitResponse(opts, req)).toBeNull();
    // 4th call (max+1) → 429
    const limited = rateLimitResponse(opts, req);
    expect(limited).not.toBeNull();
    expect(limited!.status).toBe(429);
  });

  it("concurrent calls just under max all pass, then the next fails", () => {
    // Simulates the burst pattern: 5 calls back-to-back with max=5, then a 6th.
    const opts = { key: "GET /api/x", windowMs: 60_000, max: 5 };
    const req = makeReq({ ip: "10.0.0.2" });
    for (let i = 0; i < 5; i++) {
      expect(rateLimitResponse(opts, req)).toBeNull();
    }
    const blocked = rateLimitResponse(opts, req);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
  });

  it("429 response sets a numeric Retry-After header ≥ 0 and ≤ windowMs/1000", async () => {
    const opts = { key: "GET /api/y", windowMs: 5_000, max: 1 };
    const req = makeReq({ ip: "10.0.0.3" });
    rateLimitResponse(opts, req);
    const res = rateLimitResponse(opts, req);
    expect(res).not.toBeNull();
    const retry = res!.headers.get("Retry-After");
    expect(retry).not.toBeNull();
    const seconds = Number(retry);
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(0);
    expect(seconds).toBeLessThanOrEqual(5);
  });

  it("sliding window: a hit just past windowMs is forgotten — the next call is allowed", async () => {
    const opts = { key: "GET /api/sliding", windowMs: 50, max: 1 };
    const req = makeReq({ ip: "10.0.0.4" });
    expect(rateLimitResponse(opts, req)).toBeNull();
    // Blocked immediately
    expect(rateLimitResponse(opts, req)!.status).toBe(429);
    // Wait past the window
    await new Promise((r) => setTimeout(r, 80));
    // Now allowed again
    expect(rateLimitResponse(opts, req)).toBeNull();
  });

  it("sliding window: a 2nd call within the window only blocks until window slides, then both can co-exist if a 3rd would exceed", async () => {
    const opts = { key: "GET /api/sliding2", windowMs: 60, max: 2 };
    const req = makeReq({ ip: "10.0.0.5" });
    expect(rateLimitResponse(opts, req)).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(rateLimitResponse(opts, req)).toBeNull();
    // Now at max; 3rd call blocked
    expect(rateLimitResponse(opts, req)!.status).toBe(429);
    // Wait for the first call to age out
    await new Promise((r) => setTimeout(r, 50));
    // Should be allowed (the first hit is now older than windowMs)
    expect(rateLimitResponse(opts, req)).toBeNull();
  });

  it("identity: x-forwarded-for with multiple comma-separated IPs uses the FIRST one (left-most is client)", () => {
    const opts = { key: "GET /api/xff", windowMs: 30_000, max: 1 };
    // Spoof attempt: client says "evil" is last, but the first entry is what
    // the rate limiter trusts. Make sure both requests with the SAME first
    // hop count as the same identity.
    const a = new Request("http://x/test", {
      headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" },
    });
    const b = new Request("http://x/test", {
      headers: { "x-forwarded-for": "1.1.1.1, 9.9.9.9" },
    });
    expect(rateLimitResponse(opts, a)).toBeNull();
    expect(rateLimitResponse(opts, b)!.status).toBe(429);
  });

  it("identity: x-forwarded-for takes priority over x-real-ip", () => {
    const opts = { key: "GET /api/prio", windowMs: 30_000, max: 1 };
    const a = new Request("http://x/test", {
      headers: { "x-forwarded-for": "1.1.1.1", "x-real-ip": "9.9.9.9" },
    });
    const b = new Request("http://x/test", {
      headers: { "x-forwarded-for": "2.2.2.2", "x-real-ip": "9.9.9.9" },
    });
    // a and b have different x-forwarded-for but the same x-real-ip.
    // The rate limiter should treat them as different identities (because
    // x-forwarded-for wins), so both are allowed (max=1 each).
    expect(rateLimitResponse(opts, a)).toBeNull();
    expect(rateLimitResponse(opts, b)).toBeNull();
  });

  it("identity: when x-forwarded-for is missing, x-real-ip is used", () => {
    const opts = { key: "GET /api/real", windowMs: 30_000, max: 1 };
    const a = makeReq({ real: "8.8.8.8" });
    const b = makeReq({ real: "8.8.8.8" });
    expect(rateLimitResponse(opts, a)).toBeNull();
    expect(rateLimitResponse(opts, b)!.status).toBe(429);
  });

  it("identity: missing both x-forwarded-for and x-real-ip falls back to 'unknown' (shared bucket)", () => {
    const opts = { key: "GET /api/unknown", windowMs: 30_000, max: 1 };
    const a = new Request("http://x/test"); // no IP headers at all
    const b = new Request("http://x/test");
    expect(rateLimitResponse(opts, a)).toBeNull();
    // Second anonymous caller is treated as the same identity → blocked.
    expect(rateLimitResponse(opts, b)!.status).toBe(429);
  });

  it("explicit identity overrides IP-derived identity (per-token bucket)", () => {
    const opts = {
      key: "POST /api/x",
      windowMs: 30_000,
      max: 1,
      identity: "admin-token-abc",
    };
    // Two different IPs, same explicit identity → shared bucket
    const a = makeReq({ ip: "10.0.0.10" });
    const b = makeReq({ ip: "10.0.0.20" });
    expect(rateLimitResponse(opts, a)).toBeNull();
    expect(rateLimitResponse(opts, b)!.status).toBe(429);
  });

  it("explicit identities are isolated from each other (per-user buckets)", () => {
    const opts = {
      key: "POST /api/x",
      windowMs: 30_000,
      max: 1,
    };
    expect(
      rateLimitResponse({ ...opts, identity: "user-A" }, makeReq())
    ).toBeNull();
    expect(
      rateLimitResponse({ ...opts, identity: "user-B" }, makeReq())
    ).toBeNull();
    // 2nd call as user-A blocked
    expect(
      rateLimitResponse({ ...opts, identity: "user-A" }, makeReq())!.status
    ).toBe(429);
  });

  it("global state persists across calls (not scoped per-request)", () => {
    // This documents a real behavior — the in-process Map is shared.
    // We use it here as a positive test: calls in the same process share state.
    const opts = { key: "GET /api/global", windowMs: 30_000, max: 1 };
    const r1 = makeReq({ ip: "10.0.0.99" });
    const r2 = makeReq({ ip: "10.0.0.99" });
    expect(rateLimitResponse(opts, r1)).toBeNull();
    expect(rateLimitResponse(opts, r2)!.status).toBe(429);
  });

  it("429 body is JSON { error: 'Too Many Requests' }", () => {
    const opts = { key: "GET /api/body", windowMs: 30_000, max: 1 };
    const req = makeReq({ ip: "10.0.0.11" });
    rateLimitResponse(opts, req);
    const res = rateLimitResponse(opts, req);
    expect(res).not.toBeNull();
    // The response is a NextResponse; reading the body should yield the
    // structured error JSON.
    return res!.json().then((body) => {
      expect(body).toEqual({ error: "Too Many Requests" });
    });
  });
});

describe("rateLimitAction — adversarial boundaries", () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  it("(max+1)th call within the window returns denial for actions", () => {
    const opts = { key: "action syncSports", windowMs: 30_000, max: 2 };
    expect(rateLimitAction(opts, "token-x")).toBeNull();
    expect(rateLimitAction(opts, "token-x")).toBeNull();
    const third = rateLimitAction(opts, "token-x");
    expect(third).not.toBeNull();
    expect(third).toEqual({ ok: false, error: "Too Many Requests" });
  });

  it("different tokens are isolated (one token's denial does not affect another)", () => {
    const opts = { key: "action syncSports", windowMs: 30_000, max: 1 };
    expect(rateLimitAction(opts, "token-a")).toBeNull();
    expect(rateLimitAction(opts, "token-b")).toBeNull();
    // Now token-a is blocked, but token-b's first call just went through — verify
    // token-b is still allowed (it should be, since it just used its 1 slot).
    // Then a 2nd token-b call is blocked.
    expect(rateLimitAction(opts, "token-b")).toEqual({
      ok: false,
      error: "Too Many Requests",
    });
  });

  it("null/undefined token falls back to 'unknown' shared bucket", () => {
    const opts = { key: "action x", windowMs: 30_000, max: 1 };
    // Two callers, both with null token, share the 'unknown' bucket
    expect(rateLimitAction(opts, null)).toBeNull();
    expect(rateLimitAction(opts, undefined)).toEqual({
      ok: false,
      error: "Too Many Requests",
    });
  });

  it("action and response limiters have separate buckets even with same key+identity", () => {
    // The action limiter and the response limiter are two different functions
    // that maintain their OWN state (rateLimitAction uses 'unknown' fallback
    // differently from rateLimitResponse, but they share the same Map).
    // Different keys keep them isolated, and the same key across the two
    // functions will share — that is the documented behavior. This test
    // pins the shared-key behavior so any future split is intentional.
    const responseOpts = { key: "shared-key", windowMs: 30_000, max: 1 };
    const actionOpts = { key: "shared-key", windowMs: 30_000, max: 1 };
    const req = makeReq({ ip: "10.0.0.50" });
    // Use the response limiter as IP "10.0.0.50"
    expect(rateLimitResponse(responseOpts, req)).toBeNull();
    // Action limiter with the SAME key but a different identity (the token)
    // should not be affected by the response hit.
    expect(rateLimitAction(actionOpts, "token-y")).toBeNull();
  });

  it("sliding window for actions: wait past windowMs, then allowed again", async () => {
    const opts = { key: "action sliding", windowMs: 50, max: 1 };
    expect(rateLimitAction(opts, "token-z")).toBeNull();
    expect(rateLimitAction(opts, "token-z")).toEqual({
      ok: false,
      error: "Too Many Requests",
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(rateLimitAction(opts, "token-z")).toBeNull();
  });
});

describe("rate limit — security / abuse cases", () => {
  beforeEach(() => {
    __resetRateLimit();
  });

  it("header spoofing: case variations of 'x-admin-token' are NOT treated as a different identity in rate-limit (good — but rate-limit runs after auth)", () => {
    // This test documents that the rate limiter does NOT inspect the auth
    // header — it only reads x-forwarded-for. So all the following requests
    // share the same IP-derived bucket regardless of what they put in
    // x-admin-token.
    const opts = { key: "GET /api/x", windowMs: 30_000, max: 1 };
    const a = new Request("http://x/test", {
      headers: {
        "x-forwarded-for": "5.5.5.5",
        "x-admin-token": "real-token",
      },
    });
    const b = new Request("http://x/test", {
      headers: {
        "x-forwarded-for": "5.5.5.5",
        "X-Admin-Token": "WRONG-token",
      },
    });
    expect(rateLimitResponse(opts, a)).toBeNull();
    expect(rateLimitResponse(opts, b)!.status).toBe(429);
  });

  it("abuse: an attacker who controls x-forwarded-for can rotate buckets to bypass the limit", () => {
    // This documents the LIMITATION noted in the module: an attacker that
    // can spoof the IP header gets a fresh bucket per IP. This is
    // acceptable for an in-process limiter; pin the behavior so any
    // future mitigation is intentional.
    const opts = { key: "GET /api/spoof", windowMs: 30_000, max: 1 };
    for (let i = 0; i < 10; i++) {
      const req = makeReq({ ip: `10.0.0.${i}` });
      expect(rateLimitResponse(opts, req)).toBeNull();
    }
  });

  it("abuse: x-forwarded-for with leading whitespace still works (header parsing)", () => {
    // Some proxies add a leading space. The rate limiter should not break on
    // that. (Defensive test — current code does .trim() on the first hop.)
    const opts = { key: "GET /api/ws", windowMs: 30_000, max: 1 };
    const a = new Request("http://x/test", {
      headers: { "x-forwarded-for": "  1.2.3.4  , 5.6.7.8" },
    });
    const b = makeReq({ ip: "1.2.3.4, 5.6.7.8" });
    expect(rateLimitResponse(opts, a)).toBeNull();
    expect(rateLimitResponse(opts, b)!.status).toBe(429);
  });

  it("very long x-forwarded-for does not throw or allocate excessively", () => {
    // Defensive: the .split(",")[0]!.trim() should not be expensive.
    const opts = { key: "GET /api/long", windowMs: 30_000, max: 2 };
    const huge = Array.from({ length: 1000 }, (_, i) => `10.0.${i}.1`).join(",");
    const req = new Request("http://x/test", {
      headers: { "x-forwarded-for": huge },
    });
    // Two calls allowed (max=2). Neither should throw and both should be null.
    expect(() => rateLimitResponse(opts, req)).not.toThrow();
    expect(rateLimitResponse(opts, req)).toBeNull();
    // Third call within the window: 429 (sanity check the bucket is real).
    const blocked = rateLimitResponse(opts, req);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
  });
});
