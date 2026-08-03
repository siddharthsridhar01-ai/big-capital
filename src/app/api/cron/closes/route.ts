/**
 * Captures each exchange's official daily close as soon as that exchange has
 * closed, rather than waiting for a single nightly run. Runs frequently through
 * the day; for any market still trading, today's (in-progress) bar is skipped,
 * so a mid-session price is never recorded as a close.
 *
 * This is what keeps the price lists, security charts and "Close · date" labels
 * current within ~30 minutes of each market's close, worldwide.
 */
import { NextRequest, NextResponse } from "next/server";
import { ingestDailyCloses } from "@/workers/daily-close-ingest";
import { recordJobRun } from "@/lib/job-runs";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const secret = new URL(req.url).searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const startedAt = new Date();
  try {
    // Short trailing window: today's closes plus a few days of self-healing.
    const from = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
    const result = await ingestDailyCloses(from, undefined, {
      concurrency: 5,
      finalisedOnly: true,
    });
    await recordJobRun({
      jobName: "closes",
      status: result.errors > 0 ? "partial" : "ok",
      startedAt,
      summary: result,
      error: result.errors > 0 ? `${result.errors} symbol(s) errored` : null,
    });
    return NextResponse.json({ ok: result.errors === 0, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Closes cron failed:", err);
    await recordJobRun({ jobName: "closes", status: "error", startedAt, error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
