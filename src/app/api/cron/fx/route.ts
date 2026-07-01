/**
 * Cron endpoint for the FX ingest worker.
 * Security: Bearer CRON_SECRET.
 */
import { NextRequest, NextResponse } from "next/server";
import { runFxIngest } from "@/workers/fetch-fx";
import { recordJobRun } from "@/lib/job-runs";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const startedAt = new Date();
  try {
    const result = await runFxIngest();
    await recordJobRun({ jobName: "fx", status: "ok", startedAt, summary: result });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("FX cron failed:", err);
    await recordJobRun({ jobName: "fx", status: "error", startedAt, error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
