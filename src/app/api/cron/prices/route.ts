import { NextRequest, NextResponse } from "next/server";
import { runYahooEodIngest } from "@/workers/fetch-prices-yahoo";
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
    const status = result.errors.length > 0 ? 207 : 200;
    await recordJobRun({
      jobName: "prices",
      status: result.errors.length > 0 ? "partial" : "ok",
      startedAt,
      summary: result,
      error: result.errors.length > 0 ? JSON.stringify(result.errors) : null,
    });
    return NextResponse.json({ ok: result.errors.length === 0, ...result }, { status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Prices cron failed:", err);
    await recordJobRun({ jobName: "prices", status: "error", startedAt, error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
