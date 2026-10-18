import { db } from "@/lib/db";
import type { LegOutcome } from "@/generated/prisma/enums";
import {
  fetchMarketDetail,
  fetchPortfolioFills,
  fetchPortfolioSettlements,
  type KalshiMarketDetail,
} from "./providers/kalshi";
import {
  dollars,
  legOutcomeFromMarket,
  legSetKey,
  settlementPayoutDollars,
  settlementStatus,
  summarizeFills,
  type KalshiFill,
  type KalshiSettlement,
} from "./kalshi-portfolio";
import { resolveMarketFavoredSide } from "./scoring/composite";
import { ELO_CONFIG } from "./scoring/elo";
import { scoreGameSideProbability } from "./scoring/leg-scorer";

export interface KalshiImportSummary {
  /** Distinct Kalshi bets found (combos and single markets). */
  bets: number;
  created: number;
  updated: number;
  /** Bets matched to a parlay you had already built in the app. */
  adopted: number;
  /** Bets skipped because the app can't represent them (e.g. a NO on a whole combo). */
  skipped: number;
}

interface LegDraft {
  ticker: string;
  side: "YES" | "NO";
  localMarketId: string | null;
  gameId: string | null;
  description: string;
  predictedProbability: number;
  marketImpliedProbability: number;
  outcome: LegOutcome;
}

type ParlayStatusValue = "PENDING" | "WON" | "LOST" | "PUSH";
interface ParlayUpdate {
  status: ParlayStatusValue;
  stake: number;
  payout: number | null;
  notes: string;
}

/**
 * Identifies the real-world outcome a leg bets on, so "Houston NOT to win" and
 * "Jacksonville to win" match: in a two-team game they are the same bet, even
 * though they sit on different Kalshi markets with different sides. Soccer's
 * draw makes that equivalence false, so there the market and side stay literal.
 */
function makeOutcomeKeyer() {
  const cache = new Map<string, Promise<string>>();
  const compute = async (marketId: string, side: "YES" | "NO"): Promise<string> => {
    const market = await db.kalshiMarket.findUnique({
      where: { id: marketId },
      include: { game: { include: { homeTeam: true, awayTeam: true } } },
    });
    const game = market?.game;
    if (!market || !game) return `${marketId}:${side}`;
    const favored = resolveMarketFavoredSide(
      market.yesSubTitle ?? market.title,
      game.homeTeam.name,
      game.homeTeam.shortName,
      game.awayTeam.name,
      game.awayTeam.shortName
    );
    if (!favored) return `${marketId}:${side}`;
    if (ELO_CONFIG[game.league].hasDraws || favored === "draw") return `${game.id}:${favored}:${side}`;
    const winner = side === "YES" ? favored : favored === "home" ? "away" : "home";
    return `${game.id}:wins:${winner}`;
  };
  return (marketId: string, side: "YES" | "NO") => {
    const k = `${marketId}:${side}`;
    if (!cache.has(k)) cache.set(k, compute(marketId, side));
    return cache.get(k)!;
  };
}
type OutcomeKeyer = ReturnType<typeof makeOutcomeKeyer>;

/** Pairs each existing leg with the imported leg that bets the same outcome. */
async function matchLegs(
  existingLegs: { id: string; kalshiMarketId: string | null; side: "YES" | "NO" }[],
  drafts: LegDraft[],
  keyOf: OutcomeKeyer
): Promise<Map<string, LegDraft>> {
  const draftByKey = new Map<string, LegDraft>();
  for (const d of drafts) if (d.localMarketId) draftByKey.set(await keyOf(d.localMarketId, d.side), d);
  const out = new Map<string, LegDraft>();
  for (const el of existingLegs) {
    if (!el.kalshiMarketId) continue;
    const d = draftByKey.get(await keyOf(el.kalshiMarketId, el.side));
    if (d) out.set(el.id, d);
  }
  return out;
}

const clamp01 = (p: number) => Math.min(0.999, Math.max(0.001, p));

async function mapInBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/** Cheap in-run cache so a market shared by several combos is fetched once. */
function marketLookup() {
  const cache = new Map<string, Promise<KalshiMarketDetail | null>>();
  return (ticker: string) => {
    if (!cache.has(ticker)) cache.set(ticker, fetchMarketDetail(ticker));
    return cache.get(ticker)!;
  };
}

/** Best current YES price for a leg market, 0-1; null when Kalshi gives none. */
function currentYesPrice(m: KalshiMarketDetail | null): number | null {
  if (!m) return null;
  for (const v of [m.last_price_dollars, m.yes_ask_dollars, m.yes_bid_dollars]) {
    const n = dollars(v);
    if (n > 0 && n < 1) return n;
  }
  return null;
}

