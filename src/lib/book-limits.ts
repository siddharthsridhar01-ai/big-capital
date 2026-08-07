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
import { db } from "@/db/client";
import { funds, fundConstraints, investableUniverses } from "@/db/schema";
import {
  evaluateBookLimits,
  type FundConstraint,
  type LimitUtilisation,
  type PortfolioContext,
} from "@/lib/constraints";
import { computePortfolioState, staticFxFallback } from "@/lib/portfolio";

export interface BookLimitsResult {
  limits: LimitUtilisation[];
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

  const state = await computePortfolioState(fundId);

  const baseCurrency = fund.baseCurrency as PortfolioContext["baseCurrency"];
  const dateStr = new Date().toISOString().slice(0, 10);

  const securityMeta: PortfolioContext["securityMeta"] = new Map();
  const positions: PortfolioContext["positions"] = new Map();
  const prices = new Map<string, Decimal>();
  const fxRates = new Map<string, string>();

  for (const [id, p] of state.positions) {
    securityMeta.set(id, { ticker: p.ticker, sector: p.gicsSector, currency: p.currency });
    positions.set(id, {
      securityId: id,
      quantity: p.quantity,
      avgCostNative: p.avgCostNative,
      currency: p.currency,
    });
    // A held security with no price cannot be weighted; skipping it would
    // understate exposure, so leave it out of the map and let the evaluator
    // surface the gap rather than silently valuing it at zero.
    if (p.latestPriceNative) prices.set(id, p.latestPriceNative);

    if (p.currency !== baseCurrency) {
      const key = `${p.currency}/${baseCurrency}/${dateStr}`;
      if (!fxRates.has(key)) {
        try {
          fxRates.set(key, staticFxFallback(p.currency, baseCurrency).toString());
        } catch {
          /* no rate: evaluateBookLimits will throw on this security, caught below */
        }
      }
    }
  }

  const ctx: PortfolioContext = {
    navBase: state.navBase,
    cashByCurrency: state.cashByCurrency,
    positions,
    fxRates,
    baseCurrency,
    date: dateStr,
    securityMeta,
    investableUniverse: new Set(universeRows.map((r) => r.securityId)),
  };

  let limits: LimitUtilisation[] = [];
  try {
    limits = evaluateBookLimits(constraints, ctx, prices);
  } catch {
    // Missing price or FX for a held name. The panel is informational, so
    // degrade to showing nothing rather than breaking the dashboard.
    limits = [];
  }

  const hardRules = constraints
    .filter((c) => HARD_RULE_LABELS[c.constraintType])
    .map((c) => ({ label: HARD_RULE_LABELS[c.constraintType], constraintType: c.constraintType }));

  return {
    limits,
    hardRules,
    breachCount: limits.filter((l) => l.breached).length,
  };
}
