import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { reconcileSnapshot, reconcilePriceJumps, type SnapshotRecon } from "../src/lib/reconciliation";

const D = (n: string | number) => new Decimal(n);

const base = (over: Partial<SnapshotRecon> = {}): SnapshotRecon => ({
  fundSlug: "uk-equity",
  startingNav: D("100000"),
  nav: D("100200"),
  cashBalance: D("90200"),
  positionValue: D("10000"),
  previousNav: D("100100"),
  ...over,
});

describe("reconcileSnapshot", () => {
  it("passes a healthy snapshot with no anomalies", () => {
    expect(reconcileSnapshot(base())).toHaveLength(0);
  });

  it("fails when NAV is not positive", () => {
    const a = reconcileSnapshot(base({ nav: D("-5"), cashBalance: D("-15"), positionValue: D("10") }));
    expect(a.some((x) => x.check === "nav_positive" && x.severity === "fail")).toBe(true);
  });

  it("fails when cash + positions does not equal NAV", () => {
    const a = reconcileSnapshot(base({ nav: D("100200"), cashBalance: D("50000"), positionValue: D("10000") }));
    expect(a.some((x) => x.check === "nav_reconciles" && x.severity === "fail")).toBe(true);
  });

  it("allows tiny rounding differences in the reconciliation", () => {
    const a = reconcileSnapshot(base({ nav: D("100200"), cashBalance: D("90200.005"), positionValue: D("9999.999") }));
    expect(a.some((x) => x.check === "nav_reconciles")).toBe(false);
  });

  it("warns on deeply negative base cash", () => {
    const a = reconcileSnapshot(base({ cashBalance: D("-60000"), positionValue: D("160200") }));
    expect(a.some((x) => x.check === "cash_negative")).toBe(true);
  });

  it("warns on large drift from opening capital", () => {
    const a = reconcileSnapshot(base({ nav: D("170000"), cashBalance: D("160000"), positionValue: D("10000"), previousNav: D("169000") }));
    expect(a.some((x) => x.check === "nav_drift")).toBe(true);
  });

  it("warns on a large day-over-day NAV move", () => {
    const a = reconcileSnapshot(base({ nav: D("120000"), cashBalance: D("110000"), positionValue: D("10000"), previousNav: D("100000") }));
    expect(a.some((x) => x.check === "nav_daily_move")).toBe(true);
  });

  it("skips the day-move check when there is no previous NAV", () => {
    const a = reconcileSnapshot(base({ previousNav: null }));
    expect(a.some((x) => x.check === "nav_daily_move")).toBe(false);
  });
});

describe("reconcilePriceJumps", () => {
  it("flags a >50% day-over-day price move", () => {
    const a = reconcilePriceJumps([{ ticker: "AZN", exchange: "LSE", today: D("210"), prev: D("105") }]);
    expect(a).toHaveLength(1);
    expect(a[0].check).toBe("price_jump");
  });

  it("ignores normal daily moves", () => {
    expect(reconcilePriceJumps([{ ticker: "BP", exchange: "LSE", today: D("4.60"), prev: D("4.55") }])).toHaveLength(0);
  });

  it("catches a pence/pounds error surfacing in the daily feed (~100x)", () => {
    const a = reconcilePriceJumps([{ ticker: "SHEL", exchange: "LSE", today: D("2810"), prev: D("28.10") }]);
    expect(a).toHaveLength(1);
  });

  it("skips pairs with a non-positive previous price", () => {
    expect(reconcilePriceJumps([{ ticker: "X", exchange: "US", today: D("10"), prev: D("0") }])).toHaveLength(0);
  });
});
