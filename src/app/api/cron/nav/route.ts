/**
 * Cron — nightly consolidated job (runs weekdays 23:00 UTC, after fx + prices).
 *
 * Folds three jobs into one scheduled cron so they all run on the free plan
 * within the cron limit. Order matters:
 *   1. Dividends  — book any new ex-date dividends into the ledger FIRST, so
 *                   the day's dividend cash is present before NAV replays it.
 *   2. NAV        — compute today's NAV snapshot from the (now-complete) ledger.
 *   3. Holdings   — lagged public-holdings reconstruction, which reads the NAV
 *                   snapshots produced in step 2.
 *
 * Sequential + independent: a failure in one step is recorded but does not stop
 * the others, and because they run in this order the important parts (dividends,
 * NAV) complete before the heavier reconstruction.
 *
 * The standalone /api/cron/dividends and /api/cron/holdings routes remain for
 * manual/ad-hoc runs; they are just not separately scheduled.
 */
import { NextRequest, NextResponse } from "next/server";
import { runNavSnapshot } from "@/workers/compute-nav";
import { runYahooDividendIngest } from "@/workers/ingest-dividends-yahoo";
import { runHoldingsReconstruction } from "@/workers/reconstruct-holdings";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const out: {
    dividends?: unknown;
    nav?: unknown;
    holdings?: unknown;
    errors: Array<{ step: string; message: string }>;
  } = { errors: [] };

  // 1. Dividends — into the ledger before NAV reads it.
  try {
    out.dividends = await runYahooDividendIngest();
  } catch (err) {
    out.errors.push({ step: "dividends", message: err instanceof Error ? err.message : String(err) });
  }

  // 2. NAV — snapshot for today.
  try {
    out.nav = await runNavSnapshot();
  } catch (err) {
    out.errors.push({ step: "nav", message: err instanceof Error ? err.message : String(err) });
  }

  // 3. Holdings — lagged reconstruction, reads the NAV snapshots above.
  try {
    out.holdings = await runHoldingsReconstruction();
  } catch (err) {
    out.errors.push({ step: "holdings", message: err instanceof Error ? err.message : String(err) });
  }

  const status = out.errors.length > 0 ? 207 : 200;
  return NextResponse.json({ ok: out.errors.length === 0, ...out }, { status });
}
