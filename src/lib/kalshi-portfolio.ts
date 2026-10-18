import type { LegOutcome, ParlayStatus } from "@/generated/prisma/enums";

/**
 * Pure helpers for turning Kalshi portfolio data (fills, settlements, market
 * results) into what the app stores. No database or network here, so the
 * money and win/loss rules are unit-tested in isolation.
 *
 * Kalshi sends dollar amounts as strings ("0.3070") and contract counts as
 * fixed-point strings ("6.21").
 */

export interface KalshiFill {
  action: string; // "buy" | "sell"
  outcome_side: string; // "yes" | "no"
  count_fp: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  fee_cost: string;
  created_time: string;
  market_ticker?: string;
  ticker?: string;
}

export interface KalshiSettlement {
  ticker: string;
  market_result: string; // "yes" | "no" | "void" | ...
  yes_count_fp: string;
  no_count_fp: string;
  revenue: number; // cents returned
  fee_cost: string;
  settled_time: string;
}

export function dollars(value: string | number | undefined | null): number {
  const n = typeof value === "number" ? value : parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
}

export interface PositionSummary {
  ticker: string;
  /** The side held. When both sides were traded, the side with the larger net count. */
  side: "yes" | "no";
  /** Net contracts held (bought minus sold). */
  contracts: number;
  /** Net dollars paid: buys minus sell proceeds, fees excluded. */
  costDollars: number;
  feesDollars: number;
  /** Average price paid per contract, 0-1. */
  avgPrice: number;
  firstFillAt: Date;
}

const fillTicker = (f: KalshiFill) => f.market_ticker ?? f.ticker ?? "";

/** Groups fills by market and nets buys against sells. Markets with no net position are dropped only if never held. */
export function summarizeFills(fills: KalshiFill[]): PositionSummary[] {
  const byTicker = new Map<string, KalshiFill[]>();
  for (const f of fills) {
    const t = fillTicker(f);
    if (!t) continue;
    byTicker.set(t, [...(byTicker.get(t) ?? []), f]);
  }

  const out: PositionSummary[] = [];
  for (const [ticker, list] of byTicker) {
    const net = { yes: 0, no: 0 };
    const cost = { yes: 0, no: 0 };
    let fees = 0;
    let first = Infinity;

    for (const f of list) {
      const side = f.outcome_side === "no" ? "no" : "yes";
      const count = dollars(f.count_fp);
      const price = dollars(side === "yes" ? f.yes_price_dollars : f.no_price_dollars);
      const sign = f.action === "sell" ? -1 : 1;
      net[side] += sign * count;
      cost[side] += sign * count * price;
      fees += dollars(f.fee_cost);
      first = Math.min(first, new Date(f.created_time).getTime());
    }

    const side: "yes" | "no" = net.yes >= net.no ? "yes" : "no";
    const contracts = net[side];
    const costDollars = cost[side];
    out.push({
      ticker,
      side,
      contracts,
      costDollars,
      feesDollars: fees,
      avgPrice: contracts > 0 ? costDollars / contracts : 0,
      firstFillAt: new Date(first),
    });
  }
  return out.sort((a, b) => a.firstFillAt.getTime() - b.firstFillAt.getTime());
}

/** Dollars returned by a settlement (Kalshi reports revenue in cents). */
export function settlementPayoutDollars(s: KalshiSettlement): number {
  return s.revenue / 100;
}

/**
 * Did the bet win? A void/refunded market is a push. Otherwise the bet won if
 * it returned money. Using revenue rather than the result string covers a
 * position held on either side.
 */
export function settlementStatus(s: KalshiSettlement, costDollars: number): ParlayStatus {
  const result = s.market_result.toLowerCase();
  if (result === "void" || result === "voided" || result === "cancelled" || result === "canceled") return "PUSH";
  const payout = settlementPayoutDollars(s);
  if (payout <= 0) return "LOST";
  // A refund of exactly the cost is a push, not a win.
  if (Math.abs(payout - costDollars) < 0.005 && costDollars > 0 && result !== "yes" && result !== "no") return "PUSH";
  return "WON";
}

/** A leg's outcome from the leg market's own result: the side taken versus how the market resolved. */
export function legOutcomeFromMarket(side: "YES" | "NO", result: string | null | undefined): LegOutcome {
  const r = (result ?? "").toLowerCase();
  if (r === "yes") return side === "YES" ? "WON" : "LOST";
  if (r === "no") return side === "NO" ? "WON" : "LOST";
  if (r === "void" || r === "voided" || r === "cancelled" || r === "canceled") return "PUSH";
  return "PENDING";
}

/** Order-independent key for a set of legs, to recognise the same parlay built locally and placed on Kalshi. */
export function legSetKey(legs: { marketKey: string; side: "YES" | "NO" }[]): string {
  return legs
    .map((l) => `${l.marketKey}:${l.side}`)
    .sort()
    .join("|");
}
