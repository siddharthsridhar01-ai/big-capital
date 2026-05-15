/**
 * Cron endpoint for the FX ingest worker.
 * Triggered by Vercel Cron per vercel.json schedule.
 *
 * Security: Vercel cron requests include an Authorization header with
 * a secret defined in CRON_SECRET environment variable.
 */

import { NextRequest, NextResponse } from "next/server";
import { runFxIngest } from "@/workers/fetch-fx";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  try {
    const result = await runFxIngest();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("FX cron failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
