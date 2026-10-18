import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { rateLimitResponse } from "@/lib/rate-limit";
import { resolveMarketFavoredSide } from "@/lib/scoring/composite";
import { maybeRetrainLeague } from "@/lib/scoring/retrain";
import { settlePlayerPropLeg } from "@/lib/player-props/settle";
import type { League, LegKind, LegOutcome, ParlayStatus } from "@/generated/prisma/enums";

interface SettledLeg {
  legId: string;
  outcome: Extract<LegOutcome, "WON" | "LOST" | "PUSH">;
  featureLogId: string | null;
  league: League;
}

function computeParlayStatus(outcomes: LegOutcome[]): ParlayStatus {
  if (outcomes.some((o) => o === "LOST")) return "LOST";
  if (outcomes.some((o) => o === "PENDING")) return "PENDING";
  if (outcomes.some((o) => o === "PUSH")) return "PUSH";
  return "WON";
}

function thresholdHolds(stat: number, threshold: number, side: "YES" | "NO"): boolean {
  // The market convention for "0.5+ goals" or "over 5.5 corners" is:
  //   YES resolves if stat >= threshold (e.g. 1 goal with threshold 0.5).
  //   NO resolves if stat < threshold.
  // This matches the threshold-encoding used by the builder and by
  // playerGoalProbAtLeast / teamCornerProbAtLeast in prop-rate.ts.
  return side === "YES" ? stat >= threshold : stat < threshold;
}

/**
 * Settles a per-game TEAM_CORNERS leg. PLAYER_GOALS doesn't go through
 * here - it's tournament-scoped (no gameId), handled by
 * settlePlayerAnytimeGoalLeg above with a different trigger entirely.
 */
async function settlePropLeg(
  legId: string,
  gameId: string,
  side: "YES" | "NO",
  subjectExternalId: string | null,
  threshold: number | null
): Promise<Extract<LegOutcome, "WON" | "LOST" | "PUSH"> | null> {
  if (subjectExternalId == null || threshold == null) {
    // Market didn't carry a subject/threshold at leg-creation time.
    // That's a data-integrity problem, not a PUSH — the leg was built
    // from a market that wasn't really a prop. Mark PUSH to surface it
    // rather than silently settling.
    console.warn(`settle: prop leg ${legId} missing subjectExternalId or threshold - marking PUSH`);
    return "PUSH";
  }
  // `subjectExternalId` holds our own internal Team.id (resolved by name
  // against the already-synced Team table in syncPropMarketsForLeague),
  // not Team.externalId (football-data.org's id) - direct PK lookup.
  const team = await db.team.findUnique({
    where: { id: subjectExternalId },
    select: { id: true },
  });
  if (!team) {
    console.warn(
      `settle: prop leg ${legId} (TEAM_CORNERS) could not find team id=${subjectExternalId} - leaving PENDING`
    );
    return null;
  }
  const stat = await db.teamGameStat.findUnique({
    where: { gameId_teamId: { gameId, teamId: team.id } },
    select: { corners: true },
  });
  if (stat?.corners == null) {
    console.warn(
      `settle: prop leg ${legId} (TEAM_CORNERS) no TeamGameStat row for game=${gameId} team=${team.id} - leaving PENDING`
    );
    return null;
  }
  return thresholdHolds(stat.corners, threshold, side) ? "WON" : "LOST";
}

async function findPlayerByExternalId(externalId: string): Promise<{ id: string } | null> {
  // `propSubjectExternalId` holds OUR OWN internal Player.id (resolved by
  // name against the Player table at sync time - see syncPropMarketsForLeague
  // and syncPropStatsForLeague in sync.ts), not a foreign provider id, so
  // this is a direct primary-key lookup - same pattern as findTeamByExternalId.
  return db.player.findUnique({ where: { id: externalId }, select: { id: true } });
}

