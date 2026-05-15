/**
 * Check-trade endpoint.
 *
 * POST /api/funds/[slug]/check-trade
 *
 * Body: { securityId, side, shares }
 *
 * Runs the existing constraint engine against a proposed trade given the
 * fund's current portfolio state, and returns:
 *
 *   - All hard and soft constraint violations
 *   - Computed projections (notional, fee, weight, exposures BEFORE/AFTER)
 *   - The price used and any FX conversion applied
 *
 * Called by the trade ticket client component on every keystroke (debounced)
 * to keep the projection panel live. Same engine runs on submit (Phase 2b.4)
 * for authoritative server-side enforcement.
 *
 * For Phase 2b.3 the fund's portfolio state is computed from the EMPTY
 * starting state (no positions, all cash). Phase 2b.4 will compute it from
 * the transactions ledger.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import {
  funds as fundsTable,
  fundConstraints,
  securities,
  investableUniverses,
  prices,
} from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { and, desc, eq, isNull } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  checkTrade,
  type FundConstraint,
  type ProposedTrade,
  type PortfolioContext,
  type ConstraintViolation,
} from "@/lib/constraints";
import { computePortfolioState, staticFxFallback } from "@/lib/portfolio";

export const dynamic = "force-dynamic";

interface CheckTradeBody {
  securityId: string;
  side: "buy" | "sell" | "short" | "cover";
  shares: number;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const user = await getOrCreateUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const { slug } = await params;

  // Parse and validate body
  let body: CheckTradeBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body" },
      { status: 400 }
    );
  }
  if (
    !body.securityId ||
    !["buy", "sell", "short", "cover"].includes(body.side) ||
    typeof body.shares !== "number" ||
    body.shares < 1 ||
    !Number.isInteger(body.shares)
  ) {
    return NextResponse.json(
      { ok: false, error: "Invalid trade parameters" },
      { status: 400 }
    );
  }

  // Look up fund
  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Fund not found" },
      { status: 404 }
    );
  }
  const fund = fundRows[0];

  // Look up security
  const secRows = await db
    .select()
    .from(securities)
    .where(eq(securities.id, body.securityId))
    .limit(1);
  if (secRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Security not found" },
      { status: 404 }
    );
  }
  const security = secRows[0];

  // Look up latest price
  const priceRows = await db
    .select()
    .from(prices)
    .where(eq(prices.securityId, security.id))
    .orderBy(desc(prices.date))
    .limit(1);
  if (priceRows.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No price data for this security" },
      { status: 400 }
    );
  }
  const latestPrice = new Decimal(priceRows[0].closePrice);

  // Load active constraints
  const allConstraints = await db
    .select()
    .from(fundConstraints)
    .where(
      and(
        eq(fundConstraints.fundId, fund.id),
        eq(fundConstraints.isActive, true)
      )
    );

  // Deduplicate by constraintType (the seed has accidentally inserted
  // duplicates over multiple setup runs; same-type duplicates are redundant)
  const dedupedConstraints = new Map<string, typeof allConstraints[number]>();
  for (const c of allConstraints) {
    if (!dedupedConstraints.has(c.constraintType)) {
      dedupedConstraints.set(c.constraintType, c);
    }
  }

  const constraints: FundConstraint[] = Array.from(
    dedupedConstraints.values()
  ).map((c) => ({
    id: c.id,
    constraintType: c.constraintType as FundConstraint["constraintType"],
    value: c.value,
    isHard: c.isHard,
  }));

  // Build the investable universe set
  const universeRows = await db
    .select({ securityId: investableUniverses.securityId })
    .from(investableUniverses)
    .where(
      and(
        eq(investableUniverses.fundId, fund.id),
        isNull(investableUniverses.removedDate)
      )
    );
  const investableUniverse = new Set(universeRows.map((r) => r.securityId));

  // Build security metadata map. Includes the trade's security AND every
  // currently-held security so sector aggregation works correctly.
  const securityMeta = new Map<
    string,
    { ticker: string; sector: string | null; currency: PortfolioContext["baseCurrency"] }
  >();
  securityMeta.set(security.id, {
    ticker: security.ticker,
    sector: security.gicsSector,
    currency: security.currency as PortfolioContext["baseCurrency"],
  });

  // ===== Compute live portfolio state from the transactions ledger =====
  const state = await computePortfolioState(fund.id);

  // Add metadata for every currently-held security
  for (const [id, pos] of state.positions) {
    securityMeta.set(id, {
      ticker: pos.ticker,
      sector: pos.gicsSector,
      currency: pos.currency,
    });
  }

  // Engine-format positions map
  const enginePositions = new Map();
  for (const [id, p] of state.positions) {
    enginePositions.set(id, {
      securityId: id,
      quantity: p.quantity,
      avgCostNative: p.avgCostNative,
      currency: p.currency,
    });
  }

  // FX rates: same-currency = 1; cross-currency falls back to static rate
  const dateStr = new Date().toISOString().slice(0, 10);
  const fxRates = new Map<string, string>();
  if (security.currency !== fund.baseCurrency) {
    try {
      const rate = staticFxFallback(
        security.currency as Parameters<typeof staticFxFallback>[0],
        fund.baseCurrency as Parameters<typeof staticFxFallback>[1]
      );
      fxRates.set(
        `${security.currency}/${fund.baseCurrency}/${dateStr}`,
        rate.toString()
      );
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : "No FX rate available for this cross-currency trade",
        },
        { status: 400 }
      );
    }
  }

  const ctx: PortfolioContext = {
    navBase: state.navBase,
    cashByCurrency: state.cashByCurrency,
    positions: enginePositions,
    fxRates,
    baseCurrency: fund.baseCurrency as PortfolioContext["baseCurrency"],
    date: dateStr,
    securityMeta,
    investableUniverse,
  };

  // ===== Build the proposed trade =====
  // FX: if security currency != fund base currency, we'd need an FX rate.
  // For now we assume security currency = base currency. The constraint
  // engine handles cross-currency math when we provide fxRates (Phase 2b.4).
  const trade: ProposedTrade = {
    securityId: body.securityId,
    side: body.side,
    quantity: new Decimal(body.shares),
    price: latestPrice,
    currency: security.currency as PortfolioContext["baseCurrency"],
  };

  // Prices map for post-trade NAV computation — include held positions' prices
  const pricesPostTrade = new Map([[security.id, latestPrice]]);
  for (const [id, p] of state.positions) {
    if (p.latestPriceNative) {
      pricesPostTrade.set(id, p.latestPriceNative);
    }
  }

  // Run the engine
  let result;
  try {
    result = checkTrade(constraints, trade, ctx, pricesPostTrade);
  } catch (err) {
    // FX-related errors mostly — fail gracefully so the UI shows the issue
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Constraint check failed unexpectedly",
      },
      { status: 500 }
    );
  }

  // ===== Compute projections (informational, shown in the panel) =====
  const tradeNotional = new Decimal(body.shares).times(latestPrice);
  const fee = tradeNotional.times(fund.tradingFeesBps).dividedBy(10000);
  const isCashOutflow = body.side === "buy" || body.side === "cover";
  const totalCashImpact = isCashOutflow
    ? tradeNotional.plus(fee).negated()
    : tradeNotional.minus(fee);

  const navBase = state.navBase;
  const newWeight = navBase.isZero()
    ? new Decimal(0)
    : tradeNotional.dividedBy(navBase);
  const newCashAbs = state.cashBase.plus(totalCashImpact);
  const newCashPct = navBase.isZero()
    ? new Decimal(0)
    : newCashAbs.dividedBy(navBase);

  return NextResponse.json({
    ok: true,
    result: {
      pass: result.pass,
      hardViolations: result.hardViolations.map(serializeViolation),
      softViolations: result.softViolations.map(serializeViolation),
    },
    projection: {
      // What the trade itself does
      tradeNotional: tradeNotional.toFixed(2),
      fee: fee.toFixed(2),
      totalCashImpact: totalCashImpact.toFixed(2),
      // Where the portfolio ends up
      newPositionWeight: newWeight.toFixed(6),
      newCashAbs: newCashAbs.toFixed(2),
      newCashPct: newCashPct.toFixed(6),
      // The price + ccy used
      pricePerShare: latestPrice.toFixed(4),
      priceCurrency: security.currency,
      fundBaseCurrency: fund.baseCurrency,
    },
  });
}

function serializeViolation(v: ConstraintViolation) {
  return {
    constraintId: v.constraintId,
    constraintType: v.constraintType,
    isHard: v.isHard,
    message: v.message,
    currentValue: v.currentValue,
    limit: v.limit,
  };
}
