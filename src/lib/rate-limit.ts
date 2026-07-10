import { NextResponse } from "next/server";

/**
 * In-process sliding-window rate limiter.
 *
 * KNOWN LIMITATION: state lives in this Node process. On Vercel / multi-instance
 * deployments, each instance has its own Map — a caller can effectively get
 * N×max requests by hitting N instances. Acceptable for now; replace with an
 * edge store (Upstash, Vercel KV) when traffic justifies it.
 *
 * HMR: we stash the Map on globalThis so dev hot-reload doesn't reset the
 * window mid-test.
 */

type Hit = number; // epoch ms

interface LimiterGlobal {
  __kalshiRateLimitHits?: Map<string, Hit[]>;
}
const g = globalThis as unknown as LimiterGlobal;
const hits: Map<string, Hit[]> =
  g.__kalshiRateLimitHits ?? new Map<string, Hit[]>();
g.__kalshiRateLimitHits = hits;

export interface RateLimitOpts {
  /** Unique key — typically `${method} ${path}` to scope the bucket. */
  key: string;
  /** Sliding window in ms. */
  windowMs: number;
  /** Max requests allowed in the window. */
  max: number;
  /** Identity to scope per-caller. Defaults to client IP. */
  identity?: string;
}

/** Pull a stable per-request identity. Falls back to "unknown". */
function clientIpFromHeaders(h: Headers): string {
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const real = h.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

export function rateLimitResponse(
  opts: RateLimitOpts,
  req: Request
): NextResponse | null {
  const identity = opts.identity ?? clientIpFromHeaders(req.headers);
  const bucketKey = `${opts.key}|${identity}`;
  const now = Date.now();
  const cutoff = now - opts.windowMs;
  const arr = hits.get(bucketKey) ?? [];
  // Drop expired
  const fresh = arr.filter((t) => t > cutoff);
  if (fresh.length >= opts.max) {
    const retryAfterMs = opts.windowMs - (now - fresh[0]!);
    return NextResponse.json(
      { error: "Too Many Requests" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
      }
    );
  }
  fresh.push(now);
  hits.set(bucketKey, fresh);
  return null;
}

/** Server-action variant: returns null if allowed, else a denial. */
export function rateLimitAction(
  opts: { key: string; windowMs: number; max: number },
  token: string | null | undefined
): { ok: false; error: string } | null {
  const identity = token ?? "unknown";
  const bucketKey = `${opts.key}|${identity}`;
  const now = Date.now();
  const cutoff = now - opts.windowMs;
  const arr = hits.get(bucketKey) ?? [];
  const fresh = arr.filter((t) => t > cutoff);
  if (fresh.length >= opts.max)
    return { ok: false, error: "Too Many Requests" };
  fresh.push(now);
  hits.set(bucketKey, fresh);
  return null;
}

/** Test-only — clear all buckets. */
export function __resetRateLimit(): void {
  hits.clear();
}
