import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkAdminToken } from "./admin-auth";

describe("admin auth security", () => {
  const ORIGINAL = process.env.ADMIN_TOKEN;
  beforeEach(() => {
    delete process.env.ADMIN_TOKEN;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = ORIGINAL;
  });

  it("timing-safe: 1-byte token vs 1000-byte token does not throw", () => {
    process.env.ADMIN_TOKEN = "a";
    // Should NOT throw — the length guard must short-circuit before timingSafeEqual.
    expect(() => checkAdminToken("a".repeat(1000))).not.toThrow();
    expect(checkAdminToken("a".repeat(1000)).ok).toBe(false);
  });

  it("503 message does not leak 'ADMIN_TOKEN' or 'configured'", () => {
    const res = checkAdminToken("anything");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toMatch(/ADMIN_TOKEN|configured|env/i);
    }
  });

  it("empty-string env var treated as unset (returns 503, not 401)", () => {
    process.env.ADMIN_TOKEN = "";
    const res = checkAdminToken("anything");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(503);
  });

  it("non-string token (number, object) is rejected without throwing", () => {
    process.env.ADMIN_TOKEN = "secret-123";
    // @ts-expect-error: testing runtime behavior with wrong type
    expect(checkAdminToken(12345).ok).toBe(false);
    // @ts-expect-error: testing runtime behavior with wrong type
    expect(checkAdminToken({}).ok).toBe(false);
  });
});
