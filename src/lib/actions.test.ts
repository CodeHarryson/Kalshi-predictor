import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock next/headers so we can drive x-admin-token per test.
const headerStore: { value: string | null } = { value: null };
vi.mock("next/headers", () => ({
  headers: async () => ({
    get(name: string) {
      if (name === "x-admin-token") return headerStore.value;
      return null;
    },
  }),
}));

const SECRET = "actions-test-secret";
process.env.ADMIN_TOKEN = SECRET;

// Import after mocks are set up.
import { syncSportsAction, syncKalshiAction, retrainAction } from "@/lib/actions";

describe("server actions auth gate (C1)", () => {
  beforeEach(() => {
    headerStore.value = null;
  });

  afterEach(() => {
    headerStore.value = null;
  });

  it("syncSportsAction returns ok=false with no token (no DB write)", async () => {
    const res = await syncSportsAction();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Unauthorized");
  });

  it("syncKalshiAction returns ok=false with no token", async () => {
    const res = await syncKalshiAction();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Unauthorized");
  });

  it("retrainAction returns ok=false with no token", async () => {
    const res = await retrainAction();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Unauthorized");
  });

  it("actions return ok=false (not crash) on length-mismatched token", async () => {
    headerStore.value = "short";
    const res = await syncSportsAction();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Unauthorized");
  });

  it("actions return ok=false on wrong token", async () => {
    headerStore.value = "definitely-wrong-token";
    const res = await syncSportsAction();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Unauthorized");
  });
});
