/**
 * Admin: clear NAV snapshots (and optionally recompute today).
 *   /api/admin/reset-nav-snapshots?secret=<CRON_SECRET>
 *   optional &fund=<slug>          limit to one fund (default: all funds)
 *   optional &recompute=false      skip the immediate recompute (default: recompute)
 *
 * Why: the nav_snapshots table currently holds synthetic SEED rows plus stale
 * pre-fix rows (NAV computed before opening capital was seeded). Those make the
 * NAV chart unreadable. This clears them so the chart reflects only real,
 * correctly-computed snapshots. Trades, theses, prices, and everything else are
 * left untouched — only the derived NAV history is cleared, and it rebuilds
 * from the ledger + prices via the nightly cron (or the recompute below).
 *
 * Safe on test data; on a live fund this discards computed history (it can be
 * rebuilt, but don't run it lightly post-launch).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import { funds as fundsTable, navSnapshots } from "@/db/schema";
import { eq } from "drizzle-orm";
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

  const fundSlug = url.searchParams.get("fund");
  const recompute = url.searchParams.get("recompute") !== "false";

  try {
    let scope: string;
    if (fundSlug) {
      const rows = await db.select({ id: fundsTable.id }).from(fundsTable).where(eq(fundsTable.slug, fundSlug)).limit(1);
      if (rows.length === 0) {
        return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
      }
      await db.delete(navSnapshots).where(eq(navSnapshots.fundId, rows[0].id));
      scope = fundSlug;
    } else {
      await db.delete(navSnapshots); // all funds
      scope = "all funds";
    }

    const recomputed = recompute ? await runNavSnapshot({ date: url.searchParams.get("date") ?? undefined }) : null;

    return NextResponse.json({
      ok: true,
      cleared: scope,
      recomputed,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
