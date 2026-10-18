/**
 * Loads a fund's standing limit utilisation for the dashboard "Limits" panel.
 *
 * The constraint thresholds live in one place (the `fund_constraints` rows) and
 * the evaluation lives in one place (`evaluateBookLimits`, which shares its
 * weighting and FX helpers with `checkTrade`). This module only assembles the
 * inputs, so the panel and the trade blocker cannot drift apart: if a PM sees
 * "largest position 7.1% of 8%", the blocker is measuring the same way.
 *
 * Boolean rules (long_only, universe_only) have no utilisation — they are
 * enforced at trade time and returned separately so the UI can render them as
 * pills rather than bars.
 */
import { and, eq, isNull } from "drizzle-orm";
import Decimal from "decimal.js";
import { fxRateMapForEngine } from "./fx";
import { db } from "@/db/client";
import { funds, fundConstraints, investableUniverses } from "@/db/schema";
import {
  evaluateBookLimits,
  type FundConstraint,
  type LimitUtilisation,
  type PortfolioContext,
} from "@/lib/constraints";
import { computePortfolioState } from "@/lib/portfolio";

/**
 * A limit, plus where it will stand once queued orders fill. `forward` is set
 * only when there are queued orders, so a fund with none shows exactly as before.
 */
export type LimitWithForward = LimitUtilisation & {
  forward?: Pick<LimitUtilisation, "current" | "utilisation" | "breached" | "detail" | "exempt">;
};

export interface BookLimitsResult {
  limits: LimitWithForward[];
  /** Queued orders reflected in each limit's `forward` value. */
  pendingOrdersIncluded: number;
  /** Limits within bounds now that the queue would push out of them. */
  forwardBreachCount: number;
  /** Always-on rules with no utilisation, e.g. "Long only". */
  hardRules: Array<{ label: string; constraintType: string }>;
  breachCount: number;
}

const HARD_RULE_LABELS: Record<string, string> = {
  long_only: "Long only",
  universe_only: "Universe only",
};

export async function loadBookLimits(fundId: string): Promise<BookLimitsResult | null> {
  const [fund] = await db.select().from(funds).where(eq(funds.id, fundId)).limit(1);
  if (!fund) return null;

  const rows = await db
    .select()
    .from(fundConstraints)
    .where(and(eq(fundConstraints.fundId, fundId), eq(fundConstraints.isActive, true)));

  // Setup runs have inserted same-type duplicates; keep the first of each.
  const deduped = new Map<string, (typeof rows)[number]>();
  for (const c of rows) if (!deduped.has(c.constraintType)) deduped.set(c.constraintType, c);

  const constraints: FundConstraint[] = Array.from(deduped.values()).map((c) => ({
    id: c.id,
    constraintType: c.constraintType as FundConstraint["constraintType"],
    value: c.value,
    isHard: c.isHard,
  }));

  const universeRows = await db
    .select({ securityId: investableUniverses.securityId })
    .from(investableUniverses)
    .where(
      and(eq(investableUniverses.fundId, fundId), isNull(investableUniverses.removedDate))
    );

  const baseCurrency = fund.baseCurrency as PortfolioContext["baseCurrency"];
  const dateStr = new Date().toISOString().slice(0, 10);
  const investableUniverse = new Set(universeRows.map((r) => r.securityId));
  const inception = new Date(`${String(fund.inceptionDate).slice(0, 10)}T00:00:00Z`);
  const daysSinceInception = Number.isNaN(inception.getTime())
    ? undefined
    : Math.floor((Date.now() - inception.getTime()) / 86400000);

  /** Evaluate every limit against one book — the current one or the forward one. */
  async function evaluate(state: Awaited<ReturnType<typeof computePortfolioState>>): Promise<LimitUtilisation[]> {
    const securityMeta: PortfolioContext["securityMeta"] = new Map();
    const positions: PortfolioContext["positions"] = new Map();
    const prices = new Map<string, Decimal>();
    for (const [id, p] of state.positions) {
      securityMeta.set(id, { ticker: p.ticker, sector: p.gicsSector, currency: p.currency });
      positions.set(id, {
        securityId: id,
        quantity: p.quantity,
        avgCostNative: p.avgCostNative,
        currency: p.currency,
      });
      // A held security with no price cannot be weighted; skipping it would
      // understate exposure, so leave it out and let the evaluator surface it.
      if (p.latestPriceNative) prices.set(id, p.latestPriceNative);
    }

    // Stored ECB rates for every currency held or in cash — the same source NAV
    // and trades use, never the static fallback table.
    const fxRates = await fxRateMapForEngine(
      [
        ...Array.from(state.positions.values()).map((p) => p.currency),
        ...Array.from(state.cashByCurrency.keys()),
      ],
      baseCurrency,
      dateStr
    );

    const ctx: PortfolioContext = {
      navBase: state.navBase,
      cashByCurrency: state.cashByCurrency,
      positions,
      fxRates,
      baseCurrency,
      date: dateStr,
      securityMeta,
      investableUniverse,
    };
    try {
      return evaluateBookLimits(constraints, ctx, prices, { daysSinceInception });
    } catch {
      // Missing price or FX for a held name. The panel is informational, so
      // degrade to showing nothing rather than breaking the dashboard.
      return [];
    }
  }

  const current = await evaluate(await computePortfolioState(fundId));

  // Where each limit stands once queued orders fill. A PM placing twenty orders
  // for the open needs to see the sector or cash limit those orders will hit —
  // not discover it at the open, when the later ones are refused.
  const forwardState = await computePortfolioState(fundId, undefined, { includePending: true });
  const pendingOrdersIncluded = forwardState.pendingOrdersIncluded ?? 0;
  const forward = pendingOrdersIncluded > 0 ? await evaluate(forwardState) : [];
  const forwardByType = new Map(forward.map((l) => [l.constraintType, l]));

  const limits: LimitWithForward[] = current.map((l) => {
    const f = forwardByType.get(l.constraintType);
    return f
      ? { ...l, forward: { current: f.current, utilisation: f.utilisation, breached: f.breached, detail: f.detail, exempt: f.exempt } }
      : l;
  });

  const hardRules = constraints
    .filter((c) => HARD_RULE_LABELS[c.constraintType])
    .map((c) => ({ label: HARD_RULE_LABELS[c.constraintType], constraintType: c.constraintType }));

  return {
    limits,
    pendingOrdersIncluded,
    forwardBreachCount: limits.filter((l) => !l.breached && l.forward?.breached && !l.forward?.exempt).length,
    hardRules,
    breachCount: limits.filter((l) => l.breached).length,
  };
}
