/**
 * The NAV valuation point must be identical every day: every holding at its own
 * official close for that date.
 *
 * These test the REAL guard used by compute-nav. They previously re-implemented
 * the logic in the test file, so they could pass while the real guard drifted.
 */
import { describe, it, expect } from "vitest";
import { navGuard, DORMANT_AFTER_DAYS } from "../src/lib/nav-guard";

function wait(
  held: string[],
  closed: string[],
  ageDays: number,
  lastClose: Record<string, string> = {},
  date = "2026-11-10"
) {
  return navGuard({
    evidenceIds: held,
    closedForDate: new Set(closed),
    lastCloseDate: new Map(Object.entries(lastClose)),
    date,
    ageDays,
  });
}

describe("NAV valuation-point guard — original behaviour, unchanged", () => {
  const held = ["uk", "us", "asia"];

  it("waits on a same-day strike when only some markets have closed", () => {
    expect(wait(held, ["asia"], 0).wait).toBe(true);
    expect(wait(held, ["asia", "uk"], 0).wait).toBe(true);
  });

  it("strikes a same-day date once every holding has closed", () => {
    expect(wait(held, ["asia", "uk", "us"], 0).wait).toBe(false);
  });

  it("still waits the next morning if a market has not closed", () => {
    expect(wait(held, ["asia", "uk"], 1).wait).toBe(true);
  });

  it("accepts a settled date with a partial set, carrying prices forward", () => {
    expect(wait(held, ["asia", "uk"], 2).wait).toBe(false);
  });

  it("never strikes a date where nothing closed at all", () => {
    expect(wait(held, [], 5).wait).toBe(true);
  });

  it("allows a fund with no holdings through", () => {
    expect(wait([], [], 0).wait).toBe(false);
  });
});

describe("NAV valuation-point guard — dormant holdings", () => {
  const held = ["asml", "sap", "target"];

  it("does not let a delisted holding freeze the fund", () => {
    // The target last closed weeks ago; the others closed today.
    const r = wait(held, ["asml", "sap"], 0, { target: "2026-10-20" });
    expect(r.wait).toBe(false);
    expect(r.dormant).toEqual(["target"]);
  });

  it("still waits for a holding that is merely late, not dormant", () => {
    // Closed two days ago: a holiday or a slow feed, not a delisting.
    const r = wait(held, ["asml", "sap"], 0, { target: "2026-11-08" });
    expect(r.wait).toBe(true);
    expect(r.dormant).toEqual([]);
  });

  it("does not mistake a long holiday closure for a delisting", () => {
    // Exactly at the threshold is not dormant.
    const last = new Date(Date.parse("2026-11-10T00:00:00Z") - DORMANT_AFTER_DAYS * 86400000)
      .toISOString()
      .slice(0, 10);
    expect(wait(held, ["asml", "sap"], 0, { target: last }).wait).toBe(true);
  });

  it("treats a total data outage as an outage, not as everything being dormant", () => {
    // Nothing closed and every last close is old. Striking here would value the
    // whole fund at stale prices and silence the watchdog. It must keep waiting.
    const r = wait(held, [], 0, { asml: "2026-10-20", sap: "2026-10-20", target: "2026-10-20" });
    expect(r.wait).toBe(true);
    expect(r.dormant).toEqual([]);
  });

  it("does not treat a holding with no price history as dormant", () => {
    // Missing data is not a delisting; the missing-price check must still see it.
    const r = wait(held, ["asml", "sap"], 0, {});
    expect(r.wait).toBe(true);
    expect(r.dormant).toEqual([]);
  });

  it("keeps waiting for an active holding even when another is dormant", () => {
    const r = wait(held, ["asml"], 0, { target: "2026-10-20", sap: "2026-11-09" });
    expect(r.wait).toBe(true);
    expect(r.dormant).toEqual(["target"]);
  });
});
