/**
 * Cron — scheduled lagged-holdings reconstruction for all active funds.
 *
 * Bearer CRON_SECRET. Safe to run daily; it is idempotent and simply keeps the
 * most-recent-eligible month-end (top-10) and quarter-end (full) snapshots
 * current. Suggested schedule: daily, or a few times a month.
 *
 * Add to vercel.json crons, e.g.:
 *   { "path": "/api/cron/holdings", "schedule": "0 6 * * *" }
 */
import { NextRequest, NextResponse } from "next/server";
import { runHoldingsReconstruction } from "@/workers/reconstruct-holdings";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  try {
    const result = await runHoldingsReconstruction();
    const status = result.errors.length > 0 ? 207 : 200;
    return NextResponse.json({ ok: result.errors.length === 0, ...result }, { status });
  } catch (err) {
    console.error("Holdings cron failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
