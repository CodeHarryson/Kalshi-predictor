import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { rateLimitResponse } from "@/lib/rate-limit";
import { maybeRetrainLeague, maybeRetrainAllLeagues } from "@/lib/scoring/retrain";
import { ALL_LEAGUES } from "@/lib/sync";

export async function POST(req: Request) {
  const denied = requireAdmin(req);
  if (denied) return denied;

  const limited = rateLimitResponse(
    { key: "POST /api/model/retrain", windowMs: 60_000, max: 1 },
    req
  );
  if (limited) return limited;

  let body: { league?: unknown } = {};
  try {
    body = (await req.json()) as { league?: unknown };
  } catch {
    body = {};
  }

  const { league } = body;
  if (league !== undefined && !ALL_LEAGUES.includes(league as (typeof ALL_LEAGUES)[number])) {
    return NextResponse.json(
      { error: `league must be one of ${ALL_LEAGUES.join(", ")}` },
      { status: 400 }
    );
  }

  const results = league
    ? [await maybeRetrainLeague(league as (typeof ALL_LEAGUES)[number])]
    : await maybeRetrainAllLeagues();

  return NextResponse.json({ results });
}
