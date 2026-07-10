import { NextResponse } from "next/server";
import { League } from "@/generated/prisma/enums";
import { requireAdmin } from "@/lib/admin-auth";
import { buildParlaySuggestions } from "@/lib/builder";

export async function GET(request: Request) {
  const denied = requireAdmin(request);
  if (denied) return denied;

  const { searchParams } = new URL(request.url);
  const league = searchParams.get("league");

  if (!league || !(league in League)) {
    return NextResponse.json(
      { error: "Query param 'league' is required and must be a valid League." },
      { status: 400 }
    );
  }

  const candidates = await buildParlaySuggestions(league as League);
  return NextResponse.json({ candidates });
}
