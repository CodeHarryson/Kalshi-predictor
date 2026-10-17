import type { Team, Game } from "@/generated/prisma/client";
import type { League } from "@/generated/prisma/enums";

const DAY_MS = 24 * 60 * 60 * 1000;
// Kalshi's per-game moneyline markets don't always close at kickoff - some
// (e.g. KXWCGAME World Cup markets) stay open for a settlement grace period
// of up to ~2 weeks after the game starts. So a game can start well before
// the market's close_time; it just can't start *after* it. Allow a small
// negative tolerance too, for markets that close shortly before kickoff.
const CLOSE_BEFORE_START_TOLERANCE_MS = 1 * DAY_MS;
const CLOSE_AFTER_START_TOLERANCE_MS = 21 * DAY_MS;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function titleMentionsTeam(title: string, team: Team): boolean {
  const t = normalize(title);
  const candidates = [team.name, team.shortName].filter(Boolean) as string[];
  return candidates.some((c) => t.includes(normalize(c)));
}

// Our Team.shortName -> the code Kalshi uses in event tickers, where they
// differ. Football-data codes are the long-standing source of mismatches.
const KALSHI_CODE_ALIASES: Partial<Record<League, Record<string, string>>> = {
  LALIGA: {
    FCB: "BAR",
    BET: "RBB",
    MAL: "MCF",
    RAY: "RVC",
    CEL: "RCC",
    VAL: "VCF",
    ATL: "ATM",
  },
};

const MONTHS =["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * Fallback for markets whose title names only one side ("Leeds United wins",
 * "Tie is the result"). Kalshi's event ticker encodes the matchup, e.g.
 * KXEPLGAME-26OCT18LEEMUN = date 2026-10-18 + team codes LEE, MUN, which line
 * up with our Team.shortName. Date is matched within a day to absorb UTC vs
 * local-kickoff differences.
 */
export function matchMarketByTicker(
  ticker: string,
  candidateGames: (Game & { homeTeam: Team; awayTeam: Team })[],
  league?: League
): Game | null {
  const m = /^[A-Z0-9]+-(\d{2})([A-Z]{3})(\d{2})([A-Z0-9]+?)(?:-[A-Z0-9]+)?$/.exec(ticker);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  if (month < 0) return null;
  const eventDay = Date.UTC(2000 + Number(m[1]), month, Number(m[3]));
  const codes = m[4];

  const aliases = (league && KALSHI_CODE_ALIASES[league]) || {};
  const codesOf = (t: Team): string[] => {
    const short = t.shortName?.toUpperCase();
    if (!short) return [];
    return aliases[short] ? [short, aliases[short]] : [short];
  };

  const matches = candidateGames.filter((g) => {
    const homes = codesOf(g.homeTeam);
    const aways = codesOf(g.awayTeam);
    const hit = homes.some((h) =>
      aways.some((a) => codes === h + a || codes === a + h)
    );
    if (!hit) return false;
    return Math.abs(g.startTime.getTime() - eventDay) <= 2 * DAY_MS;
  });

  return matches.length === 1 ? matches[0] : null;
}

/**
 * Matches a Kalshi market to a game by checking whether both the home and
 * away team names appear in the market title, restricted to games within a
 * day of the market's close time. Kalshi doesn't expose a stable
 * game/event id we can join on, so this substring heuristic is the practical
 * option - it can mismatch on ambiguous titles (e.g. tournament names) and
 * should be spot-checked once real market data is flowing.
 */
export function matchMarketToGame(
  marketTitle: string,
  closeTime: Date | null,
  candidateGames: (Game & { homeTeam: Team; awayTeam: Team })[]
): Game | null {
  const inWindow = closeTime
    ? candidateGames.filter((g) => {
        const delta = closeTime.getTime() - g.startTime.getTime();
        return (
          delta >= -CLOSE_BEFORE_START_TOLERANCE_MS &&
          delta <= CLOSE_AFTER_START_TOLERANCE_MS
        );
      })
    : candidateGames;

  const matches = inWindow.filter(
    (g) =>
      titleMentionsTeam(marketTitle, g.homeTeam) &&
      titleMentionsTeam(marketTitle, g.awayTeam)
  );

  return matches.length === 1 ? matches[0] : null;
}
