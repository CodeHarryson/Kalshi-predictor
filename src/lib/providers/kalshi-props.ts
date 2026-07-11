import type { PropKind } from "@/generated/prisma/enums";

/**
 * PROP_SERIES map: which Kalshi series tickers host prop markets for each
 * league, and which prop kind each one corresponds to.
 *
 * Live-verified 2026-07-11 against Kalshi's `/markets?series_ticker=...`:
 *
 * KXWCTCORNERS (TEAM_CORNERS) - fits the per-game model cleanly. Example:
 *   ticker: "KXWCTCORNERS-26JUL11ARGSUI-SUI8"
 *   title: "Switzerland: 8+ corners"
 *   yes_sub_title: "Switzerland: 8+"
 *   floor_strike: 8, strike_type: "greater_or_equal"
 *   event_ticker: "KXWCTCORNERS-26JUL11ARGSUI" (same date+teams pattern as KXWCGAME)
 * The threshold is a real numeric field; the subject is always ONE team
 * (not both), so it needs its own game-linking pass in sync.ts rather than
 * reusing matchMarketToGame (which requires both team names in the title).
 *
 * KXWCPLAYERGOALS (PLAYER_GOALS) - does NOT fit the per-game model. Example:
 *   ticker: "KXWCPLAYERGOALS-26FRA-DUPAMECANO"
 *   title: "Will Dayot Upamecano score a goal in the 2026 Men's FIFA World Cup?"
 *   yes_sub_title / no_sub_title: "Dayot Upamecano" (just the player name)
 *   No floor_strike/cap_strike at all - the market is scoped to the entire
 *   tournament ("in the 2026 Men's FIFA World Cup"), not a single game, and
 *   the implicit threshold is "any goal" (>=1). KalshiMarket.gameId and
 *   ParlayLeg.gameId both stay null for this kind - there's no single game
 *   to peg it to. Settlement (settle/route.ts) has a dedicated branch for
 *   null-gameId PLAYER_GOALS legs: WON as soon as the player scores in any
 *   synced tournament game, LOST once their team has no games left without
 *   having scored, else still PENDING.
 */
export const PROP_SERIES: Record<string, PropKind> = {
  KXWCTCORNERS: "TEAM_CORNERS",
  KXWCPLAYERGOALS: "PLAYER_GOALS",
};

export interface ParsedPropTicker {
  propKind: PropKind;
  propThreshold: number; // e.g. 5.5, or a bare integer like 8 (see below)
  propSubjectName: string; // e.g. "Switzerland" - resolved to our Team/Player row by name at sync time
}

/**
 * Parses a Kalshi team-corners prop's `yes_sub_title` (e.g. "Switzerland: 8+")
 * into the team name and threshold. Deliberately reads `yes_sub_title` over
 * `title` - `title` includes the trailing "corners" word which would need
 * stripping too, and `yes_sub_title` is already the exact same "Name: N+"
 * shape used for the 3-way winner markets' `yes_sub_title`, so this reuses
 * the pattern rather than inventing a second one.
 *
 * Kalshi's `floor_strike` field carries the same number as a real integer
 * and would be a more robust source than regexing text, but it isn't
 * currently captured by `KalshiMarketDto`/`normalizeMarket` in kalshi.ts.
 * Parsing `yes_sub_title` avoids widening that DTO for a single field;
 * revisit if a prop kind shows up whose sub_title doesn't cleanly encode
 * a "Name: N+" pair.
 */
export function parsePropTicker(
  seriesTicker: string,
  _ticker: string,
  title: string,
  yesSubTitle: string | null
): ParsedPropTicker | null {
  const propKind = PROP_SERIES[seriesTicker];
  if (!propKind) return null;

  if (propKind === "TEAM_CORNERS") {
    const source = yesSubTitle ?? title;
    const match = source.match(/^(.+?):\s*(\d+(?:\.\d+)?)\+/);
    if (!match) return null;
    const [, name, thresholdStr] = match;
    const propThreshold = Number.parseFloat(thresholdStr);
    if (!Number.isFinite(propThreshold)) return null;
    return { propKind, propThreshold, propSubjectName: name.trim() };
  }

  if (propKind === "PLAYER_GOALS") {
    // yes_sub_title is just the bare player name ("Dayot Upamecano") - no
    // "Name: N+" shape to parse, unlike TEAM_CORNERS. Threshold is
    // implicitly 1 (any goal at all); Kalshi doesn't expose a numeric
    // field for it since there isn't one.
    const name = (yesSubTitle ?? "").trim();
    if (!name) return null;
    return { propKind, propThreshold: 1, propSubjectName: name };
  }

  return null;
}
