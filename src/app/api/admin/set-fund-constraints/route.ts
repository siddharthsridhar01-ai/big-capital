/**
 * Admin — set constraints tailored to each fund's actual mandate.
 *
 *   GET /api/admin/set-fund-constraints?secret=<CRON_SECRET>          (dry run)
 *   GET /api/admin/set-fund-constraints?secret=...&apply=1            (writes)
 *   GET /api/admin/set-fund-constraints?secret=...&fund=<slug>        (one fund)
 *
 * The seed applied one of two generic templates (long_only / long_short) to
 * every fund. That left several funds carrying limits that describe a different
 * strategy from the one they run:
 *
 *   - long-short is mandated with a NET-LONG BIAS but inherited the ±20% net cap
 *     of a market-neutral book, so its own strategy would breach on day one.
 *   - global-equity is "a focused portfolio of 15–20 names" but carried a 40-name
 *     cap and an 8% position cap, which describe a diversified fund.
 *   - systematic-equity is "a diversified book" sized by optimiser, yet carried
 *     the same 40/8% limits as a concentrated discretionary fund.
 *
 * A limit that does not match the mandate is worse than no limit: it trains PMs
 * to treat breaches as noise. Each set below is derived from the fund's own
 * strategy description.
 *
 * Replaces the active constraint rows for a fund. Idempotent, dry-run by default.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { funds, fundConstraints } from "@/db/schema";

export const dynamic = "force-dynamic";

interface C {
  type: string;
  value: unknown;
  isHard: boolean;
}

const MANDATES: Record<string, { rationale: string; constraints: C[] }> = {
  // Contrarian value, FTSE 350. Diversified by construction; UK index sector
  // weights are lumpy (financials, energy) so the sector cap stays generous.
  "uk-equity": {
    rationale: "Long-only UK value: diversified, lumpy index sectors, modest cash",
    constraints: [
      { type: "universe_only", value: true, isHard: true },
      { type: "long_only", value: true, isHard: true },
      { type: "max_position_pct", value: 0.08, isHard: false },
      { type: "min_cash_pct", value: 0.02, isHard: false },
      { type: "max_cash_pct", value: 0.15, isHard: false },
      { type: "max_single_sector_pct", value: 0.35, isHard: false },
      { type: "max_position_count", value: 40, isHard: false },
    ],
  },

  // "A focused portfolio of 15-20 names" with an initial emphasis on staples.
  // Focus means larger positions and fewer of them; the sector cap is loose
  // enough to permit the stated starting tilt without an immediate breach.
  "global-equity": {
    rationale: "Long-only quality, focused 15–20 names with an initial staples tilt",
    constraints: [
      { type: "universe_only", value: true, isHard: true },
      { type: "long_only", value: true, isHard: true },
      { type: "max_position_pct", value: 0.12, isHard: false },
      { type: "min_cash_pct", value: 0.02, isHard: false },
      { type: "max_cash_pct", value: 0.15, isHard: false },
      { type: "max_single_sector_pct", value: 0.45, isHard: false },
      { type: "max_position_count", value: 25, isHard: false },
    ],
  },

  // "Net-long bias", concentrated, up to 20 positions, single-name shorts.
  // Net cap must ACCOMMODATE the bias rather than forbid it: 80% net allows a
  // conventional long-biased book while still ruling out an unhedged 100% long.
  "long-short": {
    rationale: "Net-long bias: net cap raised from the market-neutral 20% to 80%",
    constraints: [
      { type: "universe_only", value: true, isHard: true },
      { type: "max_gross_exposure", value: 1.8, isHard: true },
      { type: "max_net_exposure", value: 0.8, isHard: true },
      { type: "max_position_pct", value: 0.08, isHard: false },
      { type: "min_cash_pct", value: 0.0, isHard: false },
      { type: "max_cash_pct", value: 0.4, isHard: false },
      { type: "max_single_sector_pct", value: 0.4, isHard: false },
      { type: "max_position_count", value: 20, isHard: false },
    ],
  },

  // "Balanced book of 12-14 positions... independent of broad market direction."
  // Neutrality is the product, so the net cap is tight and hard.
  "market-neutral": {
    rationale: "True market neutrality: hard ±10% net, balanced 12–14 name book",
    constraints: [
      { type: "universe_only", value: true, isHard: true },
      { type: "max_gross_exposure", value: 2.0, isHard: true },
      { type: "max_net_exposure", value: 0.1, isHard: true },
      { type: "max_position_pct", value: 0.1, isHard: false },
      { type: "min_cash_pct", value: 0.0, isHard: false },
      { type: "max_cash_pct", value: 0.5, isHard: false },
      { type: "max_single_sector_pct", value: 0.3, isHard: false },
      { type: "max_position_count", value: 16, isHard: false },
    ],
  },

  // "Rules-based... portfolio optimisation... across a diversified book."
  // Systematic books hold many small positions; a 4% cap and an 80-name ceiling
  // reflect optimiser output rather than discretionary conviction sizing.
  "systematic-equity": {
    rationale: "Rules-based diversification: many small positions, tight single-name cap",
    constraints: [
      { type: "universe_only", value: true, isHard: true },
      { type: "long_only", value: true, isHard: true },
      { type: "max_position_pct", value: 0.04, isHard: false },
      { type: "min_cash_pct", value: 0.0, isHard: false },
      { type: "max_cash_pct", value: 0.1, isHard: false },
      { type: "max_single_sector_pct", value: 0.3, isHard: false },
      { type: "max_position_count", value: 80, isHard: false },
    ],
  },

  // Pair trades only, 2-5 pairs (4-10 positions), mega-cap tech. Concentration
  // IS the strategy, so the position cap is deliberately loose. A sector cap is
  // meaningless in a single-sector fund and is set to 100% rather than removed,
  // so the panel still shows the measurement.
  "tech-relative-value": {
    rationale: "Tech pairs: hard ±10% net, concentrated by design, sector cap not applicable",
    constraints: [
      { type: "universe_only", value: true, isHard: true },
      { type: "max_gross_exposure", value: 2.0, isHard: true },
      { type: "max_net_exposure", value: 0.1, isHard: true },
      { type: "max_position_pct", value: 0.15, isHard: false },
      { type: "min_cash_pct", value: 0.0, isHard: false },
      { type: "max_cash_pct", value: 0.6, isHard: false },
      { type: "max_single_sector_pct", value: 1.0, isHard: false },
      { type: "max_position_count", value: 12, isHard: false },
    ],
  },
};

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const apply = url.searchParams.get("apply") === "1";
  const only = url.searchParams.get("fund");

  try {
    const rows = await db.select({ id: funds.id, slug: funds.slug }).from(funds);
    const bySlug = new Map(rows.map((f) => [f.slug, f.id]));
    const report: Array<Record<string, unknown>> = [];

    for (const [slug, mandate] of Object.entries(MANDATES)) {
      if (only && only !== slug) continue;
      const fundId = bySlug.get(slug);
      if (!fundId) {
        report.push({ fund: slug, status: "fund not found" });
        continue;
      }

      const current = await db
        .select({ type: fundConstraints.constraintType, value: fundConstraints.value })
        .from(fundConstraints)
        .where(and(eq(fundConstraints.fundId, fundId), eq(fundConstraints.isActive, true)));

      const before = new Map(current.map((c) => [c.type, c.value]));
      const changes: string[] = [];
      for (const c of mandate.constraints) {
        const was = before.get(c.type);
        if (was === undefined) changes.push(`+${c.type}=${JSON.stringify(c.value)}`);
        else if (JSON.stringify(was) !== JSON.stringify(c.value))
          changes.push(`${c.type}: ${JSON.stringify(was)} -> ${JSON.stringify(c.value)}`);
      }
      for (const t of before.keys()) {
        if (!mandate.constraints.some((c) => c.type === t)) changes.push(`-${t}`);
      }

      if (apply) {
        await db.delete(fundConstraints).where(eq(fundConstraints.fundId, fundId));
        for (const c of mandate.constraints) {
          await db.insert(fundConstraints).values({
            fundId,
            constraintType: c.type,
            value: c.value,
            isHard: c.isHard,
          });
        }
      }

      report.push({
        fund: slug,
        rationale: mandate.rationale,
        status: changes.length === 0 ? "already correct" : apply ? "updated" : "would update",
        changes: changes.length === 0 ? undefined : changes,
      });
    }

    return NextResponse.json({
      ok: true,
      applied: apply,
      hint: apply ? undefined : "Dry run. Re-run with &apply=1 to write.",
      report,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("set-fund-constraints failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
