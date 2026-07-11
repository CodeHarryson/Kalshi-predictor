import { describe, it, expect } from "vitest";
import { normalizeForMatch, haystackContainsCandidate } from "./text-match";

describe("normalizeForMatch", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeForMatch("Lamine Yamal!")).toBe("lamine yamal");
  });
  it("collapses runs of whitespace", () => {
    expect(normalizeForMatch("  a   b\tc  ")).toBe("a b c");
  });
  it("strips diacritics via NFD + combining-mark strip", () => {
    // "México" has the é combining form; after NFD it's "Mex" + "́" (combining acute)
    expect(normalizeForMatch("México")).toBe("mexico");
    expect(normalizeForMatch("Atlético de Madrid")).toBe("atletico de madrid");
  });
  it("strips diacritics on tildes, umlauts, etc.", () => {
    expect(normalizeForMatch("São Paulo")).toBe("sao paulo");
    expect(normalizeForMatch("Müller")).toBe("muller");
  });
});

describe("haystackContainsCandidate", () => {
  it("matches a full team name word-bounded", () => {
    expect(haystackContainsCandidate("Argentina vs France", "Argentina")).toBe(true);
    expect(haystackContainsCandidate("Argentina vs France", "France")).toBe(true);
  });
  it("does not match a substring that isn't word-bounded", () => {
    // "United" must not match "Reunited" — word boundary.
    expect(haystackContainsCandidate("Reunited Arab Emirates", "United")).toBe(false);
  });
  it("is diacritic-insensitive", () => {
    expect(haystackContainsCandidate("Atlético Madrid vs Sevilla", "Atletico Madrid")).toBe(true);
  });
  it("returns false for an empty candidate", () => {
    expect(haystackContainsCandidate("anything", "")).toBe(false);
  });
});
