/**
 * Self-healing NAV catch-up.
 *
 *   GET /api/cron/nav-catchup?secret=<CRON_SECRET>
 *
 * Strikes any NAV snapshot that is missing, and does nothing when none are.
 *
 * WHY THIS EXISTS: the nightly job is the only thing that strikes NAV, and it
 * has failed twice in a week — once on a 60s timeout, once because a benchmark
 * data gap blocked four funds. Each time the funds sat stale until someone
 * noticed and backfilled by hand.
 *
 * runNavSnapshot() already computes only the days each fund is missing, so
 * calling it repeatedly is cheap and idempotent: with nothing missing it is one
 * small query per fund and no writes. That makes it safe to run from the Market
 * tick workflow, which fires every half hour and has proved reliable — so a gap
 * closes within the hour instead of waiting for the next night, or for a human.
 *
 * Striking TODAY mid-session is prevented inside runNavSnapshot: a date is only
 * computed once the securities the fund holds have real closes for it. So this
 * heals the past and cannot fabricate the present.
 *
 * Deliberately does NOT run dividends, holdings reconstruction or
 * reconciliation. Those belong to the nightly job; this is the narrow repair.
 */
import { NextRequest, NextResponse } from "next/server";
import { runNavSnapshot } from "@/workers/compute-nav";
import { recordJobRun } from "@/lib/job-runs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const secret = new URL(req.url).searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const startedAt = new Date();
  try {
    const run = await runNavSnapshot();
    const healed = run.daysComputed > 0;

    // Only log a job run when work was actually done, so the health page shows
    // repairs rather than a wall of hourly no-ops.
    if (healed) {
      await recordJobRun({
        jobName: "nav-catchup",
        startedAt,
        status: run.errors.length > 0 ? "partial" : "ok",
        summary: { daysComputed: run.daysComputed, fundsProcessed: run.fundsProcessed },
      }).catch(() => {});
    }

    return NextResponse.json({
      ok: true,
      healed,
      daysComputed: run.daysComputed,
      fundsProcessed: run.fundsProcessed,
      skippedAwaitingCloses: run.skippedAwaitingCloses.length,
      truncated: run.truncated,
      errors: run.errors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("nav-catchup failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
