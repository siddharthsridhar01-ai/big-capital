/**
 * Takeovers, mergers and spin-offs, end to end.
 *
 * Every plan is run through BOTH position reconstructions — performance.ts
 * (NAV) and portfolio.ts (the dashboard) — and the end state is checked:
 * positions, cash, realised P&L, and that the holding's value is unchanged by
 * the event itself. An event that changed a fund's value on the day it happened
 * would be a fake gain or loss.
 */
import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { planMerger, planSpinOff, type Leg } from "../src/lib/corporate-action-booking";
import { buildLedgerState, type Transaction } from "../src/lib/performance";
import { aggregatePortfolioFromTransactions, type RawTransaction } from "../src/lib/portfolio";

const D = (n: number | string) => new Decimal(n);
const EFFECTIVE = Date.parse("2026-12-01T00:00:00Z");

/** The original holding, then the legs, as ledger rows. */
function ledger(
  opening: { securityId: string; qty: number; price: number; currency?: string },
  legs: Leg[],
  roles: Record<string, { securityId: string; currency: string }>
) {
  const rows = [
    {
      transactionType: opening.qty > 0 ? "buy" : "short",
      securityId: opening.securityId,
      quantity: String(opening.qty),
      price: String(opening.price),
      currency: opening.currency ?? "EUR",
      cashImpact: String(-opening.qty * opening.price),
      fxRateToBase: "1",
      executedAt: new Date("2026-10-19T07:00:00Z"),
    },
    ...legs.map((l) => ({
      transactionType: l.transactionType,
      securityId: roles[l.role].securityId,
      quantity: l.quantity.toString(),
      price: l.price.toString(),
      currency: roles[l.role].currency,
      cashImpact: l.cashImpact.toString(),
      fxRateToBase: "1",
      executedAt: new Date(EFFECTIVE + l.offsetMs),
    })),
  ];
  return rows;
}

function navState(rows: ReturnType<typeof ledger>) {
  return buildLedgerState(
    rows.map((r, i) => ({ id: String(i), fundId: "f", ...r }) as unknown as Transaction),
    new Date("2026-12-02T00:00:00Z")
  );
}

function dashState(rows: ReturnType<typeof ledger>, prices: Record<string, string>) {
  const meta = Object.keys(prices).map((id) => ({
    id, ticker: id, name: id, exchange: "X", currency: "EUR" as const, gicsSector: null,
  }));
  return aggregatePortfolioFromTransactions(
    "EUR",
    "100000",
    rows as unknown as RawTransaction[],
    meta,
    new Map(Object.entries(prices).map(([k, v]) => [k, { close: v, date: "2026-12-01" }]))
  );
}

const EUR = { currency: "EUR" };

