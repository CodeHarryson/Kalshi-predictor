import { db } from "@/lib/db";
import type { PropKind } from "@/generated/prisma/enums";
import {
  playerGoalProbAtLeast,
  teamCornerProbAtLeast,
  LEAGUE_PRIOR_PLAYER_GOALS_PER_GAME,
  LEAGUE_PRIOR_TEAM_CORNERS_PER_GAME,
} from "./prop-rate";

export interface PropScoringInput {
  gameId: string;
  propKind: PropKind;
  propThreshold: number;
  propSubjectExternalId: string;
  propSubjectName: string;
}

export interface PropScoringResult {
  predictedProbability: number;
  /** Sample size the score was based on. 0 means the prior only. */
  gamesObserved: number;
  /** True when we couldn't identify the subject in the DB and fell back to the prior. */
  fellBackToPrior: boolean;
}

/**
 * Number of recent games to consider when estimating a player/team prop
 * rate. The shrinkage in prop-rate.ts handles low-n gracefully, so this
 * is a soft cap rather than a hard requirement.
 */
const RECENT_GAMES_WINDOW = 10;

/**
 * Scores a per-game prop market. The caller is `buildParlaySuggestions` in
 * builder.ts's per-game loop. TEAM_CORNERS only - PLAYER_GOALS markets are
 * tournament-scoped (no gameId to be "per-game" about) and are scored
 * separately by `scorePlayerAnytimeGoal` below, called from a dedicated
 * top-level scan in builder.ts rather than this per-game path.
 */
export async function scorePropMarket(input: PropScoringInput): Promise<PropScoringResult | null> {
  const { gameId, propKind, propThreshold, propSubjectExternalId } = input;
  if (propKind !== "TEAM_CORNERS") return null;

  // Look up the game's start time so we only count stats from games that
  // actually happened before the one we're predicting.
  const game = await db.game.findUnique({
    where: { id: gameId },
    select: { startTime: true },
  });
  if (!game) return null;

  return scoreTeamCorners({
    subjectExternalId: propSubjectExternalId,
    propThreshold,
    before: game.startTime,
  });
}

async function findTeamByExternalId(externalId: string): Promise<{ id: string } | null> {
  // `propSubjectExternalId` holds OUR OWN internal Team.id for TEAM_CORNERS,
  // resolved by name against the already-synced Team table at sync time
  // (see syncPropMarketsForLeague in sync.ts) - not a foreign provider id,
  // so this is a direct primary-key lookup rather than a cross-reference.
  return db.team.findUnique({ where: { id: externalId }, select: { id: true } });
}

export interface PlayerAnytimeGoalResult extends PropScoringResult {
  /** True once the player has scored in any synced tournament game - the
   *  bet is effectively decided at that point (settlement grades WON
   *  immediately without waiting for the tournament to end). */
  alreadyScored: boolean;
  /** SCHEDULED/LIVE games left for the player's team. Only meaningful when
   *  `alreadyScored` is false; 0 with no goals means their run is over. */
  remainingGames: number;
}

// Not literally 1.0 - keeps combined-parlay-probability math (a simple
// product across legs) well-behaved rather than treating this leg as
// mathematically certain, and leaves a hair of room for the edge case of a
// stat-sync error being corrected before settlement actually runs.
const ALREADY_SCORED_PROBABILITY = 0.99;

/**
 * Scores a tournament-long "will this player score at any point" market
 * (PLAYER_GOALS - see kalshi-props.ts's PROP_SERIES comment for why this
 * isn't a per-game prop). Two phases:
 *   1. Already scored in a synced game this tournament -> near-certain WON.
 *   2. Not yet -> per-game shrunk scoring probability compounded across
 *      however many SCHEDULED/LIVE games their team has left:
 *      `1 - (1 - perGameProb)^remainingGames`. Naturally goes to 0 once
 *      their team is eliminated (remainingGames = 0) without a goal.
 * Called from a dedicated top-level scan in builder.ts, not the per-game
 * loop `scorePropMarket` serves - there's no single gameId to score
 * relative to.
 */
export async function scorePlayerAnytimeGoal(playerId: string): Promise<PlayerAnytimeGoalResult> {
  const stats = await db.playerGameStat.findMany({
    where: { playerId, goals: { not: null } },
    select: { goals: true },
  });
  const totalGoalsObserved = stats.reduce((sum, s) => sum + (s.goals ?? 0), 0);
  const gamesObserved = stats.length;

  if (totalGoalsObserved > 0) {
    return {
      predictedProbability: ALREADY_SCORED_PROBABILITY,
      gamesObserved,
      fellBackToPrior: false,
      alreadyScored: true,
      remainingGames: 0,
    };
  }

  const perGameProb = playerGoalProbAtLeast({ totalGoalsObserved, gamesObserved, threshold: 0.5 });
  const player = await db.player.findUnique({
    where: { id: playerId },
    select: { teamId: true, league: true },
  });
  if (!player?.teamId) {
    // Can't count remaining games without knowing the team - fall back to
    // a single-game estimate rather than guessing a game count.
    return {
      predictedProbability: perGameProb,
      gamesObserved,
      fellBackToPrior: gamesObserved === 0,
      alreadyScored: false,
      remainingGames: 0,
    };
  }

  const remainingGames = await db.game.count({
    where: {
      league: player.league,
      status: { in: ["SCHEDULED", "LIVE"] },
      OR: [{ homeTeamId: player.teamId }, { awayTeamId: player.teamId }],
    },
  });

  return {
    predictedProbability: 1 - Math.pow(1 - perGameProb, remainingGames),
    gamesObserved,
    fellBackToPrior: gamesObserved === 0,
    alreadyScored: false,
    remainingGames,
  };
}

async function scoreTeamCorners(input: {
  subjectExternalId: string;
  propThreshold: number;
  before: Date;
}): Promise<PropScoringResult | null> {
  const team = await findTeamByExternalId(input.subjectExternalId);
  if (!team) {
    const p = teamCornerProbAtLeast({
      totalCornersObserved: 0,
      gamesObserved: 0,
      threshold: input.propThreshold,
    });
    return {
      predictedProbability: p,
      gamesObserved: 0,
      fellBackToPrior: true,
    };
  }
  const stats = await db.teamGameStat.findMany({
    where: {
      teamId: team.id,
      game: { startTime: { lt: input.before } },
      corners: { not: null },
    },
    orderBy: { game: { startTime: "desc" } },
    take: RECENT_GAMES_WINDOW,
    select: { corners: true },
  });
  const totalCornersObserved = stats.reduce((sum, s) => sum + (s.corners ?? 0), 0);
  const gamesObserved = stats.length;
  const predictedProbability = teamCornerProbAtLeast({
    totalCornersObserved,
    gamesObserved,
    threshold: input.propThreshold,
  });
  return {
    predictedProbability,
    gamesObserved,
    fellBackToPrior: gamesObserved === 0,
  };
}

export const PRIORS = {
  LEAGUE_PRIOR_PLAYER_GOALS_PER_GAME,
  LEAGUE_PRIOR_TEAM_CORNERS_PER_GAME,
} as const;
