/**
 * Manual trigger — recompute NAV snapshots and report the result per fund.
 *   /api/admin/compute-nav?secret=<CRON_SECRET>
 *   optional &date=YYYY-MM-DD    (single day; default today)
 *   optional &from=YYYY-MM-DD    (recompute a range from this date to `date`)
 *
 * Runs the same job as the nightly NAV cron, then reads back each fund's most
 * recent NAV snapshot so you can SEE real numbers (a fund with ~£100k opening
 * capital should show NAV near £100k, moving with real prices — not the flat
 * synthetic seed line).
 *
 * Note: NAV needs a price for every open position on the computed date. Real
 * prices currently exist only from the day Yahoo ingest first ran, so compute
 * for a recent date — older dates will report "Missing price" until history
 * builds up (or the funds are clean-slated to a launch date going forward).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, navSnapshots } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { runNavSnapshot } from "@/workers/compute-nav";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

  const date = url.searchParams.get("date") ?? undefined;
  const fromDate = url.searchParams.get("from") ?? undefined;

  try {
    const run = await runNavSnapshot({ date, fromDate });

    // Read back the latest NAV snapshot per fund.
    const fundRows = await db
      .select({ id: fundsTable.id, slug: fundsTable.slug, baseCurrency: fundsTable.baseCurrency, startingNav: fundsTable.startingNav })
      .from(fundsTable)
      .where(eq(fundsTable.isActive, true));

    const latestNav: Array<{
      slug: string;
      baseCurrency: string;
      startingNav: string;
      latestDate: string | null;
      nav: string | null;
      cashBalance: string | null;
      positionValue: string | null;
      dailyReturn: string | null;
    }> = [];

    for (const f of fundRows) {
      const snap = await db
        .select({
          date: navSnapshots.date,
          nav: navSnapshots.nav,
          cashBalance: navSnapshots.cashBalance,
          positionValue: navSnapshots.positionValue,
          dailyReturn: navSnapshots.dailyReturn,
        })
        .from(navSnapshots)
        .where(eq(navSnapshots.fundId, f.id))
        .orderBy(desc(navSnapshots.date))
        .limit(1);
      latestNav.push({
        slug: f.slug,
        baseCurrency: f.baseCurrency,
        startingNav: f.startingNav,
        latestDate: snap[0]?.date ?? null,
        nav: snap[0]?.nav ?? null,
        cashBalance: snap[0]?.cashBalance ?? null,
        positionValue: snap[0]?.positionValue ?? null,
        dailyReturn: snap[0]?.dailyReturn ?? null,
      });
    }

    return NextResponse.json({ ok: run.errors.length === 0, run, latestNav });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
