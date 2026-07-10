import { describe, it, expect, vi } from "vitest";
import { safeParse } from "./safe-parse";

const isString = (v: unknown): v is string => typeof v === "string";

describe("safeParse", () => {
  it("returns parsed value for valid JSON matching predicate", () => {
    const r = safeParse(JSON.stringify("hello"), isString, {
      fallback: "default",
    });
    expect(r).toBe("hello");
  });

  it("returns fallback for invalid JSON", () => {
    const onError = vi.fn();
    const r = safeParse("not json", isString, { fallback: "default", onError });
    expect(r).toBe("default");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("returns fallback when predicate rejects (right JSON, wrong shape)", () => {
    const onError = vi.fn();
    const r = safeParse(JSON.stringify(42), isString, { fallback: "default", onError });
    expect(r).toBe("default");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("works without onError", () => {
    const r = safeParse("not json", isString, { fallback: "x" });
    expect(r).toBe("x");
  });
});
