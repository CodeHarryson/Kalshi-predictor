import { Suspense } from "react";
import Link from "next/link";
import { buildBestParlayForWindow, placeAsPick, type BestParlay, type RiskMode } from "@/lib/best-parlay";
import { fetchAccountBalance } from "@/lib/providers/kalshi";
import { recommendStakeCents } from "@/lib/scoring/parlay";
import { BuildComboButton } from "@/components/build-combo-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const pct = (p: number, digits = 0) => `${(p * 100).toFixed(digits)}%`;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col" title={hint}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </div>
  );
}

// Kalshi's balance endpoint is slow, so the stake streams in on its own instead
// of holding back the pick itself.
async function StakeStat({ parlay }: { parlay: BestParlay }) {
  const balance = await fetchAccountBalance();
  const cents = balance ? recommendStakeCents(balance.balanceCents, parlay.shrunkProbability, parlay.marketImplied) : null;
  return (
    <Stat
      label="Suggested stake"
      value={cents === null ? "—" : money(cents)}
      hint="Fractional Kelly on the win chance, capped at 5% of your balance."
    />
  );
}

function legsOf(parlay: BestParlay) {
  return parlay.legs.map((l) => ({
    gameId: l.gameId,
    kalshiMarketId: l.kalshiMarketId,
    description: l.description,
    side: l.side,
    legKind: l.legKind,
    predictedProbability: l.predictedProbability,
    marketImpliedProbability: l.marketImpliedProbability,
    features: l.features,
  }));
}

/**
 * The single best parlay for the rest of today (local time), from games that
 * haven't started. Streams in behind Suspense: scoring is the slow part.
 */
function RiskToggle({ risk }: { risk: RiskMode }) {
  const item = (value: RiskMode, label: string, href: string) => (
    <Link
      href={href}
      scroll={false}
      aria-pressed={risk === value}
      className={
        "rounded-md px-3 py-1 text-xs font-medium transition-colors " +
        (risk === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")
      }
    >
      {label}
    </Link>
  );
  return (
    <div className="inline-flex gap-1 rounded-lg border p-0.5" role="group" aria-label="Risk level">
      {item("balanced", "Balanced", "/")}
      {item("aggressive", "Aggressive", "/?risk=aggressive")}
    </div>
  );
}

export async function BestParlaySection({ risk = "balanced" }: { risk?: RiskMode }) {
  const aggressive = risk === "aggressive";
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(24, 0, 0, 0);

  const { best, alternatives, gamesInWindow, inProgress } = await buildBestParlayForWindow({ from: now, to: endOfDay }, 2, undefined, risk);

  return (
    <section className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{aggressive ? "Aggressive parlay for today" : "Best parlay for today"}</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">NBA · NFL · College football</Badge>
              <RiskToggle risk={risk} />
            </div>
          </div>
          <CardDescription>
            {aggressive
              ? "Long-shot legs the market underprices, stacked for a big payout. Wins rarely: stake only what you can lose. "
              : ""}
            Picked from {gamesInWindow} game{gamesInWindow === 1 ? "" : "s"} still to start today.
            {inProgress > 0 && (
              <>
                {" "}
                {inProgress} already underway {inProgress === 1 ? "is" : "are"} left out: the model only knows
                pre-game information, so it cannot judge a game once it has started.
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {!best ? (
            <p className="text-sm text-muted-foreground">
              {gamesInWindow < (aggressive ? 3 : 2)
                ? `Fewer than ${aggressive ? "three" : "two"} qualifying games are left today. Try the builder's day filter for tomorrow.`
                : aggressive
                  ? "No long-shot combo of three or more games keeps an edge today once the model is pulled toward Kalshi's prices. Switch back to Balanced for the safer pick."
                  : "No parlay has an edge today once the model is pulled toward Kalshi's prices. That is a real answer: skipping beats a forced bet."}
            </p>
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {best.legs.map((leg) => {
                  const alt = placeAsPick(leg.description);
                  const game = leg.description.split(" — ")[0];
                  return (
                    <li key={leg.kalshiMarketId + leg.side} className="flex items-start justify-between gap-3 text-sm">
                      <div className="flex flex-col">
                        <span className="font-medium">{alt ?? leg.description.split(" — ")[1] ?? leg.description}</span>
                        <span className="text-xs text-muted-foreground" suppressHydrationWarning>
                          {game} · {time(leg.startTime)}
                          {alt && ` · same as "${leg.description.split(" — ")[1]}"`}
                        </span>
                      </div>
                      <span className="shrink-0 text-right text-xs text-muted-foreground">
                        model {pct(leg.predictedProbability)} · market {pct(leg.marketImpliedProbability)}
                      </span>
                    </li>
                  );
                })}
              </ul>

              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="flex flex-wrap gap-x-8 gap-y-3">
                  <Stat
                    label="Win chance"
                    value={pct(best.shrunkProbability, 1)}
                    hint="Model probability pulled halfway toward the market price. The raw model says more (see below)."
                  />
                  {aggressive && (
                    <Stat label="Payout" value={`${(1 / best.marketImplied).toFixed(1)}x`} hint="Return per $1 staked at the estimated market price, if every leg wins." />
                  )}
                  <Stat label="Market price" value={pct(best.marketImplied, 1)} hint="Product of the legs Kalshi prices: an estimate of what the combo costs." />
                  <Stat label="Expected return" value={`${best.expectedReturn >= 0 ? "+" : ""}${(best.expectedReturn * 100).toFixed(0)}%`} hint="Expected profit per $1 staked at the market price." />
                  <Suspense fallback={<Stat label="Suggested stake" value="…" />}>
                    <StakeStat parlay={best} />
                  </Suspense>
                </div>
                <BuildComboButton legs={legsOf(best)} />
              </div>

              <p className="text-xs text-muted-foreground">
                Raw model win chance {pct(best.modelProbability, 1)}. Compared with Kalshi prices the model gets the
                direction right but overstates its confidence by about half, so the win chance above splits the
                difference. The market price multiplies single-game prices; the combo&apos;s actual price on Kalshi can
                differ, so check it before placing. This saves the parlay here; you place it on Kalshi yourself.
              </p>

              {alternatives.length > 0 && (
                <div className="flex flex-col gap-2 border-t pt-4">
                  <span className="text-xs font-medium text-muted-foreground">Next best</span>
                  {alternatives.map((alt, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate">
                        {alt.legs.map((l) => placeAsPick(l.description) ?? l.description.split(" — ")[1] ?? l.description).join(" + ")}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {pct(alt.shrunkProbability, 1)} vs {pct(alt.marketImplied, 1)} market
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
