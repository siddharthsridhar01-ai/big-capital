import { NextRequest, NextResponse } from "next/server";
import { runYahooEodIngest } from "@/workers/fetch-prices-yahoo";
import { ingestDailyCloses } from "@/workers/daily-close-ingest";
import { recordJobRun } from "@/lib/job-runs";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const startedAt = new Date();
  try {
    // Fast batched quote pass (existing).
    const result = await runYahooEodIngest();

    // Authoritative close pass: real daily closes for every priceable security
    // (held, watchlist, benchmark) over a short trailing window, via the chart
    // endpoint. Runs LAST so its true closes win on conflict, corrects any
    // mid-session quote values, and self-heals a missed run. In its own
    // try/catch so a hiccup can't fail the core job.
    let eod: unknown = null;
    try {
      const from = new Date(Date.now() - 10 * 86400_000)
        .toISOString()
        .slice(0, 10);
      eod = await ingestDailyCloses(from, undefined, { concurrency: 5 });
    } catch (err) {
      eod = { error: err instanceof Error ? err.message : String(err) };
      console.error("Daily-close ingest failed (non-fatal):", err);
    }

    const status = result.errors.length > 0 ? 207 : 200;
    await recordJobRun({
      jobName: "prices",
      status: result.errors.length > 0 ? "partial" : "ok",
      startedAt,
      summary: { ...result, eod },
      error: result.errors.length > 0 ? JSON.stringify(result.errors) : null,
    });
    return NextResponse.json(
      { ok: result.errors.length === 0, ...result, eod },
      { status }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Prices cron failed:", err);
    await recordJobRun({ jobName: "prices", status: "error", startedAt, error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
