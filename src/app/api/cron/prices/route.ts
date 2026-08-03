import { NextRequest, NextResponse } from "next/server";
import { runYahooEodIngest } from "@/workers/fetch-prices-yahoo";
import { refreshBenchmarkPrices } from "@/workers/benchmark-prices";
import { recordJobRun } from "@/lib/job-runs";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const startedAt = new Date();
  try {
    const result = await runYahooEodIngest();

    // Benchmark proxies (FTAL.L etc.) aren't picked up by the EOD quote ingest
    // above, so refresh them here over a short trailing window. Kept in its own
    // try/catch: a benchmark hiccup must never fail the core price job. Runs
    // before the NAV cron so compute-nav finds today's benchmark close.
    let benchmark: unknown = null;
    try {
      const from = new Date(Date.now() - 8 * 86400_000)
        .toISOString()
        .slice(0, 10);
      benchmark = await refreshBenchmarkPrices(from);
    } catch (err) {
      benchmark = {
        error: err instanceof Error ? err.message : String(err),
      };
      console.error("Benchmark refresh failed (non-fatal):", err);
    }

    const status = result.errors.length > 0 ? 207 : 200;
    await recordJobRun({
      jobName: "prices",
      status: result.errors.length > 0 ? "partial" : "ok",
      startedAt,
      summary: { ...result, benchmark },
      error: result.errors.length > 0 ? JSON.stringify(result.errors) : null,
    });
    return NextResponse.json(
      { ok: result.errors.length === 0, ...result, benchmark },
      { status }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Prices cron failed:", err);
    await recordJobRun({ jobName: "prices", status: "error", startedAt, error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
