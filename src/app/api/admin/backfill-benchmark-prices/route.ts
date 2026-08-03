/**
 * Backfill historical daily closes for the priceable benchmark proxies
 * (e.g. FTAL.L, IWDA.L) so the benchmark comparison has history back to
 * inception. Delegates to the shared refreshBenchmarkPrices worker, which is
 * also run nightly (over a short trailing window) by the prices cron.
 *
 *   /api/admin/backfill-benchmark-prices?secret=<CRON_SECRET>
 *   optional &from=YYYY-MM-DD  (default 2026-06-01, the fund inception)
 *
 * After running this, re-run the NAV backfill
 * (/api/admin/compute-nav?...&from=2026-06-01) so each snapshot picks up the
 * now-present benchmark prices and computes benchmarkDailyReturn.
 */
import { NextRequest, NextResponse } from "next/server";
import { refreshBenchmarkPrices } from "@/workers/benchmark-prices";

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

  const from = url.searchParams.get("from") ?? "2026-06-01";
  const { to, report } = await refreshBenchmarkPrices(from);

  return NextResponse.json({
    ok: report.every((r) => r.status === "ok"),
    from,
    to,
    note:
      "Now re-run /api/admin/compute-nav?...&from=" +
      from +
      " so snapshots pick up these benchmark prices.",
    report,
  });
}
