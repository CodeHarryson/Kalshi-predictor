import { db } from "@/lib/db";
import type { Game } from "@/generated/prisma/client";
import type { Game as GameClient } from "@/generated/prisma/client";
import { haystackContainsCandidate } from "./text-match";

const DAY_MS = 24 * 60 * 60 * 1000;
// API-Football fixture windows can drift a few days from the actual kickoff
// (their `date` field is the scheduled time, but in practice the difference
// between two providers' timestamps can be 1-2 days when a fixture is
// rescheduled). 7 days on each side is a generous-but-bounded tolerance.
const START_TIME_TOLERANCE_MS = 7 * DAY_MS;

/**
 * Matches an API-Football fixture (identified by home/away team names and a
 * start time) to one of our existing Game rows. Returns null on no match
 * or ambiguous match.
 *
 * Why a separate matcher: the existing matchMarketToGame in match.ts joins
 * Kalshi markets → our games; this joins API-Football fixtures → our games.
 * Both are name+date substring matches in practice, but the two providers
 * describe teams differently (API-Football uses the full FIFA name, e.g.
 * "Portugal", "South Korea", vs football-data.org's "FC Seoul" style), so
 * the windows and the candidate-name source list are different.
 */
export async function matchFixtureToGame(input: {
  homeTeamName: string;
  awayTeamName: string;
  startTime: Date;
  league: "WORLD_CUP"; // v1: only World Cup uses API-Football
}): Promise<Game | null> {
  const { homeTeamName, awayTeamName, startTime, league } = input;

  const candidates = await db.game.findMany({
    where: {
      league,
      status: { in: ["FINAL", "LIVE", "SCHEDULED"] },
      startTime: {
        gte: new Date(startTime.getTime() - START_TIME_TOLERANCE_MS),
        lte: new Date(startTime.getTime() + START_TIME_TOLERANCE_MS),
      },
    },
    include: { homeTeam: true, awayTeam: true },
  });

  const matches = candidates.filter(
    (g: GameClient & { homeTeam: { name: string; shortName: string | null }; awayTeam: { name: string; shortName: string | null } }) => {
      const homeCandidates = [g.homeTeam.name, g.homeTeam.shortName].filter(
        (n): n is string => typeof n === "string" && n.length > 0
      );
      const awayCandidates = [g.awayTeam.name, g.awayTeam.shortName].filter(
        (n): n is string => typeof n === "string" && n.length > 0
      );
      const homeHit = homeCandidates.some((c) => haystackContainsCandidate(homeTeamName, c));
      const awayHit = awayCandidates.some((c) => haystackContainsCandidate(awayTeamName, c));
      return homeHit && awayHit;
    }
  );

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    // If multiple games match (e.g. a friendly vs. the same teams in a
    // competition game 5 days apart), pick the one whose startTime is
    // closest to the fixture's. The caller can still treat the ambiguity
    // as a hard error if they want — but for the v1 sync, picking the
    // closest is a better default than skipping.
    matches.sort(
      (a, b) =>
        Math.abs(a.startTime.getTime() - startTime.getTime()) -
        Math.abs(b.startTime.getTime() - startTime.getTime())
    );
  }
  return matches[0];
}
