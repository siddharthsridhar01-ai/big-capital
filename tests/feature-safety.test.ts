/**
 * Featuring a thesis must not publish an undisclosed live position.
 *
 * The public page discloses holdings on a lag so nobody can trade ahead of the
 * fund. These pin which theses are safe to feature without breaking that.
 */
import { describe, it, expect } from "vitest";

/** Mirrors featureSafety's decision, minus the database read. */
function decide(status: string, securityId: string | null, disclosedIds: string[]) {
  if (status === "closed" || status === "post_mortem") return { safe: true, reason: "closed" };
  if (status === "abandoned" || !securityId) return { safe: true, reason: "abandoned" };
  if (disclosedIds.includes(securityId)) return { safe: true, reason: "disclosed" };
  return { safe: false, reason: "undisclosed_open_position" };
}

describe("feature safety", () => {
  it("treats a closed position as safe — nothing left to front-run", () => {
    expect(decide("closed", "s1", [])).toEqual({ safe: true, reason: "closed" });
    expect(decide("post_mortem", "s1", [])).toEqual({ safe: true, reason: "closed" });
  });

  it("treats an abandoned thesis as safe — there was never a position", () => {
    expect(decide("abandoned", "s1", []).safe).toBe(true);
  });

  it("treats an open position as safe once it has been disclosed", () => {
    expect(decide("active", "s1", ["s1", "s2"])).toEqual({ safe: true, reason: "disclosed" });
  });

  it("flags an open position the public has not seen", () => {
    expect(decide("active", "s1", ["s2"])).toEqual({ safe: false, reason: "undisclosed_open_position" });
  });

  it("flags an open position when nothing has been disclosed at all", () => {
    expect(decide("active", "s1", []).safe).toBe(false);
  });
});
