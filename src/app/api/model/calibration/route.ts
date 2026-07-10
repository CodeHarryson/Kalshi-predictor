import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { computeCalibration } from "@/lib/scoring/calibration";
import { ALL_LEAGUES } from "@/lib/sync";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const league = new URL(request.url).searchParams.get("league");
  if (!league || !ALL_LEAGUES.includes(league as (typeof ALL_LEAGUES)[number])) {
    return NextResponse.json(
      { error: `league query param is required and must be one of ${ALL_LEAGUES.join(", ")}` },
      { status: 400 }
    );
  }

  const report = await computeCalibration(league as (typeof ALL_LEAGUES)[number]);
  return NextResponse.json(report);
}
