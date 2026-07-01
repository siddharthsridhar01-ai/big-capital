/**
 * Cron — scheduled dividend ingestion for all active funds.
 *
 * Bearer CRON_SECRET. Idempotent; catches any new ex-dates since the last run.
 * Suggested schedule (after the price cron), e.g. in vercel.json:
 *   { "path": "/api/cron/dividends", "schedule": "0 23 * * 1-5" }
 */
import { NextRequest, NextResponse } from "next/server";
import { runYahooDividendIngest } from "@/workers/ingest-dividends-yahoo";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  try {
    const result = await runYahooDividendIngest();
    const status = result.errors.length > 0 ? 207 : 200;
    return NextResponse.json({ ok: result.errors.length === 0, ...result }, { status });
  } catch (err) {
    console.error("Dividend cron failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