// ---------------------------------------------------------------------------
describe("cash takeover", () => {
  // 100 shares bought at 40; taken over for 50 cash.
  const plan = planMerger({
    held: D(100), avgCost: D(40), ratio: D(0), cashPerShare: D(50),
    receivedPrice: D(0), fxReceivedToTarget: D(1),
  });
  const rows = ledger({ securityId: "tgt", qty: 100, price: 40 }, plan.legs, {
    target: { securityId: "tgt", ...EUR },
  });

  it("closes the position", () => {
    expect(navState(rows).positions.has("tgt")).toBe(false);
  });

  it("credits the cash consideration", () => {
    // Opening cost -4,000; takeover +5,000.
    expect(navState(rows).cashByCurrency.get("EUR")!.toNumber()).toBe(1000);
    expect(plan.cashReceived.toNumber()).toBe(5000);
  });

  it("realises the gain on the dashboard", () => {
    const pos = dashState(rows, { tgt: "50" });
    expect(pos.positions.has("tgt")).toBe(false);
    expect(plan.realisedPnl.toNumber()).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
describe("all-share merger", () => {
  // 100 target at 40; each becomes 0.5 acquirer shares, acquirer at 120.
  const plan = planMerger({
    held: D(100), avgCost: D(40), ratio: D(0.5), cashPerShare: D(0),
    receivedPrice: D(120), fxReceivedToTarget: D(1),
  });
  const rows = ledger({ securityId: "tgt", qty: 100, price: 40 }, plan.legs, {
    target: { securityId: "tgt", ...EUR },
    received: { securityId: "acq", ...EUR },
  });

  it("values the target at the shares received", () => {
    expect(plan.fairValuePerShare.toNumber()).toBe(60);
  });

  it("swaps the target for acquirer shares, with no cash moving", () => {
    const s = navState(rows);
    expect(s.positions.has("tgt")).toBe(false);
    expect(s.positions.get("acq")!.quantity.toNumber()).toBe(50);
    expect(s.cashByCurrency.get("EUR")!.toNumber()).toBe(-4000); // only the original purchase
  });

  it("carries the acquirer shares at market", () => {
    expect(navState(rows).positions.get("acq")!.avgCostNative.toNumber()).toBe(120);
  });

  it("does not change the holding's value on the day", () => {
    // Before: 100 target worth 60 each. After: 50 acquirer at 120.
    expect(100 * 60).toBe(navState(rows).positions.get("acq")!.quantity.times(120).toNumber());
  });

  it("realises the gain on the target at fair value", () => {
    expect(plan.realisedPnl.toNumber()).toBe(2000); // (60 - 40) x 100
    const dash = dashState(rows, { tgt: "60", acq: "120" });
    expect(dash.positions.get("acq")!.quantity.toNumber()).toBe(50);
  });
});

// ---------------------------------------------------------------------------
describe("mixed cash-and-share deal", () => {
  // Each target share: 0.25 acquirer (at 100) plus 20 cash.
  const plan = planMerger({
    held: D(100), avgCost: D(40), ratio: D(0.25), cashPerShare: D(20),
    receivedPrice: D(100), fxReceivedToTarget: D(1),
  });
  const rows = ledger({ securityId: "tgt", qty: 100, price: 40 }, plan.legs, {
    target: { securityId: "tgt", ...EUR },
    received: { securityId: "acq", ...EUR },
  });

  it("combines both forms of consideration", () => {
    expect(plan.fairValuePerShare.toNumber()).toBe(45);
    const s = navState(rows);
    expect(s.positions.get("acq")!.quantity.toNumber()).toBe(25);
    expect(s.cashByCurrency.get("EUR")!.toNumber()).toBe(-4000 + 2000);
  });

  it("preserves value: shares plus cash equal the fair value", () => {
    const s = navState(rows);
    const after = s.positions.get("acq")!.quantity.times(100).toNumber() + 2000;
    expect(after).toBe(100 * 45);
  });
});

// ---------------------------------------------------------------------------
describe("fractional entitlement", () => {
  // 25 target x 0.3 = 7.5 acquirer: keep 7, cash in lieu for 0.5.
  const plan = planMerger({
    held: D(25), avgCost: D(40), ratio: D(0.3), cashPerShare: D(0),
    receivedPrice: D(100), fxReceivedToTarget: D(1),
  });
  const rows = ledger({ securityId: "tgt", qty: 25, price: 40 }, plan.legs, {
    target: { securityId: "tgt", ...EUR },
    received: { securityId: "acq", ...EUR },
  });

  it("keeps whole shares and pays for the fraction", () => {
    const s = navState(rows);
    expect(s.positions.get("acq")!.quantity.toNumber()).toBe(7);
    expect(s.cashByCurrency.get("EUR")!.toNumber()).toBe(-1000 + 50);
    expect(plan.receivedShares.toNumber()).toBe(7);
  });
});

// ---------------------------------------------------------------------------
describe("cross-currency merger", () => {
  // A GBP holding acquired for USD shares; 1 USD = 0.8 GBP.
  const plan = planMerger({
    held: D(100), avgCost: D(40), ratio: D(0.5), cashPerShare: D(0),
    receivedPrice: D(150), fxReceivedToTarget: D(0.8),
  });
  it("values the consideration in the target's currency", () => {
    // 0.5 x 150 USD x 0.8 = 60 GBP a share.
    expect(plan.fairValuePerShare.toNumber()).toBe(60);
  });
  it("books the received shares at their own currency's price", () => {
    const received = plan.legs.find((l) => l.role === "received")!;
    expect(received.price.toNumber()).toBe(150);
  });
});

// ---------------------------------------------------------------------------
describe("short holders", () => {
  it("a short in a cash takeover pays the consideration to close", () => {
    const plan = planMerger({
      held: D(-100), avgCost: D(40), ratio: D(0), cashPerShare: D(50),
      receivedPrice: D(0), fxReceivedToTarget: D(1),
    });
    expect(plan.legs[0].transactionType).toBe("cover");
    expect(plan.cashReceived.toNumber()).toBe(-5000);
    expect(plan.realisedPnl.toNumber()).toBe(-1000); // shorted at 40, closed at 50
  });

  it("a short in a share merger becomes short the acquirer", () => {
    const plan = planMerger({
      held: D(-100), avgCost: D(40), ratio: D(0.5), cashPerShare: D(0),
      receivedPrice: D(120), fxReceivedToTarget: D(1),
    });
    const received = plan.legs.find((l) => l.role === "received")!;
    expect(received.transactionType).toBe("short");
    expect(received.quantity.toNumber()).toBe(-50);
  });
});

// ---------------------------------------------------------------------------
describe("spin-off", () => {
  // 100 parent at 50 cost. Ex-date: parent 80, spin-off 100, 0.2 per share.
  // Spin-off value per parent share = 20, so 20% of cost moves across.
  const plan = planSpinOff({
    held: D(100), avgCost: D(50), ratio: D(0.2),
    parentPrice: D(80), spincoPrice: D(100), fxSpincoToParent: D(1),
  });
  const rows = ledger({ securityId: "par", qty: 100, price: 50 }, plan.legs, {
    parent: { securityId: "par", ...EUR },
    spinco: { securityId: "spn", ...EUR },
  });

  it("allocates cost by relative market value", () => {
    expect(plan.allocationToSpinco.toNumber()).toBe(0.2);
    expect(plan.parentAvgAfter.toNumber()).toBe(40);
    expect(plan.spincoAvgCost.toNumber()).toBe(50);
  });

  it("keeps the parent shares and adds the spin-off shares", () => {
    const s = navState(rows);
    expect(s.positions.get("par")!.quantity.toNumber()).toBe(100);
    expect(s.positions.get("spn")!.quantity.toNumber()).toBe(20);
  });

  it("preserves total cost basis exactly", () => {
    const s = navState(rows);
    const par = s.positions.get("par")!;
    const spn = s.positions.get("spn")!;
    const total = par.quantity.times(par.avgCostNative).plus(spn.quantity.times(spn.avgCostNative));
    expect(total.toNumber()).toBe(5000);
  });

  it("moves no cash", () => {
    expect(navState(rows).cashByCurrency.get("EUR")!.toNumber()).toBe(-5000);
  });

  it("realises nothing — a spin-off is not a sale", () => {
    const dash = dashState(rows, { par: "80", spn: "100" });
    expect(dash.positions.get("par")!.realisedPnlBase.toNumber()).toBe(0);
    expect(dash.positions.get("spn")!.realisedPnlBase.toNumber()).toBe(0);
  });

  it("does not change the holding's value — the fake loss this prevents", () => {
    // Cum-date the parent was worth 100 (80 + the 20 that left it).
    const s = navState(rows);
    const after = s.positions.get("par")!.quantity.times(80).plus(s.positions.get("spn")!.quantity.times(100));
    expect(after.toNumber()).toBe(100 * 100);
  });

  it("pays cash in lieu on a fractional spin-off entitlement", () => {
    const p = planSpinOff({
      held: D(25), avgCost: D(50), ratio: D(0.3),
      parentPrice: D(80), spincoPrice: D(100), fxSpincoToParent: D(1),
    });
    expect(p.spincoShares.toNumber()).toBe(7);
    expect(p.legs.some((l) => l.note.startsWith("Cash in lieu"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("validation", () => {
  const base = { avgCost: D(40), receivedPrice: D(100), fxReceivedToTarget: D(1) };
  it("refuses a deal that pays nothing", () => {
    expect(() => planMerger({ ...base, held: D(10), ratio: D(0), cashPerShare: D(0) })).toThrow();
  });
  it("refuses negative terms", () => {
    expect(() => planMerger({ ...base, held: D(10), ratio: D(-1), cashPerShare: D(0) })).toThrow();
  });
  it("refuses a share deal with no price for the shares", () => {
    expect(() => planMerger({ ...base, held: D(10), ratio: D(1), cashPerShare: D(0), receivedPrice: D(0) })).toThrow();
  });
  it("refuses to book an event for a holding that isn't held", () => {
    expect(() => planMerger({ ...base, held: D(0), ratio: D(1), cashPerShare: D(0) })).toThrow();
  });
  it("refuses a spin-off without both prices", () => {
    expect(() =>
      planSpinOff({ held: D(10), avgCost: D(5), ratio: D(1), parentPrice: D(0), spincoPrice: D(10), fxSpincoToParent: D(1) })
    ).toThrow();
  });
});
