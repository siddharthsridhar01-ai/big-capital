/**
 * BIG Capital — Database Seed
 *
 * Populates:
 *   - Six funds with their inception dates, starting NAVs, base currencies
 *   - Benchmark securities (index proxies)
 *   - Default constraints per fund (per locked decisions in phase-0-spec.md §11)
 *
 * Idempotent: safe to run multiple times. Uses ON CONFLICT DO NOTHING.
 *
 * To run:
 *   pnpm tsx src/db/seed.ts
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import {
  funds,
  securities,
  fundConstraints,
} from "./schema";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL not set");
}

const client = postgres(DATABASE_URL);
const db = drizzle(client);

// ---------------------------------------------------------------------------
// Benchmark securities (we treat indices as 'securities' with isBenchmark=true)
// ---------------------------------------------------------------------------

const BENCHMARKS = [
  {
    ticker: "ASX",
    exchange: "FTSE",
    name: "FTSE All-Share Index",
    currency: "GBP" as const,
    isBenchmark: true,
  },
  {
    ticker: "SPX",
    exchange: "INDEX",
    name: "S&P 500 Index",
    currency: "USD" as const,
    isBenchmark: true,
  },
  {
    ticker: "MXWO",
    exchange: "INDEX",
    name: "MSCI World Index",
    currency: "USD" as const,
    isBenchmark: true,
  },
  {
    ticker: "SXXP",
    exchange: "INDEX",
    name: "STOXX Europe 600 ex-UK",
    currency: "EUR" as const,
    isBenchmark: true,
  },
  {
    ticker: "MXEF",
    exchange: "INDEX",
    name: "MSCI Emerging Markets Index",
    currency: "USD" as const,
    isBenchmark: true,
  },
  {
    ticker: "SOFR_CASH",
    exchange: "INDEX",
    name: "Cash + SOFR (synthetic benchmark)",
    currency: "USD" as const,
    isBenchmark: true,
  },
];

// ---------------------------------------------------------------------------
// Funds — locked from §1 of the spec
// ---------------------------------------------------------------------------

const FUNDS = [
  {
    name: "BIG Capital UK Equity Fund",
    slug: "uk-equity",
    baseCurrency: "GBP" as const,
    benchmarkTicker: "ASX",
    strategyDescription:
      "Long-only UK equity fund investing primarily in FTSE 350 constituents. Targets quality companies with durable competitive advantages and reasonable valuations.",
    startingNav: "100000",
  },
  {
    name: "BIG Capital US Equity Fund",
    slug: "us-equity",
    baseCurrency: "USD" as const,
    benchmarkTicker: "SPX",
    strategyDescription:
      "Long-only US equity fund focused on S&P 500 constituents and select mid-caps. Bottom-up fundamental analysis with a quality-and-growth bias.",
    startingNav: "100000",
  },
  {
    name: "BIG Capital Global Equity Fund",
    slug: "global-equity",
    baseCurrency: "USD" as const,
    benchmarkTicker: "MXWO",
    strategyDescription:
      "Long-only global developed-market equity fund. Best-ideas portfolio drawing on the firm's regional expertise.",
    startingNav: "100000",
  },
  {
    name: "BIG Capital European Equity Fund",
    slug: "european-equity",
    baseCurrency: "EUR" as const,
    benchmarkTicker: "SXXP",
    strategyDescription:
      "Long-only continental European equity fund (ex-UK). STOXX Europe 600 ex-UK constituents plus selective mid-cap opportunities.",
    startingNav: "100000",
  },
  {
    name: "BIG Capital Emerging Markets Equity Fund",
    slug: "em-equity",
    baseCurrency: "USD" as const,
    benchmarkTicker: "MXEF",
    strategyDescription:
      "Long-only emerging markets equity fund. MSCI EM universe with a focus on structural growth and governance quality.",
    startingNav: "100000",
  },
  {
    name: "BIG Capital Long/Short Equity Fund",
    slug: "long-short",
    baseCurrency: "USD" as const,
    benchmarkTicker: "SOFR_CASH",
    strategyDescription:
      "Market-neutral-leaning global developed-market equity long/short fund. Targets net exposure within ±20% and gross under 200%.",
    startingNav: "100000",
  },
];

const INCEPTION_DATE = "2026-06-01"; // placeholder; change before launch

// ---------------------------------------------------------------------------
// Default constraints
// ---------------------------------------------------------------------------

// Constraint policy locked in spec §11.5:
//   HARD: universe_only, long_only, max_gross_exposure, max_net_exposure
//   SOFT: everything else (warn + override with rationale)

function defaultConstraintsForLongOnly() {
  return [
    { type: "universe_only", value: true, isHard: true },
    { type: "long_only", value: true, isHard: true },
    { type: "max_position_pct", value: 0.08, isHard: false }, // 8% max position
    { type: "min_cash_pct", value: 0.02, isHard: false },
    { type: "max_cash_pct", value: 0.2, isHard: false },
    { type: "max_single_sector_pct", value: 0.35, isHard: false },
    { type: "max_position_count", value: 40, isHard: false },
  ];
}

function defaultConstraintsForLongShort() {
  return [
    { type: "universe_only", value: true, isHard: true },
    { type: "max_gross_exposure", value: 2.0, isHard: true }, // 200% gross max
    { type: "max_net_exposure", value: 0.2, isHard: true }, // ±20% net
    { type: "max_position_pct", value: 0.06, isHard: false }, // tighter than LO
    { type: "min_cash_pct", value: 0.0, isHard: false },
    { type: "max_cash_pct", value: 0.5, isHard: false },
    { type: "max_single_sector_pct", value: 0.4, isHard: false },
    { type: "max_position_count", value: 60, isHard: false },
  ];
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function seed() {
  console.log("Seeding BIG Capital database...");

  // 1. Benchmarks
  console.log("  → benchmark securities");
  for (const b of BENCHMARKS) {
    await db.insert(securities).values(b).onConflictDoNothing();
  }

  // 2. Funds (with benchmark FK resolution)
  console.log("  → funds");
  for (const f of FUNDS) {
    const bench = await db
      .select()
      .from(securities)
      .where(eq(securities.ticker, f.benchmarkTicker))
      .limit(1);
    if (bench.length === 0) {
      throw new Error(`Benchmark ${f.benchmarkTicker} not found`);
    }
    await db
      .insert(funds)
      .values({
        name: f.name,
        slug: f.slug,
        baseCurrency: f.baseCurrency,
        benchmarkSecurityId: bench[0].id,
        strategyDescription: f.strategyDescription,
        inceptionDate: INCEPTION_DATE,
        startingNav: f.startingNav,
      })
      .onConflictDoNothing();
  }

  // 3. Constraints per fund
  console.log("  → constraints");
  const allFunds = await db.select().from(funds);
  for (const f of allFunds) {
    const constraints =
      f.slug === "long-short"
        ? defaultConstraintsForLongShort()
        : defaultConstraintsForLongOnly();

    // Skip if this fund already has constraints (idempotency)
    const existing = await db
      .select()
      .from(fundConstraints)
      .where(eq(fundConstraints.fundId, f.id))
      .limit(1);
    if (existing.length > 0) continue;

    for (const c of constraints) {
      await db.insert(fundConstraints).values({
        fundId: f.id,
        constraintType: c.type,
        value: c.value,
        isHard: c.isHard,
      });
    }
  }

  console.log("Seed complete.");
  await client.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
