import type { Team, Game } from "@/generated/prisma/client";

const DAY_MS = 24 * 60 * 60 * 1000;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

function titleMentionsTeam(title: string, team: Team): boolean {
  const t = normalize(title);
  const candidates = [team.name, team.shortName].filter(Boolean) as string[];
  return candidates.some((c) => t.includes(normalize(c)));
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
    ? candidateGames.filter(
        (g) => Math.abs(g.startTime.getTime() - closeTime.getTime()) <= DAY_MS
      )
    : candidateGames;

  const matches = inWindow.filter(
    (g) =>
      titleMentionsTeam(marketTitle, g.homeTeam) &&
      titleMentionsTeam(marketTitle, g.awayTeam)
  );

  return matches.length === 1 ? matches[0] : null;
}
