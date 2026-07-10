import Link from "next/link";
import { db } from "@/lib/db";
import { ALL_LEAGUES } from "@/lib/sync";
import { AdminControls } from "@/components/admin-controls";
import { StatusBadge } from "@/components/status-badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

const LEAGUE_LABEL: Record<string, string> = {
  NBA: "NBA",
  NFL: "NFL",
  EPL: "Premier League",
  LALIGA: "La Liga",
  WORLD_CUP: "World Cup",
};

function formatKickoff(date: Date) {
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function upcomingByLeague() {
  const games = await db.game.findMany({
    where: {
      status: "SCHEDULED",
      startTime: { gte: new Date() },
      markets: { some: {} },
    },
    include: { homeTeam: true, awayTeam: true, markets: true },
    orderBy: { startTime: "asc" },
    take: 60,
  });

  const byLeague = new Map<string, typeof games>();
  for (const game of games) {
    const list = byLeague.get(game.league) ?? [];
    if (list.length < 5) {
      list.push(game);
      byLeague.set(game.league, list);
    }
  }
  return byLeague;
}

export default async function DashboardPage() {
  const [byLeague, recentParlays] = await Promise.all([
    upcomingByLeague(),
    db.parlay.findMany({
      include: { legs: true },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  ]);

  const leaguesWithGames = ALL_LEAGUES.filter((l) => byLeague.has(l));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Upcoming games with open Kalshi markets and recent parlay activity.
          </p>
        </div>
        <AdminControls />
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Upcoming games</h2>
          <Button variant="link" size="sm" render={<Link href="/builder" />}>
            Build a parlay
          </Button>
        </div>

        {leaguesWithGames.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No upcoming games with linked markets yet. Run a sports sync and a
              Kalshi sync to populate data.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {leaguesWithGames.map((league) => (
              <Card key={league}>
                <CardHeader>
                  <CardTitle>{LEAGUE_LABEL[league] ?? league}</CardTitle>
                  <CardDescription>Next {byLeague.get(league)!.length} games</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {byLeague.get(league)!.map((game) => (
                    <div
                      key={game.id}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span className="truncate">
                        {game.awayTeam.shortName ?? game.awayTeam.name} @{" "}
                        {game.homeTeam.shortName ?? game.homeTeam.name}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                        <Badge variant="outline">{game.markets.length} mkt</Badge>
                        {formatKickoff(game.startTime)}
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Recent parlays</h2>
          <Button variant="link" size="sm" render={<Link href="/history" />}>
            View all
          </Button>
        </div>

        {recentParlays.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No parlays built yet. Head to the builder to create your first one.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Legs</TableHead>
                  <TableHead>Combined</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentParlays.map((parlay) => (
                  <TableRow key={parlay.id}>
                    <TableCell>{formatKickoff(parlay.createdAt)}</TableCell>
                    <TableCell>{parlay.legs.length}</TableCell>
                    <TableCell>
                      {parlay.combinedProbability != null
                        ? `${(parlay.combinedProbability * 100).toFixed(1)}%`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={parlay.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>
    </div>
  );
}
