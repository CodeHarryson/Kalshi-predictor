import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { rateLimitResponse } from "@/lib/rate-limit";
import { resolveMarketFavoredSide } from "@/lib/scoring/composite";
import { maybeRetrainLeague } from "@/lib/scoring/retrain";
import type { League, LegOutcome, ParlayStatus } from "@/generated/prisma/enums";

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

  for (const leg of parlay.legs) {
    const game = leg.game;
    if (!game || game.status !== "FINAL" || leg.actualOutcome !== "PENDING") continue;

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
  const effectiveOutcomes = parlay.legs.map((leg) => settledMap.get(leg.id) ?? leg.actualOutcome);
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

  return NextResponse.json({ parlay: updated, retrained });
}
