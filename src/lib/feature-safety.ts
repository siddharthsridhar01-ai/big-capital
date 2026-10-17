/**
 * Whether featuring a thesis would reveal something the public cannot yet see.
 *
 * The public fund page discloses holdings on a deliberate lag — monthly and
 * quarterly, in arrears — so nobody can trade ahead of the fund. A featured
 * thesis on an open position the public has not been shown yet would publish
 * that position early.
 *
 * Safe when:
 *   - the position is closed (closed / post_mortem): nothing left to front-run
 *   - the thesis was abandoned before trading: there is no position at all
 *   - the security has already appeared in a published holdings snapshot
 *
 * Otherwise it is a live, undisclosed position: the PM is warned, and a fund
 * with featureDisclosedOnly set refuses it.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { publicHoldingsSnapshots } from "@/db/schema";

export type FeatureSafety =
  | { safe: true; reason: "closed" | "abandoned" | "disclosed" }
  | { safe: false; reason: "undisclosed_open_position" };

export async function featureSafety(
  fundId: string,
  thesis: { status: string; securityId: string | null }
): Promise<FeatureSafety> {
  if (thesis.status === "closed" || thesis.status === "post_mortem") {
    return { safe: true, reason: "closed" };
  }
  if (thesis.status === "abandoned") {
    return { safe: true, reason: "abandoned" };
  }
  if (!thesis.securityId) {
    return { safe: true, reason: "abandoned" };
  }

  const snaps = await db
    .select({ holdings: publicHoldingsSnapshots.holdings })
    .from(publicHoldingsSnapshots)
    .where(eq(publicHoldingsSnapshots.fundId, fundId));

  for (const s of snaps) {
    const list = (Array.isArray(s.holdings) ? s.holdings : []) as Array<{ securityId?: string }>;
    if (list.some((h) => h.securityId === thesis.securityId)) {
      return { safe: true, reason: "disclosed" };
    }
  }
  return { safe: false, reason: "undisclosed_open_position" };
}
