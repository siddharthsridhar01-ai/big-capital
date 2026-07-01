/**
 * Manual trigger — ingest dividends.
 *   /api/admin/ingest-dividends?secret=<CRON_SECRET>
 *
 * Optional query params:
 *   fund=<slug>   limit to one fund
 *   from=YYYY-MM-DD, to=YYYY-MM-DD   ex-date window (default: inception..today)
 *
 * Idempotent — safe to run repeatedly and as a backfill.
 */
import { NextRequest, NextResponse } from "next/server";
import { runDividendIngest } from "@/workers/ingest-dividends";

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

  try {
    const result = await runDividendIngest({
      fundSlug: url.searchParams.get("fund") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    });
    return NextResponse.json({ ok: result.errors.length === 0, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
