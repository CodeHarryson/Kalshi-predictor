import Link from "next/link";
import { db } from "@/lib/db";
import { ALL_LEAGUES } from "@/lib/sync";
import { buildRecommendedCombos } from "@/lib/builder";
import { fetchAccountBalance } from "@/lib/providers/kalshi";
import { recommendStakeCents } from "@/lib/scoring/parlay";
import { AdminTokenGate } from "@/components/admin-token-gate";
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

function formatDollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

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
  const [byLeague, recentParlays, combos, balance] = await Promise.all([
    upcomingByLeague(),
    db.parlay.findMany({
      include: { legs: true },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    buildRecommendedCombos(ALL_LEAGUES, { limit: 6 }),
    fetchAccountBalance(),
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
        <div className="flex items-center gap-3">
          <Badge variant="outline">
            Kalshi balance:{" "}
            {balance ? formatDollars(balance.balanceCents) : "unavailable"}
          </Badge>
          <AdminTokenGate />
        </div>
      </div>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Upcoming games</h2>
          <Button
            variant="link"
            size="sm"
            nativeButton={false}
            render={<Link href="/builder" />}
          >
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
          <h2 className="text-lg font-medium">Recommended combos</h2>
          <Button
            variant="link"
            size="sm"
            nativeButton={false}
            render={<Link href="/builder" />}
          >
            Open builder
          </Button>
        </div>

        {combos.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No combo recommendations yet. Sync Kalshi markets so the model
              has up-to-date prices to score.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Legs</TableHead>
                  <TableHead>Leagues</TableHead>
                  <TableHead className="text-right">Combined</TableHead>
                  <TableHead className="text-right">Edge</TableHead>
                  <TableHead className="text-right">Suggested stake</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {combos.map((combo, idx) => {
                  const edgePct = combo.combinedEdge * 100;
                  const edgeTone =
                    edgePct > 0.5
                      ? "text-green-600 dark:text-green-400"
                      : edgePct < -0.5
                        ? "text-red-600 dark:text-red-400"
                        : "text-muted-foreground";
                  const stakeCents = balance
                    ? recommendStakeCents(
                        balance.balanceCents,
                        combo.combinedProbability,
                        combo.combinedMarketImplied
                      )
                    : null;
                  return (
                    <TableRow
                      key={`${idx}-${combo.legs
                        .map((l) => l.kalshiMarketId)
                        .join("-")}`}
                    >
                      <TableCell className="max-w-md">
                        <ul className="flex flex-col gap-1">
                          {combo.legs.map((leg, i) => (
                            <li
                              key={i}
                              className="flex items-center justify-between gap-2 text-sm"
                            >
                              <span className="truncate">{leg.description}</span>
                              <span className="shrink-0 text-muted-foreground">
                                {(leg.predictedProbability * 100).toFixed(0)}%
                              </span>
                            </li>
                          ))}
                        </ul>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {combo.leagues.length === 0 ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            combo.leagues.map((lg) => (
                              <Badge key={lg} variant="outline">
                                {LEAGUE_LABEL[lg] ?? lg}
                              </Badge>
                            ))
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {(combo.combinedProbability * 100).toFixed(1)}%
                      </TableCell>
                      <TableCell className={`text-right ${edgeTone}`}>
                        {edgePct > 0 ? "+" : ""}
                        {edgePct.toFixed(1)}%
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {stakeCents === null ? "—" : formatDollars(stakeCents)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          nativeButton={false}
                          render={
                            <Link
                              href={{
                                pathname: "/builder",
                                query: {
                                  combo: encodeURIComponent(
                                    JSON.stringify(
                                      combo.legs.map((l) => ({
                                        gameId: l.gameId,
                                        kalshiMarketId: l.kalshiMarketId,
                                        description: l.description,
                                        side: l.side,
                                        legKind: l.legKind,
                                        predictedProbability: l.predictedProbability,
                                        marketImpliedProbability: l.marketImpliedProbability,
                                        features: l.features,
                                      }))
                                    )
                                  ),
                                },
                              }}
                            />
                          }
                        >
                          Build
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Recent parlays</h2>
          <Button
            variant="link"
            size="sm"
            nativeButton={false}
            render={<Link href="/history" />}
          >
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
