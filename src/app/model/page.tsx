import { headers } from "next/headers";
import { db } from "@/lib/db";
import { ALL_LEAGUES } from "@/lib/sync";
import type { League } from "@/generated/prisma/enums";
import { requireAdmin } from "@/lib/admin-auth";
import { computeCalibration } from "@/lib/scoring/calibration";
import type { CalibrationReport } from "@/lib/scoring/calibration";
import { RetrainButton } from "@/components/retrain-button";
import { CalibrationPanel } from "@/components/calibration-panel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const dynamic = "force-dynamic";

const LEAGUE_LABEL: Record<string, string> = {
  NBA: "NBA",
  NFL: "NFL",
  EPL: "Premier League",
  LALIGA: "La Liga",
  WORLD_CUP: "World Cup",
};

function coefficientCount(weightsJson: string): number | null {
  try {
    const parsed = JSON.parse(weightsJson) as {
      coefficients?: Record<string, number>;
    };
    return parsed.coefficients ? Object.keys(parsed.coefficients).length : null;
  } catch {
    return null;
  }
}

async function fetchCalibration(
  league: League,
  token: string
): Promise<CalibrationReport | null> {
  const { GET } = await import("@/app/api/model/calibration/route");
  const req = new Request(
    `http://internal/api/model/calibration?league=${league}`,
    { headers: { "x-admin-token": token } }
  );
  const res = await GET(req);
  if (!res.ok) throw new Error(`calibration fetch failed: ${res.status}`);
  return (await res.json()) as CalibrationReport;
}

export default async function ModelPage() {
  const weights = await db.modelWeights.findMany();
  const byLeague = new Map(weights.map((w) => [w.league, w]));

  const token = (await headers()).get("x-admin-token");
  // Defense in depth: gate the page too. Bad token → render with no data.
  const pageGate = token
    ? requireAdmin(
        new Request("http://internal/model", {
          headers: { "x-admin-token": token },
        })
      )
    : null;

  // Pre-fetch calibration for all leagues in parallel; one bad fetch should not
  // blow up the whole page.
  const calibrationByLeague = new Map<League, CalibrationReport | null>();
  if (token && !pageGate) {
    await Promise.all(
      ALL_LEAGUES.map(async (lg) => {
        try {
          const report = await fetchCalibration(lg, token);
          calibrationByLeague.set(lg, report);
        } catch {
          calibrationByLeague.set(lg, null);
        }
      })
    );
  } else {
    for (const lg of ALL_LEAGUES) calibrationByLeague.set(lg, null);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Model</h1>
        <p className="text-sm text-muted-foreground">
          Trained weights and calibration per league. Retrain pulls from settled legs.
        </p>
      </div>

      <Tabs defaultValue={ALL_LEAGUES[0]}>
        <TabsList>
          {ALL_LEAGUES.map((league) => (
            <TabsTrigger key={league} value={league}>
              {LEAGUE_LABEL[league] ?? league}
            </TabsTrigger>
          ))}
        </TabsList>

        {ALL_LEAGUES.map((league) => {
          const w = byLeague.get(league as League);
          const coefCount = w ? coefficientCount(w.weights) : null;
          const initialData = calibrationByLeague.get(league as League) ?? null;
          return (
            <TabsContent key={league} value={league}>
              <Card>
                <CardHeader className="flex flex-row items-start justify-between">
                  <div className="flex flex-col gap-1">
                    <CardTitle>{LEAGUE_LABEL[league] ?? league}</CardTitle>
                    <CardDescription>
                      {w
                        ? `Trained ${w.trainedAt.toLocaleDateString()} · ${w.sampleSize} samples${
                            coefCount != null ? ` · ${coefCount} features` : ""
                          }`
                        : "Not trained yet — using Elo + form fallback."}
                    </CardDescription>
                  </div>
                  <RetrainButton league={league as League} />
                </CardHeader>
                <Separator />
                <CardContent>
                  <CalibrationPanel
                    league={league as League}
                    initialData={initialData}
                  />
                </CardContent>
              </Card>
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
