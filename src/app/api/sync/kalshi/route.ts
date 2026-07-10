import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { rateLimitResponse } from "@/lib/rate-limit";
import { ALL_LEAGUES, syncKalshiMarketsForLeague } from "@/lib/sync";
import type { League } from "@/generated/prisma/enums";

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const limited = rateLimitResponse(
    { key: "POST /api/sync/kalshi", windowMs: 30_000, max: 1 },
    req
  );
  if (limited) return limited;

  let league: League | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    league = body?.league;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (league !== undefined && !ALL_LEAGUES.includes(league)) {
    return NextResponse.json(
      { error: `league must be one of ${ALL_LEAGUES.join(", ")}` },
      { status: 400 }
    );
  }

  const leagues = league ? [league] : ALL_LEAGUES;
  const results = [];
  for (const l of leagues) {
    results.push(await syncKalshiMarketsForLeague(l));
  }

  return NextResponse.json({ results });
}
