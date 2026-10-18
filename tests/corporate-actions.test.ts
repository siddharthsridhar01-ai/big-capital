/**
 * Corporate action accounting.
 *
 * A split is a restatement: the share count changes, total cost basis does not,
 * and nothing is realised. These pin that behaviour in BOTH position
 * reconstructions — performance.ts (NAV, holdings) and portfolio.ts (the live
 * dashboard) — because each originally treated a corporate action as a trade,
 * and each got reverse splits wrong in a different way.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  restatePosition,
  planSplit,
  cashInLieu,
  describeSplit,
  splitDedupeKey,
} from "../src/lib/corporate-actions";
import { buildLedgerState, type Transaction } from "../src/lib/performance";
import { aggregatePortfolioFromTransactions, type RawTransaction } from "../src/lib/portfolio";

const D = (n: number | string) => new Decimal(n);
const SEC = "sec_asml";

describe("restatePosition", () => {
  it("preserves total cost basis on a forward split", () => {
    // 10 shares at 1,500 = 15,000 of cost. A 10-for-1 adds 90 shares.
    const r = restatePosition(D(10), D(1500), D(90))!;
    expect(r.quantity.toNumber()).toBe(100);
    expect(r.avgCostNative.toNumber()).toBe(150);
    expect(r.quantity.times(r.avgCostNative).toNumber()).toBe(15000);
  });

  it("preserves total cost basis on a reverse split — the case a trade would get wrong", () => {
    // 25 shares at 10 = 250 of cost. A 1-for-10 leaves 2.5.
    const r = restatePosition(D(25), D(10), D(-22.5))!;
    expect(r.quantity.toNumber()).toBe(2.5);
    expect(r.avgCostNative.toNumber()).toBe(100);
    expect(r.quantity.times(r.avgCostNative).toNumber()).toBe(250);
  });

  it("restates a short the same way", () => {
    const r = restatePosition(D(-10), D(1500), D(-90))!;
    expect(r.quantity.toNumber()).toBe(-100);
    expect(r.avgCostNative.toNumber()).toBe(150);
  });

  it("returns null when restated to nothing", () => {
    expect(restatePosition(D(10), D(5), D(-10))).toBeNull();
  });
});

describe("planSplit", () => {
  it("10-for-1 on whole shares leaves no fraction", () => {
    const p = planSplit(D(10), 10, 1);
    expect(p.exactShares.toNumber()).toBe(100);
    expect(p.fractional.isZero()).toBe(true);
    expect(p.restateDelta.toNumber()).toBe(90);
  });

  it("3-for-2 leaves a fraction to cash out", () => {
    const p = planSplit(D(25), 3, 2);
    expect(p.exactShares.toNumber()).toBe(37.5);
    expect(p.wholeShares.toNumber()).toBe(37);
    expect(p.fractional.toNumber()).toBe(0.5);
  });

  it("1-for-10 reverse split", () => {
    const p = planSplit(D(25), 1, 10);
    expect(p.exactShares.toNumber()).toBe(2.5);
    expect(p.wholeShares.toNumber()).toBe(2);
    expect(p.fractional.toNumber()).toBe(0.5);
  });

  it("truncates toward zero for shorts", () => {
    const p = planSplit(D(-25), 3, 2);
    expect(p.exactShares.toNumber()).toBe(-37.5);
    expect(p.wholeShares.toNumber()).toBe(-37);
    expect(p.fractional.toNumber()).toBe(-0.5);
  });

  it("rejects a nonsensical ratio", () => {
    expect(() => planSplit(D(10), 0, 1)).toThrow();
    expect(() => planSplit(D(10), 2, 0)).toThrow();
  });
});

describe("cashInLieu", () => {
  it("a long sells its fraction and receives cash", () => {
    const c = cashInLieu(D(0.5), D(80));
    expect(c.transactionType).toBe("sell");
    expect(c.quantity.toNumber()).toBe(-0.5);
    expect(c.cashImpact.toNumber()).toBe(40);
  });

  it("a short covers its fraction and pays cash", () => {
    const c = cashInLieu(D(-0.5), D(80));
    expect(c.transactionType).toBe("cover");
    expect(c.quantity.toNumber()).toBe(0.5);
    expect(c.cashImpact.toNumber()).toBe(-40);
  });
});

describe("helpers", () => {
  it("describes ratios the way the market does", () => {
    expect(describeSplit(10, 1)).toBe("10-for-1");
    expect(describeSplit(1, 10)).toBe("1-for-10");
  });
  it("gives one dedupe key per fund, security and ex-date", () => {
    expect(splitDedupeKey("f", "s", "2026-11-02")).toBe(splitDedupeKey("f", "s", "2026-11-02"));
    expect(splitDedupeKey("f", "s", "2026-11-02")).not.toBe(splitDedupeKey("f", "s", "2026-11-03"));
  });
});

// ---------------------------------------------------------------------------
// performance.ts — the reconstruction behind NAV and holdings
// ---------------------------------------------------------------------------
function tx(partial: Partial<Transaction> & Pick<Transaction, "transactionType" | "quantity" | "price" | "executedAt">): Transaction {
  return {
    id: Math.random().toString(),
    fundId: "f",
    securityId: SEC,
    currency: "EUR",
    cashImpact: "0",
    fxRateToBase: "1",
    ...partial,
  } as Transaction;
}

describe("buildLedgerState with a split", () => {
  it("forward split: shares scale up, average cost scales down, cash untouched", () => {
    const txns = [
      tx({ transactionType: "buy", quantity: "10", price: "1500", cashImpact: "-15000", executedAt: new Date("2026-10-19T07:00:00Z") }),
      tx({ transactionType: "corporate_action", quantity: "90", price: "0", executedAt: new Date("2026-11-02T00:00:00Z") }),
    ];
    const s = buildLedgerState(txns, new Date("2026-11-03T00:00:00Z"));
    const pos = s.positions.get(SEC)!;
    expect(pos.quantity.toNumber()).toBe(100);
    expect(pos.avgCostNative.toNumber()).toBe(150);
    expect(s.cashByCurrency.get("EUR")!.toNumber()).toBe(-15000);
  });

  it("reverse split: average cost rises by the ratio rather than staying put", () => {
    const txns = [
      tx({ transactionType: "buy", quantity: "25", price: "10", cashImpact: "-250", executedAt: new Date("2026-10-19T07:00:00Z") }),
      tx({ transactionType: "corporate_action", quantity: "-22.5", price: "0", executedAt: new Date("2026-11-02T00:00:00Z") }),
    ];
    const pos = buildLedgerState(txns, new Date("2026-11-03T00:00:00Z")).positions.get(SEC)!;
    expect(pos.quantity.toNumber()).toBe(2.5);
    expect(pos.avgCostNative.toNumber()).toBe(100);
  });

  it("does not multiply a trade made on the ex-date itself", () => {
    // The restatement is stamped at midnight; an ex-date fill at the open is
    // already in post-split shares and must be added as-is.
    const txns = [
      tx({ transactionType: "buy", quantity: "10", price: "1500", executedAt: new Date("2026-10-19T07:00:00Z") }),
      tx({ transactionType: "corporate_action", quantity: "90", price: "0", executedAt: new Date("2026-11-02T00:00:00Z") }),
      tx({ transactionType: "buy", quantity: "5", price: "150", executedAt: new Date("2026-11-02T08:00:00Z") }),
    ];
    const pos = buildLedgerState(txns, new Date("2026-11-03T00:00:00Z")).positions.get(SEC)!;
    expect(pos.quantity.toNumber()).toBe(105);
  });

  it("keeps the holding's value continuous across the split", () => {
    const before = buildLedgerState(
      [tx({ transactionType: "buy", quantity: "10", price: "1500", executedAt: new Date("2026-10-19T07:00:00Z") })],
      new Date("2026-11-01T23:00:00Z")
    ).positions.get(SEC)!;
    const after = buildLedgerState(
      [
        tx({ transactionType: "buy", quantity: "10", price: "1500", executedAt: new Date("2026-10-19T07:00:00Z") }),
        tx({ transactionType: "corporate_action", quantity: "90", price: "0", executedAt: new Date("2026-11-02T00:00:00Z") }),
      ],
      new Date("2026-11-03T00:00:00Z")
    ).positions.get(SEC)!;
    // Pre-split close 1,600; post-split close 160. Same value, no fake loss.
    expect(before.quantity.times(1600).toNumber()).toBe(after.quantity.times(160).toNumber());
  });
});

// ---------------------------------------------------------------------------
// portfolio.ts — the live dashboard's own reconstruction
// ---------------------------------------------------------------------------
function raw(partial: Partial<RawTransaction> & Pick<RawTransaction, "quantity" | "price" | "executedAt">): RawTransaction {
  return { securityId: SEC, currency: "EUR", cashImpact: "0", fxRateToBase: "1", ...partial } as RawTransaction;
}

describe("dashboard reconstruction with a split", () => {
  const meta = [{ id: SEC, ticker: "ASML", name: "ASML", exchange: "AS", currency: "EUR" as const, gicsSector: "Information Technology" }];

  it("books no realised P&L on a reverse split", () => {
    // Treated as a trade, this reduction would have read as selling 22.5
    // shares at zero — a fake realised loss of their entire cost basis.
    const state = aggregatePortfolioFromTransactions(
      "EUR",
      "100000",
      [
        raw({ transactionType: "buy", quantity: "25", price: "10", cashImpact: "-250", executedAt: new Date("2026-10-19T07:00:00Z") }),
        raw({ transactionType: "corporate_action", quantity: "-22.5", price: "0", executedAt: new Date("2026-11-02T00:00:00Z") }),
      ],
      meta,
      new Map([[SEC, { close: "100", date: "2026-11-02" }]])
    );
    const pos = state.positions.get(SEC)!;
    expect(pos.quantity.toNumber()).toBe(2.5);
    expect(pos.avgCostNative.toNumber()).toBe(100);
    expect(pos.realisedPnlBase.toNumber()).toBe(0);
  });

  it("restates a forward split identically to the NAV path", () => {
    const state = aggregatePortfolioFromTransactions(
      "EUR",
      "100000",
      [
        raw({ transactionType: "buy", quantity: "10", price: "1500", cashImpact: "-15000", executedAt: new Date("2026-10-19T07:00:00Z") }),
        raw({ transactionType: "corporate_action", quantity: "90", price: "0", executedAt: new Date("2026-11-02T00:00:00Z") }),
      ],
      meta,
      new Map([[SEC, { close: "160", date: "2026-11-02" }]])
    );
    const pos = state.positions.get(SEC)!;
    expect(pos.quantity.toNumber()).toBe(100);
    expect(pos.avgCostNative.toNumber()).toBe(150);
    expect(pos.realisedPnlBase.toNumber()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------
import { detectCorporateActions, type HeldPriceObservation } from "../src/lib/corporate-actions";

function obs(p: Partial<HeldPriceObservation>): HeldPriceObservation {
  return {
    fund: "european-equity",
    securityId: SEC,
    ticker: "ASML",
    latestDate: "2026-11-02",
    latestClose: D(100),
    previousClose: D(100),
    ...p,
  };
}

describe("detectCorporateActions", () => {
  const TODAY = "2026-11-02";

  it("stays quiet on an ordinary day", () => {
    expect(detectCorporateActions([obs({ latestClose: D(103) })], new Set(), TODAY)).toEqual([]);
  });

  it("flags an unexplained 90% fall — an unprocessed split or spin-off", () => {
    const a = detectCorporateActions([obs({ latestClose: D(10) })], new Set(), TODAY);
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("large_move");
  });

  it("flags a large rise too — the signature of a takeover bid", () => {
    const a = detectCorporateActions([obs({ latestClose: D(140) })], new Set(), TODAY);
    expect(a[0].kind).toBe("large_move");
  });

  it("does not flag a move already explained by a booked split", () => {
    const booked = new Set([`${SEC}|2026-11-02`]);
    expect(detectCorporateActions([obs({ latestClose: D(10) })], booked, TODAY)).toEqual([]);
  });

  it("does not flag a sharp but plausible move under the threshold", () => {
    // A 20% profit-warning drop is real news, not a corporate action.
    expect(detectCorporateActions([obs({ latestClose: D(80) })], new Set(), TODAY)).toEqual([]);
  });

  it("flags a holding that has stopped being priced — a likely delisting", () => {
    const a = detectCorporateActions([obs({ latestDate: "2026-10-20" })], new Set(), TODAY);
    expect(a[0].kind).toBe("stale_price");
  });

  it("does not flag a long weekend or exchange holiday", () => {
    expect(detectCorporateActions([obs({ latestDate: "2026-10-29" })], new Set(), TODAY)).toEqual([]);
  });

  it("flags a holding with no price at all", () => {
    const a = detectCorporateActions([obs({ latestDate: null, latestClose: null })], new Set(), TODAY);
    expect(a[0].kind).toBe("stale_price");
  });
});

// ---------------------------------------------------------------------------
// Early-warning classification
// ---------------------------------------------------------------------------
import { classifyFiling, classifyHeadline } from "../src/lib/corporate-actions";

describe("classifyFiling", () => {
  it("treats a delisting notice as critical", () => {
    expect(classifyFiling("25-NSE")?.severity).toBe("critical");
  });
  it("flags the early signs of a deal", () => {
    expect(classifyFiling("SC 13D")?.severity).toBe("warning");
    expect(classifyFiling("425")?.severity).toBe("warning");
    expect(classifyFiling("S-4")?.severity).toBe("warning");
  });
  it("ignores routine filings", () => {
    expect(classifyFiling("10-Q")).toBeNull();
    expect(classifyFiling("10-K")).toBeNull();
    expect(classifyFiling("8-K")).toBeNull();
  });
});

describe("classifyHeadline", () => {
  it("catches a held company being taken over", () => {
    expect(classifyHeadline("Rival agrees to be acquired in $40bn deal")?.label).toBe("possible takeover");
    expect(classifyHeadline("Board rejects takeover bid from private equity")?.label).toBe("possible takeover");
  });

  it("catches UK Takeover Code announcements", () => {
    expect(classifyHeadline("Statement regarding possible offer for the company")?.label).toBe("UK takeover code announcement");
    expect(classifyHeadline("Rule 2.7 announcement: recommended cash offer")).not.toBeNull();
  });

  it("catches spin-offs and demergers", () => {
    expect(classifyHeadline("Unilever completes demerger of ice cream business")?.label).toBe("possible spin-off");
    expect(classifyHeadline("Siemens to spin off energy unit")?.label).toBe("possible spin-off");
  });

  it("does not fire when the held company is the BUYER", () => {
    // These are acquisitions BY the holding — not an event for its shareholders.
    expect(classifyHeadline("ASML completes acquisition of optics supplier")).toBeNull();
    expect(classifyHeadline("Nestlé buys stake in coffee chain")).toBeNull();
  });

  it("ignores ordinary news", () => {
    expect(classifyHeadline("Shares rise after strong quarterly results")).toBeNull();
    expect(classifyHeadline("CEO to step down at year end")).toBeNull();
  });
});