/**
 * Settles a tournament-long "will this player score at any point" leg
 * (PLAYER_GOALS - see kalshi-props.ts's PROP_SERIES comment for why this
 * has no gameId and needs its own trigger, unlike the per-game props
 * settled by settlePropLeg). WON as soon as the player has scored in any
 * synced tournament game; LOST once their team has no SCHEDULED/LIVE games
 * left without having scored; otherwise still PENDING (more games to come).
 */
async function settlePlayerAnytimeGoalLeg(
  legId: string,
  side: "YES" | "NO",
  subjectExternalId: string
): Promise<Extract<LegOutcome, "WON" | "LOST"> | null> {
  const player = await findPlayerByExternalId(subjectExternalId);
  if (!player) {
    console.warn(
      `settle: player-goals leg ${legId} could not find player id=${subjectExternalId} - leaving PENDING`
    );
    return null;
  }

  const scored = await db.playerGameStat.findFirst({
    where: { playerId: player.id, goals: { gt: 0 } },
    select: { id: true },
  });
  if (scored) return side === "YES" ? "WON" : "LOST";

  const full = await db.player.findUnique({ where: { id: player.id }, select: { teamId: true, league: true } });
  if (!full?.teamId) {
    console.warn(`settle: player-goals leg ${legId} has no resolved team yet - leaving PENDING`);
    return null;
  }

  const remainingGames = await db.game.count({
    where: {
      league: full.league,
      status: { in: ["SCHEDULED", "LIVE"] },
      OR: [{ homeTeamId: full.teamId }, { awayTeamId: full.teamId }],
    },
  });
  if (remainingGames === 0) return side === "YES" ? "LOST" : "WON";

  return null; // no goals yet, but the player's team still has games left
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const limited = rateLimitResponse(
    { key: "POST /api/parlays/[id]/settle", windowMs: 10_000, max: 1 },
    req
  );
  if (limited) return limited;

  const { id } = await params;

  const parlay = await db.parlay.findUnique({
    where: { id },
    include: {
      legs: {
        include: {
          game: { include: { homeTeam: true, awayTeam: true } },
          kalshiMarket: true,
          featureLog: true,
        },
      },
    },
  });

  if (!parlay) {
    return NextResponse.json({ error: "Parlay not found" }, { status: 404 });
  }

  const now = new Date();
  const settled: SettledLeg[] = [];
  const leftPending: string[] = [];

  for (const leg of parlay.legs) {
    if (leg.actualOutcome !== "PENDING") continue;

    // PLAYER_GOALS is tournament-scoped (gameId: null) - its trigger isn't
    // "the game finished", it's "the player scored" or "their team is
    // done without them scoring", so it's handled before the game-status
    // check below (which would otherwise skip it forever, `leg.game`
    // being null for every PLAYER_GOALS leg).
    if (leg.legKind === "PLAYER_GOALS") {
      const subjectExternalId = leg.kalshiMarket?.propSubjectExternalId ?? null;
      if (!subjectExternalId) {
        console.warn(`settle: player-goals leg ${leg.id} missing propSubjectExternalId - leaving PENDING`);
        leftPending.push(leg.id);
        continue;
      }
      const outcome = await settlePlayerAnytimeGoalLeg(leg.id, leg.side, subjectExternalId);
      if (outcome === null) {
        leftPending.push(leg.id);
        continue;
      }
      settled.push({
        legId: leg.id,
        outcome,
        featureLogId: leg.featureLog?.id ?? null,
        league: "WORLD_CUP", // PLAYER_GOALS only exists for World Cup today
      });
      continue;
    }

    const game = leg.game;
    if (!game || game.status !== "FINAL") continue;

    // Prop leg branch: TEAM_CORNERS (per-game, unlike PLAYER_GOALS above).
    // Grade from the stored stat row, else leave PENDING (not PUSH).
    if (leg.legKind === "TEAM_CORNERS") {
      const outcome = await settlePropLeg(
        leg.id,
        game.id,
        leg.side,
        leg.kalshiMarket?.propSubjectExternalId ?? null,
        leg.kalshiMarket?.propThreshold ?? null
      );
      if (outcome === null) {
        // Left PENDING. Don't add to `settled` so the leg row stays PENDING.
        leftPending.push(leg.id);
        continue;
      }
      settled.push({
        legId: leg.id,
        outcome,
        featureLogId: leg.featureLog?.id ?? null,
        league: game.league,
      });
      continue;
    }

    // Player stat lines (NBA / NFL): graded from the player's game log.
    if (leg.legKind === "PLAYER_PROP") {
      const market = leg.kalshiMarket;
      const outcome =
        market?.propKind && market.propThreshold != null && market.propSubjectExternalId
          ? await settlePlayerPropLeg({
              side: leg.side,
              league: game.league,
              propKind: market.propKind,
              threshold: market.propThreshold,
              playerId: market.propSubjectExternalId,
              gameStart: game.startTime,
            })
          : null;
      if (outcome === null) {
        leftPending.push(leg.id);
        continue;
      }
      settled.push({ legId: leg.id, outcome, featureLogId: leg.featureLog?.id ?? null, league: game.league });
      continue;
    }

    // Default: GAME_WINNER. The leg description is what the existing
    // resolveMarketFavoredSide heuristic was built to parse, so we keep
    // using it here.
    const title = leg.kalshiMarket?.yesSubTitle ?? leg.kalshiMarket?.title ?? leg.description;
    const favored = resolveMarketFavoredSide(
      title,
      game.homeTeam.name,
      game.homeTeam.shortName,
      game.awayTeam.name,
      game.awayTeam.shortName
    );

    if (favored === null || game.homeScore === null || game.awayScore === null) {
      console.warn(
        `settle: ambiguous outcome for leg ${leg.id} (parlay ${parlay.id}) - marking PUSH. title="${title}"`
      );
      settled.push({
        legId: leg.id,
        outcome: "PUSH",
        featureLogId: leg.featureLog?.id ?? null,
        league: game.league,
      });
      continue;
    }

    const winner: "home" | "away" | "draw" =
      game.homeScore > game.awayScore ? "home" : game.awayScore > game.homeScore ? "away" : "draw";
    const yesWon = favored === winner;
    const legWon = leg.side === "YES" ? yesWon : !yesWon;

    settled.push({
      legId: leg.id,
      outcome: legWon ? "WON" : "LOST",
      featureLogId: leg.featureLog?.id ?? null,
      league: game.league,
    });
  }

  const settledMap = new Map(settled.map((s) => [s.legId, s.outcome]));
  // For legs that were left PENDING, keep their existing PENDING outcome
  // (don't write a new row, don't include in `settled`). For settled
  // legs, the map gives the new outcome. computeParlayStatus handles the
  // PENDING case.
  const effectiveOutcomes = parlay.legs.map((leg) =>
    settledMap.has(leg.id) ? settledMap.get(leg.id)! : leg.actualOutcome
  );
  const newStatus = computeParlayStatus(effectiveOutcomes);

  await db.$transaction([
    ...settled.map((s) =>
      db.parlayLeg.update({
        where: { id: s.legId },
        data: { actualOutcome: s.outcome, settledAt: now },
      })
    ),
    ...settled
      .filter((s) => s.featureLogId !== null)
      .map((s) =>
        db.modelFeatureLog.update({
          where: { id: s.featureLogId! },
          data: { actualOutcome: s.outcome },
        })
      ),
    db.parlay.update({ where: { id }, data: { status: newStatus } }),
  ]);

  const retrained = [...new Set(settled.map((s) => s.league))];
  // TODO(security): rate-limit maybeRetrainLeague directly to prevent settle-thundering-herd.
  // The route is already 1-per-10s, so the compounded retrain cost is bounded; a
  // dedicated per-league retrain limiter is the next layer of defense.
  await Promise.all(retrained.map((league) => maybeRetrainLeague(league)));

  const updated = await db.parlay.findUnique({
    where: { id },
    include: { legs: true },
  });

  return NextResponse.json({
    parlay: updated,
    retrained,
    leftPending: leftPending.length > 0 ? leftPending : undefined,
  });
}
