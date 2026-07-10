import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

const ADMIN_TOKEN_HEADER = "x-admin-token";

/**
 * Verifies a raw admin-token string. Used by both API route handlers
 * (via requireAdmin) and by server actions, which have no Request object.
 *
 * Returns a structured result instead of a NextResponse so the same helper
 * can drive either an HTTP response (routes) or an ActionResult (actions).
 */
// Used by API route handlers (requireAdmin) and server actions (checkAdminToken).
// When a middleware is added, use checkAdminToken directly with the header value.
export type AdminCheck =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

export function checkAdminToken(token: string | null | undefined): AdminCheck {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    // H1: 503 + generic message — do not leak "not configured" to callers.
    return { ok: false, status: 503, error: "Service Unavailable" };
  }
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  // C2: timing-safe compare. Guard lengths first — timingSafeEqual throws on
  // unequal-length buffers. Return 401 (not 503) on length mismatch; this is
  // an auth failure, not a server misconfiguration.
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  if (!timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}

/**
 * Thin Request-shaped wrapper for API route handlers.
 * Existing call sites (`const denied = requireAdmin(req); if (denied) return denied;`)
 * continue to work unchanged.
 */
export function requireAdmin(req: Request): NextResponse | null {
  const result = checkAdminToken(req.headers.get(ADMIN_TOKEN_HEADER));
  if (result.ok) return null;
  return NextResponse.json({ error: result.error }, { status: result.status });
}
