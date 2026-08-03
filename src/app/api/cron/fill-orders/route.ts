/**
 * Fills queued market-on-open orders. Runs frequently through the day: each run
 * fills any pending order whose market has since opened, at that session's
 * official opening print. Orders whose markets are still shut simply wait.
 *
 * Runs often because exchanges open at different times around the clock (Tokyo,
 * Hong Kong, London, New York), and we want the fill to land close to the open.
 */
import { NextRequest, NextResponse } from "next/server";
import { fillPendingOrders } from "@/workers/fill-pending-orders";
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
    const result = await fillPendingOrders();
    await recordJobRun({
      jobName: "fill-orders",
      status: result.errors > 0 ? "partial" : "ok",
      startedAt,
      summary: result,
      error: result.errors > 0 ? `${result.errors} order(s) errored` : null,
    });
    return NextResponse.json({ ok: result.errors === 0, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Fill-orders cron failed:", err);
    await recordJobRun({ jobName: "fill-orders", status: "error", startedAt, error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
