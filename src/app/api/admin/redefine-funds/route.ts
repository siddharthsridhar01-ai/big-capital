/**
 * One-off — redefine the fund set from geographic to strategy-based.
 *   /api/admin/redefine-funds?secret=<CRON_SECRET>
 *
 * - Updates descriptions for the three kept funds (uk-equity, global-equity, long-short).
 * - Creates two new USD funds (market-neutral, systematic-equity) + default constraints.
 * - Retires the three unused geographic funds (us/european/em-equity) via isActive=false
 *   (data preserved; reversible by flipping the flag back).
 *
 * Idempotent: updates are set-based, creates use onConflictDoNothing, constraints only
 * seed if the fund has none yet.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds, securities, fundConstraints } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Match the inception date used by the existing lineup so the set stays consistent.
const INCEPTION_DATE = "2026-06-01";

const UPDATED_DESCRIPTIONS: Record<string, string> = {
  "uk-equity":
    "Long-only UK equity fund investing primarily in FTSE 350 constituents, with a contrarian, value-oriented approach. Targets fundamentally sound companies trading at a discount to intrinsic value, where negative sentiment or temporary setbacks have created a mispricing.",
  "global-equity":
    "Long-only global developed-market equity fund targeting high-quality businesses with durable competitive advantages that can compound over the long run. Holds a focused portfolio of 15–20 names, with an initial emphasis on consumer staples and FMCG that broadens across sectors over time.",
  "long-short":
    "Fundamental long/short equity fund run with a net-long bias and a concentrated book of up to 20 positions. Targets mispriced competitive advantages and underappreciated catalysts in durable compounders aligned with emerging investment themes, using single-name shorts to manage risk and express relative-value views.",
};

const NEW_FUNDS = [
  {
    slug: "market-neutral",
    name: "BIG Capital Equity Market Neutral Fund",
    baseCurrency: "USD" as const,
    benchmarkTicker: "SOFR_CASH" as string | null,
    strategyDescription:
      "Global equity market-neutral fund combining fundamental and event-driven research with alternative-data-driven variant views. Holds a balanced book of 12–14 positions across the Americas, Europe and Asia-Pacific, aiming to generate idiosyncratic returns independent of broad market direction.",
    constraintTemplate: "long_short" as const,
  },
  {
    slug: "systematic-equity",
    name: "BIG Capital Systematic Equity Fund",
    baseCurrency: "USD" as const,
    benchmarkTicker: null as string | null, // TBC until universe confirmed
    strategyDescription:
      "Systematic equity fund driven by rules-based quantitative models rather than discretionary stock selection. Combines factor-based signals with portfolio optimisation and disciplined risk management to size positions and control exposure across a diversified book.",
    constraintTemplate: "long_only" as const,
  },
];

const RETIRE_SLUGS = ["us-equity", "european-equity", "em-equity"];

function constraintsFor(template: "long_only" | "long_short") {
  if (template === "long_short") {
    return [
      { type: "universe_only", value: true, isHard: true },
      { type: "max_gross_exposure", value: 2.0, isHard: true },
      { type: "max_net_exposure", value: 0.2, isHard: true },
      { type: "max_position_pct", value: 0.06, isHard: false },
      { type: "min_cash_pct", value: 0.0, isHard: false },
      { type: "max_cash_pct", value: 0.5, isHard: false },
      { type: "max_single_sector_pct", value: 0.4, isHard: false },
      { type: "max_position_count", value: 60, isHard: false },
    ];
  }
  return [
    { type: "universe_only", value: true, isHard: true },
    { type: "long_only", value: true, isHard: true },
    { type: "max_position_pct", value: 0.08, isHard: false },
    { type: "min_cash_pct", value: 0.02, isHard: false },
    { type: "max_cash_pct", value: 0.2, isHard: false },
    { type: "max_single_sector_pct", value: 0.35, isHard: false },
    { type: "max_position_count", value: 40, isHard: false },
  ];
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const provided =
    url.searchParams.get("secret") ??
    (req.headers.get("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization")!.slice("Bearer ".length)
      : null);
  if (!provided || provided !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const result: Record<string, unknown> = {};

  // 1. Update descriptions on the three kept funds.
  const descUpdated: string[] = [];
  for (const [slug, description] of Object.entries(UPDATED_DESCRIPTIONS)) {
    const r = await db
      .update(funds)
      .set({ strategyDescription: description, isActive: true })
      .where(eq(funds.slug, slug))
      .returning({ slug: funds.slug });
    if (r.length > 0) descUpdated.push(slug);
  }
  result.descriptionsUpdated = descUpdated;

  // 2. Create the two new funds (+ default constraints).
  const created: string[] = [];
  const skipped: string[] = [];
  for (const f of NEW_FUNDS) {
    let benchmarkSecurityId: string | null = null;
    if (f.benchmarkTicker) {
      const bench = await db
        .select({ id: securities.id })
        .from(securities)
        .where(eq(securities.ticker, f.benchmarkTicker))
        .limit(1);
      benchmarkSecurityId = bench.length > 0 ? bench[0].id : null;
    }

    const existing = await db
      .select({ id: funds.id })
      .from(funds)
      .where(eq(funds.slug, f.slug))
      .limit(1);

    let fundId: string;
    if (existing.length > 0) {
      fundId = existing[0].id;
      skipped.push(f.slug);
    } else {
      const inserted = await db
        .insert(funds)
        .values({
          name: f.name,
          slug: f.slug,
          baseCurrency: f.baseCurrency,
          benchmarkSecurityId,
          strategyDescription: f.strategyDescription,
          inceptionDate: INCEPTION_DATE,
          startingNav: "100000",
        })
        .returning({ id: funds.id });
      fundId = inserted[0].id;
      created.push(f.slug);
    }

    // Seed constraints only if none exist for this fund.
    const hasConstraints = await db
      .select({ id: fundConstraints.id })
      .from(fundConstraints)
      .where(eq(fundConstraints.fundId, fundId))
      .limit(1);
    if (hasConstraints.length === 0) {
      for (const c of constraintsFor(f.constraintTemplate)) {
        await db.insert(fundConstraints).values({
          fundId,
          constraintType: c.type,
          value: c.value,
          isHard: c.isHard,
        });
      }
    }
  }
  result.fundsCreated = created;
  result.fundsAlreadyExisted = skipped;

  // 3. Retire unused geographic funds (reversible).
  const retired: string[] = [];
  for (const slug of RETIRE_SLUGS) {
    const r = await db
      .update(funds)
      .set({ isActive: false })
      .where(eq(funds.slug, slug))
      .returning({ slug: funds.slug });
    if (r.length > 0) retired.push(slug);
  }
  result.fundsRetired = retired;

  return NextResponse.json({ ok: true, ...result });
}