async function buildLeg(
  ticker: string,
  side: "YES" | "NO",
  detail: KalshiMarketDetail | null,
  entryPriceFallback: number
): Promise<LegDraft> {
  const outcome = legOutcomeFromMarket(side, detail?.result);
  const settled = outcome !== "PENDING";

  const local = await db.kalshiMarket.findUnique({
    where: { ticker },
    include: { game: { include: { homeTeam: true, awayTeam: true } } },
  });
  const game = local?.game ?? null;

  let description = `${detail?.title ?? ticker}${side === "NO" ? " — NO" : ""}`;
  let modelYesProbability: number | null = null;

  if (local && game) {
    const favored = resolveMarketFavoredSide(
      local.yesSubTitle ?? local.title,
      game.homeTeam.name,
      game.homeTeam.shortName,
      game.awayTeam.name,
      game.awayTeam.shortName
    );
    if (favored) {
      const label =
        favored === "draw" ? "Draw" : favored === "home" ? game.homeTeam.name : game.awayTeam.name;
      const pick =
        favored === "draw"
          ? side === "YES" ? "Draw" : "No draw"
          : side === "YES" ? `${label} to win` : `${label} NOT to win`;
      description = `${game.awayTeam.name} @ ${game.homeTeam.name} — ${pick}`;
      // Only a not-yet-decided leg gets a model estimate: once a game is final
      // its result is already inside the ratings, so the number would be hindsight.
      if (!settled && game.status !== "FINAL") {
        modelYesProbability = (await scoreGameSideProbability(game.id, favored))?.probability ?? null;
      }
    }
  }

  const yesPrice = currentYesPrice(detail);
  const marketYes = settled ? null : yesPrice;
  const sideProb = (yes: number) => (side === "YES" ? yes : 1 - yes);

  const predicted =
    modelYesProbability !== null
      ? sideProb(modelYesProbability)
      : marketYes !== null
        ? sideProb(marketYes)
        : entryPriceFallback;

  return {
    ticker,
    side,
    localMarketId: local?.id ?? null,
    gameId: game?.id ?? null,
    description,
    predictedProbability: clamp01(predicted),
    marketImpliedProbability: clamp01(marketYes !== null ? sideProb(marketYes) : entryPriceFallback),
    outcome,
  };
}

/**
 * Pulls the account's bets from Kalshi and mirrors them as parlays: each
 * combo (or single market) with its legs, entry price, stake, and - once
 * settled - the result and payout. Safe to run repeatedly: a bet is keyed by
 * its Kalshi ticker, so a re-import refreshes status and payout in place.
 *
 * Kalshi is the source of truth for imported bets. A parlay you built here and
 * then placed on Kalshi is recognised by its legs and adopted rather than
 * duplicated, keeping its feature logs so the settled result still feeds
 * model retraining.
 */
