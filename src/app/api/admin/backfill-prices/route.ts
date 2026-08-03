/**
 * Deep price backfill — pulls real daily closes for EVERY priceable security
 * (held, watchlist, benchmark) over a long window, so charts have real history
 * and are current to today. Chart-based, so it works where the batch quote path
 * doesn't. Idempotent.
 *
 *   /api/admin/backfill-prices?secret=<CRON_SECRET>
 *   optional &from=YYYY-MM-DD   (default: 1 year ago)
 *
 * Safe to re-run. After running, the nightly cron keeps everything current.
 */
import { NextRequest, NextResponse } from "next/server";
import { ingestDailyCloses } from "@/workers/daily-close-ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const provided =
    url.searchParams.get("secret") ??
    (req.headers.get("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization")!.slice("Bearer ".length)
      : null);
  if (!provided || provided !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const oneYearAgo = new Date(Date.now() - 366 * 86400_000)
    .toISOString()
    .slice(0, 10);
  const from = url.searchParams.get("from") ?? oneYearAgo;

  const result = await ingestDailyCloses(from, undefined, { concurrency: 6 });

  return NextResponse.json({ ok: result.errors === 0, ...result });
}
