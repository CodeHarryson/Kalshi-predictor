import { describe, expect, it } from "vitest";
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

const fill = (o: Partial<KalshiFill>): KalshiFill => ({
  action: "buy",
  outcome_side: "yes",
  count_fp: "1.00",
  yes_price_dollars: "0.5000",
  no_price_dollars: "0.5000",
  fee_cost: "0.0000",
  created_time: "2026-10-18T06:14:50Z",
  market_ticker: "KXMVE-A",
  ...o,
});

const settlement = (o: Partial<KalshiSettlement>): KalshiSettlement => ({
  ticker: "KXMVE-A",
  market_result: "yes",
  yes_count_fp: "1.00",
  no_count_fp: "0.00",
  revenue: 100,
  fee_cost: "0.00",
  settled_time: "2026-10-18T10:00:00Z",
  ...o,
});

describe("dollars", () => {
  it("parses Kalshi's string amounts and tolerates junk", () => {
    expect(dollars("0.3070")).toBeCloseTo(0.307);
    expect(dollars(12)).toBe(12);
    expect(dollars("")).toBe(0);
    expect(dollars(undefined)).toBe(0);
    expect(dollars("abc")).toBe(0);
  });
});

describe("summarizeFills", () => {
  it("reproduces a real combo: 6.21 contracts at $0.307 cost $1.9065", () => {
    const [p] = summarizeFills([fill({ count_fp: "6.21", yes_price_dollars: "0.3070", no_price_dollars: "0.6930", fee_cost: "0.092530" })]);
    expect(p.side).toBe("yes");
    expect(p.contracts).toBeCloseTo(6.21);
    expect(p.costDollars).toBeCloseTo(1.90647, 5);
    expect(p.avgPrice).toBeCloseTo(0.307, 6);
    expect(p.feesDollars).toBeCloseTo(0.09253, 5);
  });

  it("combines several fills into a size-weighted average price", () => {
    const [p] = summarizeFills([
      fill({ count_fp: "2.00", yes_price_dollars: "0.4000" }),
      fill({ count_fp: "3.00", yes_price_dollars: "0.5000", created_time: "2026-10-18T07:00:00Z" }),
    ]);
    expect(p.contracts).toBe(5);
    expect(p.costDollars).toBeCloseTo(2.3);
    expect(p.avgPrice).toBeCloseTo(0.46);
    expect(p.firstFillAt.toISOString()).toBe("2026-10-18T06:14:50.000Z");
  });

  it("prices a NO position at the NO price", () => {
    const [p] = summarizeFills([fill({ outcome_side: "no", count_fp: "4.00", yes_price_dollars: "0.8000", no_price_dollars: "0.2000" })]);
    expect(p.side).toBe("no");
    expect(p.costDollars).toBeCloseTo(0.8);
  });

  it("nets a sell against the buys", () => {
    const [p] = summarizeFills([
      fill({ count_fp: "10.00", yes_price_dollars: "0.4000" }),
      fill({ action: "sell", count_fp: "4.00", yes_price_dollars: "0.6000" }),
    ]);
    expect(p.contracts).toBe(6);
    expect(p.costDollars).toBeCloseTo(4 - 2.4);
  });

  it("keeps markets separate, orders them by first fill, and falls back to `ticker`", () => {
    const out = summarizeFills([
      fill({ market_ticker: "LATER", created_time: "2026-10-18T09:00:00Z" }),
      fill({ market_ticker: undefined, ticker: "EARLIER", created_time: "2026-10-18T01:00:00Z" }),
    ]);
    expect(out.map((p) => p.ticker)).toEqual(["EARLIER", "LATER"]);
  });
});

describe("settlements", () => {
  it("reports revenue in cents as dollars", () => {
    expect(settlementPayoutDollars(settlement({ revenue: 517 }))).toBeCloseTo(5.17);
  });

  it("marks money back as WON and nothing back as LOST", () => {
    expect(settlementStatus(settlement({ revenue: 304 }), 1.9456)).toBe("WON");
    expect(settlementStatus(settlement({ market_result: "no", revenue: 0 }), 0.94869)).toBe("LOST");
  });

  it("treats a void as a push even though money came back", () => {
    expect(settlementStatus(settlement({ market_result: "void", revenue: 190 }), 1.9)).toBe("PUSH");
  });
});

describe("legOutcomeFromMarket", () => {
  it("grades the side taken against the market result", () => {
    expect(legOutcomeFromMarket("YES", "yes")).toBe("WON");
    expect(legOutcomeFromMarket("YES", "no")).toBe("LOST");
    expect(legOutcomeFromMarket("NO", "no")).toBe("WON");
    expect(legOutcomeFromMarket("NO", "yes")).toBe("LOST");
  });

  it("is PENDING until the market resolves, and PUSH when voided", () => {
    expect(legOutcomeFromMarket("YES", "")).toBe("PENDING");
    expect(legOutcomeFromMarket("YES", null)).toBe("PENDING");
    expect(legOutcomeFromMarket("YES", "void")).toBe("PUSH");
  });
});

describe("legSetKey", () => {
  it("ignores leg order but not the side", () => {
    const a = legSetKey([{ marketKey: "m1", side: "YES" }, { marketKey: "m2", side: "NO" }]);
    const b = legSetKey([{ marketKey: "m2", side: "NO" }, { marketKey: "m1", side: "YES" }]);
    const c = legSetKey([{ marketKey: "m1", side: "NO" }, { marketKey: "m2", side: "NO" }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