export async function importKalshiPortfolio(): Promise<KalshiImportSummary> {
  const [fills, settlements] = await Promise.all([
    fetchPortfolioFills<KalshiFill>(),
    fetchPortfolioSettlements<KalshiSettlement>(),
  ]);
  if (!fills || !settlements) {
    throw new Error("Could not read your Kalshi portfolio. Check KALSHI_KEY_ID / KALSHI_PRIVATE_KEY_PATH and try again.");
  }

  const settlementByTicker = new Map(settlements.map((s) => [s.ticker, s]));
  const positions = summarizeFills(fills).filter(
    (p) => p.contracts > 0 || settlementByTicker.has(p.ticker)
  );
  const lookup = marketLookup();
  const keyOf = makeOutcomeKeyer();

  const summary: KalshiImportSummary = { bets: positions.length, created: 0, updated: 0, adopted: 0, skipped: 0 };

  for (const pos of positions) {
    const detail = await lookup(pos.ticker);
    const comboLegs = detail?.mve_selected_legs ?? [];
    const isCombo = comboLegs.length > 0;

    // A NO on an entire combo (betting the parlay fails) can't be shown as legs.
    if (isCombo && pos.side === "no") {
      summary.skipped += 1;
      continue;
    }

    const legSpecs = isCombo
      ? comboLegs.map((l) => ({ ticker: l.market_ticker, side: (l.side === "no" ? "NO" : "YES") as "YES" | "NO" }))
      : [{ ticker: pos.ticker, side: (pos.side === "no" ? "NO" : "YES") as "YES" | "NO" }];

    // Per-leg implied price when a leg's own price is gone (settled): spread the
    // entry price of the whole bet evenly, geometrically, across its legs.
    const entryPerLeg = clamp01(Math.pow(Math.max(pos.avgPrice, 0.001), 1 / legSpecs.length));

    const legDetails = await mapInBatches(legSpecs, 5, (l) => (isCombo ? lookup(l.ticker) : Promise.resolve(detail)));
    const legs = await Promise.all(legSpecs.map((l, i) => buildLeg(l.ticker, l.side, legDetails[i], entryPerLeg)));

    const settlement = settlementByTicker.get(pos.ticker);
    const status = settlement ? settlementStatus(settlement, pos.costDollars) : "PENDING";
    const payout = settlement ? settlementPayoutDollars(settlement) : null;
    const settledAt = settlement ? new Date(settlement.settled_time) : null;
    const combined = legs.reduce((p, l) => p * l.predictedProbability, 1);

    const notes =
      `Imported from Kalshi · ${pos.contracts.toFixed(2)} contract${pos.contracts === 1 ? "" : "s"} ` +
      `@ $${pos.avgPrice.toFixed(3)} (entry implied ${(pos.avgPrice * 100).toFixed(1)}%) · ` +
      `fees $${(pos.feesDollars + dollars(settlement?.fee_cost)).toFixed(2)}`;

    const parlayData = { status, stake: round2(pos.costDollars), payout, notes, combinedProbability: combined };

    const existing = await db.parlay.findUnique({ where: { externalId: pos.ticker }, include: { legs: true } });

    if (existing) {
      if (existing.source === "kalshi") {
        await replaceLegs(existing.id, legs, settledAt, parlayData);
      } else {
        // Adopted earlier: keep the legs you built; only refresh their results.
        await updateLegOutcomes(existing.id, await matchLegs(existing.legs, legs, keyOf), settledAt, {
          status, stake: parlayData.stake, payout, notes,
        });
      }
      summary.updated += 1;
      continue;
    }

    // Did you already build this exact parlay here? Then link to it. Legs are
    // compared by the outcome they bet on, not by literal market and side.
    let adopted: Awaited<ReturnType<typeof findAdoptable>> = null;
    if (legs.every((l) => l.localMarketId)) {
      adopted = await findAdoptable(legs, pos.firstFillAt, keyOf);
    }

    if (adopted) {
      await db.parlay.update({
        where: { id: adopted.id },
        data: { externalId: pos.ticker, status, stake: parlayData.stake, payout, notes: [adopted.notes, notes].filter(Boolean).join(" | ") },
      });
      await updateLegOutcomes(adopted.id, await matchLegs(adopted.legs, legs, keyOf), settledAt, null);
      summary.adopted += 1;
      continue;
    }

    await db.$transaction(async (tx) => {
      const created = await tx.parlay.create({
        data: { ...parlayData, source: "kalshi", externalId: pos.ticker, createdAt: pos.firstFillAt },
      });
      await tx.parlayLeg.createMany({
        data: legs.map((l) => legRow(created.id, l, settledAt)),
      });
    });
    summary.created += 1;
  }

  return summary;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function legRow(parlayId: string, l: LegDraft, settledAt: Date | null) {
  return {
    parlayId,
    kalshiMarketId: l.localMarketId,
    gameId: l.gameId,
    description: l.description,
    side: l.side,
    legKind: "GAME_WINNER" as const,
    predictedProbability: l.predictedProbability,
    marketImpliedProbability: l.marketImpliedProbability,
    actualOutcome: l.outcome,
    settledAt: l.outcome === "PENDING" ? null : settledAt,
  };
}

async function replaceLegs(
  parlayId: string,
  legs: LegDraft[],
  settledAt: Date | null,
  parlayData: ParlayUpdate & { combinedProbability: number }
) {
  await db.$transaction([
    db.parlayLeg.deleteMany({ where: { parlayId } }),
    db.parlay.update({ where: { id: parlayId }, data: parlayData }),
    db.parlayLeg.createMany({ data: legs.map((l) => legRow(parlayId, l, settledAt)) }),
  ]);
}

/** A not-yet-linked parlay you built here that bets exactly the same outcomes, placed before the first fill. */
async function findAdoptable(legs: LegDraft[], firstFillAt: Date, keyOf: OutcomeKeyer) {
  const wanted = legSetKey(
    await Promise.all(legs.map(async (l) => ({ marketKey: await keyOf(l.localMarketId!, l.side), side: "YES" as const })))
  );
  const candidates = await db.parlay.findMany({
    where: { externalId: null, source: { in: ["manual", "suggestion"] }, createdAt: { lte: firstFillAt } },
    include: { legs: true },
  });
  for (const c of candidates) {
    if (c.legs.length !== legs.length || !c.legs.every((l) => l.kalshiMarketId)) continue;
    const have = legSetKey(
      await Promise.all(c.legs.map(async (l) => ({ marketKey: await keyOf(l.kalshiMarketId!, l.side), side: "YES" as const })))
    );
    if (have === wanted) return c;
  }
  return null;
}

/** Updates results on existing legs (already paired with their imported counterpart), including their retraining logs. */
async function updateLegOutcomes(
  parlayId: string,
  matches: Map<string, LegDraft>,
  settledAt: Date | null,
  parlayUpdate: ParlayUpdate | null
) {
  const ops = [];
  for (const [legId, match] of matches) {
    if (match.outcome === "PENDING") continue;
    ops.push(
      db.parlayLeg.update({ where: { id: legId }, data: { actualOutcome: match.outcome, settledAt } }),
      db.modelFeatureLog.updateMany({ where: { parlayLegId: legId }, data: { actualOutcome: match.outcome } })
    );
  }
  if (parlayUpdate) ops.push(db.parlay.update({ where: { id: parlayId }, data: parlayUpdate }));
  if (ops.length) await db.$transaction(ops);
}
