/**
 * Corporate actions — process and check.
 *
 *   GET /api/cron/corporate-actions?mode=process   books stock splits (Market tick)
 *   GET /api/cron/corporate-actions?mode=check     flags what needs a human (nightly)
 *
 * PROCESS books every split on a held security automatically and idempotently,
 * restating the position with cost basis preserved and settling any fraction as
 * cash in lieu. Always 200 unless it crashes: bookkeeping should not fail a run.
 *
 * CHECK returns 503 when a held security shows the signature of an event that
 * is not processed automatically — a large unexplained move, or a holding that
 * has stopped being priced. The 503 fails the workflow step, which emails the
 * admins. It runs nightly so one event produces one email, not twenty.
 *
 * Auth: the cron secret (Bearer or ?secret=) or a signed-in admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { getOrCreateUser } from "@/lib/auth";
import { runSplitProcessing } from "@/workers/process-splits-yahoo";
import { runCorporateActionScan } from "@/workers/scan-corporate-actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function authorised(req: NextRequest): Promise<boolean> {
  const auth = req.headers.get("authorization");
  const secret = new URL(req.url).searchParams.get("secret");
  if (auth === `Bearer ${process.env.CRON_SECRET}` || secret === process.env.CRON_SECRET) return true;
  const user = await getOrCreateUser();
  return Boolean(user && user.role === "admin");
}

export async function GET(req: NextRequest) {
  if (!(await authorised(req))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const mode = new URL(req.url).searchParams.get("mode") ?? "process";

  try {
    if (mode === "process") {
      const result = await runSplitProcessing();
      return NextResponse.json({ ok: true, mode, ...result });
    }

    if (mode !== "check") {
      return NextResponse.json({ ok: false, error: "mode must be process or check" }, { status: 400 });
    }

    // Scan filings, headlines and price signatures; every finding lands in the
    // feed once. Fail (503 -> email) on anything NEW and serious, or on any
    // holding still unpriced — a zombie position stays loud until booked.
    const scan = await runCorporateActionScan();
    const serious = scan.newEvents.filter((e) => e.severity !== "info");
    const needsAttention = serious.length > 0 || scan.openCritical > 0;
    return NextResponse.json(
      {
        ok: !needsAttention,
        mode,
        securitiesScanned: scan.securitiesScanned,
        newEvents: scan.newEvents,
        openCritical: scan.openCritical,
        summary: [
          ...serious.map((e) => `${e.ticker}: ${e.title}`),
          ...(scan.openCritical > 0
            ? [`${scan.openCritical} holding(s) still unpriced and unbooked — see the corporate action feed.`]
            : []),
        ],
        errors: scan.errors,
      },
      { status: needsAttention ? 503 : 200 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("corporate-actions failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
