import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { combineParlayProbability } from "@/lib/scoring/parlay";
import { requireAdmin } from "@/lib/admin-auth";
import type { LegKind } from "@/generated/prisma/enums";

const LEG_KINDS: LegKind[] = ["GAME_WINNER", "PLAYER_GOALS", "TEAM_CORNERS"];

interface LegInput {
  // Null for tournament-scoped legs (PLAYER_GOALS) with no single game to
  // reference - see src/lib/builder.ts's CandidateLeg comment.
  gameId: string | null;
  kalshiMarketId?: string;
  description: string;
  side: "YES" | "NO";
  legKind: LegKind;
  predictedProbability: number;
  marketImpliedProbability?: number;
  features: Record<string, number>;
}

interface ParlayInput {
  notes?: string;
  stake?: number;
  source?: "manual" | "suggestion";
  legs: LegInput[];
}

function validate(body: unknown): { ok: true; data: ParlayInput } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b.legs) || b.legs.length === 0) {
    return { ok: false, error: "'legs' must be a non-empty array." };
  }
  if (b.source !== undefined && b.source !== "manual" && b.source !== "suggestion") {
    return { ok: false, error: "'source' must be 'manual' or 'suggestion'." };
  }
  if (b.stake !== undefined && typeof b.stake !== "number") {
    return { ok: false, error: "'stake' must be a number." };
  }
  if (b.notes !== undefined && typeof b.notes !== "string") {
    return { ok: false, error: "'notes' must be a string." };
  }

  const validatedLegs: LegInput[] = [];
  for (const [i, raw] of b.legs.entries()) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: `Leg ${i} must be an object.` };
    }
    const leg = raw as Record<string, unknown>;
    // gameId is required for GAME_WINNER/TEAM_CORNERS legs, but null for
    // tournament-scoped PLAYER_GOALS legs (no single game to reference).
    if (leg.gameId !== null && (typeof leg.gameId !== "string" || leg.gameId.length === 0)) {
      return { ok: false, error: `Leg ${i}: 'gameId' must be a non-empty string or null.` };
    }
    if (leg.gameId === null && leg.legKind !== "PLAYER_GOALS") {
      return { ok: false, error: `Leg ${i}: 'gameId' is required unless legKind is 'PLAYER_GOALS'.` };
    }
    if (typeof leg.description !== "string" || leg.description.length === 0) {
      return { ok: false, error: `Leg ${i}: 'description' is required.` };
    }
    if (leg.side !== "YES" && leg.side !== "NO") {
      return { ok: false, error: `Leg ${i}: 'side' must be 'YES' or 'NO'.` };
    }
    if (leg.legKind !== undefined && !LEG_KINDS.includes(leg.legKind as LegKind)) {
      return { ok: false, error: `Leg ${i}: 'legKind' must be one of ${LEG_KINDS.join(", ")}.` };
    }
    if (
      typeof leg.predictedProbability !== "number" ||
      leg.predictedProbability < 0 ||
      leg.predictedProbability > 1
    ) {
      return { ok: false, error: `Leg ${i}: 'predictedProbability' must be a number in [0,1].` };
    }
    if (leg.marketImpliedProbability !== undefined && typeof leg.marketImpliedProbability !== "number") {
      return { ok: false, error: `Leg ${i}: 'marketImpliedProbability' must be a number.` };
    }
    if (leg.kalshiMarketId !== undefined && typeof leg.kalshiMarketId !== "string") {
      return { ok: false, error: `Leg ${i}: 'kalshiMarketId' must be a string.` };
    }
    // Strict features validation: must be a non-null object whose values are
    // all numbers. Matches the builder at src/lib/builder.ts:76-82. The
    // previous code only checked `typeof leg.features === "object"`, which
    // let `Record<string, string>` slip through and break the retrain.
    if (typeof leg.features !== "object" || leg.features === null || Array.isArray(leg.features)) {
      return { ok: false, error: `Leg ${i}: 'features' must be an object.` };
    }
    const featuresObj = leg.features as Record<string, unknown>;
    if (Object.keys(featuresObj).length === 0) {
      return { ok: false, error: `Leg ${i}: 'features' must be a non-empty object of numbers.` };
    }
    for (const [k, v] of Object.entries(featuresObj)) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { ok: false, error: `Leg ${i}: 'features.${k}' must be a finite number.` };
      }
    }

    validatedLegs.push({
      gameId: leg.gameId as string | null,
      kalshiMarketId: typeof leg.kalshiMarketId === "string" ? leg.kalshiMarketId : undefined,
      description: leg.description,
      side: leg.side,
      legKind: LEG_KINDS.includes(leg.legKind as LegKind) ? (leg.legKind as LegKind) : "GAME_WINNER",
      predictedProbability: leg.predictedProbability,
      marketImpliedProbability:
        typeof leg.marketImpliedProbability === "number" ? leg.marketImpliedProbability : undefined,
      features: featuresObj as Record<string, number>,
    });
  }

  const data: ParlayInput = {
    notes: typeof b.notes === "string" ? b.notes : undefined,
    stake: typeof b.stake === "number" ? b.stake : undefined,
    source: b.source === "manual" || b.source === "suggestion" ? b.source : undefined,
    legs: validatedLegs,
  };
  return { ok: true, data };
}

export async function POST(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const result = validate(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const { notes, stake, source, legs } = result.data;

  // PLAYER_GOALS legs have gameId: null by design (tournament-scoped, no
  // single game) - excluded from the FK-existence check below, and their
  // league is always WORLD_CUP (the only league prop markets sync for
  // today), resolved directly rather than via this game lookup.
  const gameIds = [...new Set(legs.map((l) => l.gameId).filter((id): id is string => id !== null))];
  const games = await db.game.findMany({
    where: { id: { in: gameIds } },
    select: { id: true, league: true },
  });
  const leagueByGame = new Map(games.map((g) => [g.id, g.league]));

  const missing = gameIds.filter((id) => !leagueByGame.has(id));
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `Unknown gameId(s): ${missing.join(", ")}.` },
      { status: 400 }
    );
  }

  function legLeague(leg: LegInput) {
    if (leg.gameId) return leagueByGame.get(leg.gameId);
    return leg.legKind === "PLAYER_GOALS" ? "WORLD_CUP" : undefined;
  }

  const combinedProbability = combineParlayProbability(
    legs.map((l) => ({
      gameId: l.gameId,
      probability: l.predictedProbability,
      marketImpliedProbability: l.marketImpliedProbability,
    }))
  );

  const parlay = await db.$transaction(async (tx) => {
    const created = await tx.parlay.create({
      data: {
        notes,
        stake,
        source: source ?? "manual",
        combinedProbability,
      },
    });

    for (const leg of legs) {
      const createdLeg = await tx.parlayLeg.create({
        data: {
          parlayId: created.id,
          kalshiMarketId: leg.kalshiMarketId,
          gameId: leg.gameId,
          description: leg.description,
          side: leg.side,
          legKind: leg.legKind,
          predictedProbability: leg.predictedProbability,
          marketImpliedProbability: leg.marketImpliedProbability,
        },
      });

      await tx.modelFeatureLog.create({
        data: {
          parlayLegId: createdLeg.id,
          league: legLeague(leg)!,
          features: JSON.stringify(leg.features),
          predictedProbability: leg.predictedProbability,
          actualOutcome: "PENDING",
        },
      });
    }

    return tx.parlay.findUnique({
      where: { id: created.id },
      include: { legs: true },
    });
  });

  return NextResponse.json({ parlay }, { status: 201 });
}

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const parlays = await db.parlay.findMany({
    include: { legs: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ parlays });
}
