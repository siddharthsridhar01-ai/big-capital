/**
 * One-time setup endpoint.
 *
 * Runs the database migration (creates all tables) and seeds the six funds.
 * Idempotent — safe to call multiple times.
 *
 * Usage:
 *   GET /api/setup?secret=YOUR_CRON_SECRET
 *
 * After successful run, the database is fully provisioned and the system
 * is ready for Phase 2 (PM dashboard).
 */

import { NextRequest, NextResponse } from "next/server";
import postgres from "postgres";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and } from "drizzle-orm";
import * as schema from "@/db/schema";
import { SEED_TICKERS } from "@/db/seed-tickers";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

interface SetupResult {
  migrations: { applied: string[]; alreadyApplied: string[] };
  seed: {
    benchmarks: number;
    funds: number;
    constraints: number;
    tickers: number;
    prices: number;
    universeLinks: number;
  };
  finalCheck: { funds: number; tickers: number };
}

export async function GET(req: NextRequest) {
  // Auth — accepts either ?secret= or Authorization: Bearer
  const url = new URL(req.url);
  const querySecret = url.searchParams.get("secret");
  const headerAuth = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET not configured" },
      { status: 500 }
    );
  }

  const authorized =
    querySecret === expected || headerAuth === `Bearer ${expected}`;
  if (!authorized) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL not configured" },
      { status: 500 }
    );
  }

  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 30 });
  const db = drizzle(sql, { schema });

  const result: SetupResult = {
    migrations: { applied: [], alreadyApplied: [] },
    seed: {
      benchmarks: 0,
      funds: 0,
      constraints: 0,
      tickers: 0,
      prices: 0,
      universeLinks: 0,
    },
    finalCheck: { funds: 0, tickers: 0 },
  };

  try {
    // ------------------------------------------------------------
    // 1. Run migrations
    // ------------------------------------------------------------
    await sql`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `;

    const migrationsDir = join(process.cwd(), "drizzle");
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const exists = await sql`
        SELECT 1 FROM __drizzle_migrations WHERE hash = ${file}
      `;
      if (exists.length > 0) {
        result.migrations.alreadyApplied.push(file);
        continue;
      }

      const contents = await readFile(join(migrationsDir, file), "utf-8");
      const statements = contents
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      await sql.begin(async (tx) => {
        for (const stmt of statements) {
          await tx.unsafe(stmt);
        }
        await tx`INSERT INTO __drizzle_migrations (hash) VALUES (${file})`;
      });
      result.migrations.applied.push(file);
    }

    // ------------------------------------------------------------
    // 2. Seed data (benchmarks, funds, constraints)
    // ------------------------------------------------------------

    const BENCHMARKS = [
      { ticker: "ASX", exchange: "FTSE", name: "FTSE All-Share Index", currency: "GBP" as const, isBenchmark: true },
      { ticker: "SPX", exchange: "INDEX", name: "S&P 500 Index", currency: "USD" as const, isBenchmark: true },
      { ticker: "MXWO", exchange: "INDEX", name: "MSCI World Index", currency: "USD" as const, isBenchmark: true },
      { ticker: "SXXP", exchange: "INDEX", name: "STOXX Europe 600 ex-UK", currency: "EUR" as const, isBenchmark: true },
      { ticker: "MXEF", exchange: "INDEX", name: "MSCI Emerging Markets Index", currency: "USD" as const, isBenchmark: true },
      { ticker: "SOFR_CASH", exchange: "INDEX", name: "Cash + SOFR (synthetic benchmark)", currency: "USD" as const, isBenchmark: true },
    ];

    for (const b of BENCHMARKS) {
      await db.insert(schema.securities).values(b).onConflictDoNothing();
      result.seed.benchmarks++;
    }

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

    const INCEPTION_DATE = "2026-06-01";

    for (const f of FUNDS) {
      const bench = await db
        .select()
        .from(schema.securities)
        .where(eq(schema.securities.ticker, f.benchmarkTicker))
        .limit(1);
      if (bench.length === 0) continue;

      await db
        .insert(schema.funds)
        .values({
          name: f.name,
          slug: f.slug,
          baseCurrency: f.baseCurrency,
          benchmarkSecurityId: bench[0].id,
          strategyDescription: f.strategyDescription,
          inceptionDate: INCEPTION_DATE,
          startingNav: f.startingNav,
        })
        .onConflictDoUpdate({
          // Re-running setup keeps schema-driven fields current. Notably, this
          // applies a NAV bump to funds that already exist in the DB.
          target: schema.funds.slug,
          set: {
            name: f.name,
            strategyDescription: f.strategyDescription,
            startingNav: f.startingNav,
          },
        });
      result.seed.funds++;
    }

    // Constraints per fund
    const longOnlyConstraints = [
      { type: "universe_only", value: true, isHard: true },
      { type: "long_only", value: true, isHard: true },
      { type: "max_position_pct", value: 0.08, isHard: false },
      { type: "min_cash_pct", value: 0.02, isHard: false },
      { type: "max_cash_pct", value: 0.2, isHard: false },
      { type: "max_single_sector_pct", value: 0.35, isHard: false },
      { type: "max_position_count", value: 40, isHard: false },
    ];

    const longShortConstraints = [
      { type: "universe_only", value: true, isHard: true },
      { type: "max_gross_exposure", value: 2.0, isHard: true },
      { type: "max_net_exposure", value: 0.2, isHard: true },
      { type: "max_position_pct", value: 0.06, isHard: false },
      { type: "min_cash_pct", value: 0.0, isHard: false },
      { type: "max_cash_pct", value: 0.5, isHard: false },
      { type: "max_single_sector_pct", value: 0.4, isHard: false },
      { type: "max_position_count", value: 60, isHard: false },
    ];

    const allFunds = await db.select().from(schema.funds);
    for (const f of allFunds) {
      const existing = await db
        .select()
        .from(schema.fundConstraints)
        .where(eq(schema.fundConstraints.fundId, f.id))
        .limit(1);
      if (existing.length > 0) continue;

      const constraints =
        f.slug === "long-short" ? longShortConstraints : longOnlyConstraints;
      for (const c of constraints) {
        await db.insert(schema.fundConstraints).values({
          fundId: f.id,
          constraintType: c.type,
          value: c.value,
          isHard: c.isHard,
        });
        result.seed.constraints++;
      }
    }

    // ------------------------------------------------------------
    // 3. Seed tickers — Phase 2b hand-picked universe
    // ------------------------------------------------------------
    // Insert securities (idempotent on ticker+exchange uniqueness)
    for (const t of SEED_TICKERS) {
      const existing = await db
        .select()
        .from(schema.securities)
        .where(
          and(
            eq(schema.securities.ticker, t.ticker),
            eq(schema.securities.exchange, t.exchange)
          )
        )
        .limit(1);
      if (existing.length > 0) continue;

      await db.insert(schema.securities).values({
        ticker: t.ticker,
        exchange: t.exchange,
        name: t.name,
        currency: t.currency,
        securityType: "equity",
        isin: t.isin ?? null,
        gicsSector: t.gicsSector,
        gicsIndustry: t.gicsIndustry,
        isBenchmark: false,
        isActive: true,
      });
      result.seed.tickers++;
    }

    // Clear any existing seed prices (source='seed'). This lets us correct
    // stale seed values by re-running setup. Real EODHD data (source='EODHD')
    // is preserved.
    await db.delete(schema.prices).where(eq(schema.prices.source, "seed"));

    // Insert today's seed close prices, AND a yesterday close so the daily
    // change indicators have something to render against. Yesterday's prices
    // are computed by reversing a deterministic small percentage move per
    // ticker — so the dashboard shows a believable mix of greens and reds
    // without requiring real EODHD data. Once EODHD is wired (Phase 4), real
    // daily prices replace all of this.
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // Pseudo-deterministic % move per ticker for the "yesterday → today" delta.
    // Range roughly ±2%. Mixes positives and negatives.
    function fakeDailyMovePct(ticker: string): number {
      // Hash the ticker to a number in [-0.02, +0.02]
      let h = 0;
      for (const ch of ticker) h = (h * 31 + ch.charCodeAt(0)) & 0xffffffff;
      const x = ((h % 401) - 200) / 10000; // -0.020 to +0.020
      return x;
    }

    for (const t of SEED_TICKERS) {
      const sec = await db
        .select()
        .from(schema.securities)
        .where(
          and(
            eq(schema.securities.ticker, t.ticker),
            eq(schema.securities.exchange, t.exchange)
          )
        )
        .limit(1);
      if (sec.length === 0) continue;

      const todayPrice = parseFloat(t.recentClose);
      const movePct = fakeDailyMovePct(t.ticker);
      // today = yesterday * (1 + movePct)  →  yesterday = today / (1 + movePct)
      const yesterdayPrice = todayPrice / (1 + movePct);

      // Today's close
      await db.insert(schema.prices).values({
        securityId: sec[0].id,
        date: today,
        closePrice: t.recentClose,
        currency: t.currency,
        source: "seed",
      });
      result.seed.prices++;

      // Yesterday's close (only if it isn't the same date as today, e.g. set up
      // around midnight could produce identical strings — defensive)
      if (yesterday !== today) {
        await db.insert(schema.prices).values({
          securityId: sec[0].id,
          date: yesterday,
          closePrice: yesterdayPrice.toFixed(4),
          currency: t.currency,
          source: "seed",
        });
        result.seed.prices++;
      }
    }

    // Link tickers to fund investable universes
    const fundsBySlug = new Map(allFunds.map((f) => [f.slug, f]));
    for (const t of SEED_TICKERS) {
      const sec = await db
        .select()
        .from(schema.securities)
        .where(
          and(
            eq(schema.securities.ticker, t.ticker),
            eq(schema.securities.exchange, t.exchange)
          )
        )
        .limit(1);
      if (sec.length === 0) continue;

      for (const slug of t.universes) {
        const fund = fundsBySlug.get(slug);
        if (!fund) continue;

        const existingLink = await db
          .select()
          .from(schema.investableUniverses)
          .where(
            and(
              eq(schema.investableUniverses.fundId, fund.id),
              eq(schema.investableUniverses.securityId, sec[0].id)
            )
          )
          .limit(1);
        if (existingLink.length > 0) continue;

        await db.insert(schema.investableUniverses).values({
          fundId: fund.id,
          securityId: sec[0].id,
          addedDate: today,
        });
        result.seed.universeLinks++;
      }
    }

    // ------------------------------------------------------------
    // 4. Final sanity check
    // ------------------------------------------------------------
    const finalFunds = await db.select().from(schema.funds);
    const finalTickers = await db
      .select()
      .from(schema.securities)
      .where(eq(schema.securities.isBenchmark, false));
    result.finalCheck.funds = finalFunds.length;
    result.finalCheck.tickers = finalTickers.length;

    return NextResponse.json({ ok: true, ...result, fundList: finalFunds.map((f) => ({ slug: f.slug, name: f.name, baseCurrency: f.baseCurrency })) });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        partial: result,
      },
      { status: 500 }
    );
  } finally {
    await sql.end();
  }
}
