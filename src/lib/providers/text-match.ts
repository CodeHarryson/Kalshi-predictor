/**
 * Shared text-matching normalizer for matching provider fixtures to our Game
 * rows by name. Centralized so the per-provider fixture matchers (soccer.ts,
 * api-football.ts) don't drift in their tolerance for diacritics, abbreviations,
 * or punctuation — that's exactly the kind of mismatch that left the original
 * matchMarketToGame (in providers/match.ts) brittle on real data.
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "") // strip diacritics (Unicode combining marks)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Returns true if the candidate string appears as a word-bounded token
 * inside the haystack (after normalization). Word-bounded so a team called
 * "Man United" doesn't match a haystack that contains the word "United"
 * but not "Man United". Both sides are normalized before comparison.
 */
export function haystackContainsCandidate(haystack: string, candidate: string): boolean {
  const h = normalizeForMatch(haystack);
  const c = normalizeForMatch(candidate);
  if (c.length === 0) return false;
  // \b doesn't work the same after stripping punctuation; instead pad both
  // sides with a space and search for the candidate wrapped in spaces.
  return ` ${h} `.includes(` ${c} `);
}
