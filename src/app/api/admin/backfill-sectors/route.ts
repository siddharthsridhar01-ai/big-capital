/**
 * Admin — fill in GICS sectors for securities that have none.
 *
 *   GET /api/admin/backfill-sectors?secret=<CRON_SECRET>            (dry run)
 *   GET /api/admin/backfill-sectors?secret=...&apply=1              (writes)
 *   GET /api/admin/backfill-sectors?secret=...&apply=1&limit=40     (smaller batch)
 *
 * WHY: seed-fund-cores adds securities with { fetchSector: false }, because the
 * sector requires a second Yahoo call per name and the seed is already slow.
 * That was tolerable when the cores were a handful of names already present in
 * the database. It is not tolerable now: the European universe added roughly 50
 * new securities, and an unclassified security silently breaks things that
 * matter.
 *
 * max_single_sector_pct groups holdings by gicsSector, so with most names
 * unclassified the whole book collapses into one bucket and the sector cap stops
 * measuring anything real. The Exposures panel and the limits panel read the
 * same field.
 *
 * Batched and resumable: each run takes the oldest unclassified securities, so
 * repeated calls converge without any one request approaching the function
 * timeout.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { securities } from "@/db/schema";
import { toYahooSymbol } from "@/lib/intraday/yahoo";
import YahooFinance from "yahoo-finance2";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const DEFAULT_LIMIT = 25;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const apply = url.searchParams.get("apply") === "1";
  const limit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);

  try {
    const missing = await db
      .select({
        id: securities.id,
        ticker: securities.ticker,
        exchange: securities.exchange,
        name: securities.name,
      })
      .from(securities)
      .where(
        and(
          isNull(securities.gicsSector),
          eq(securities.isActive, true),
          eq(securities.isBenchmark, false)
        )
      )
      .limit(limit);

    if (missing.length === 0) {
      return NextResponse.json({ ok: true, remaining: 0, note: "Every active security has a sector." });
    }

    const report: Array<Record<string, unknown>> = [];
    for (const sec of missing) {
      const raw = toYahooSymbol(sec.ticker, sec.exchange);
      try {
        const profile = await yf.quoteSummary(raw, { modules: ["assetProfile"] });
        const sector = (profile?.assetProfile?.sector as string | undefined) ?? null;
        const industry = (profile?.assetProfile?.industry as string | undefined) ?? null;

        if (sector && apply) {
          await db
            .update(securities)
            .set({ gicsSector: sector, gicsIndustry: industry })
            .where(eq(securities.id, sec.id));
        }
        report.push({
          symbol: raw,
          name: sec.name,
          sector: sector ?? "(none returned)",
          status: !sector ? "no sector from provider" : apply ? "updated" : "would update",
        });
      } catch (err) {
        report.push({
          symbol: raw,
          name: sec.name,
          status: "lookup failed",
          error: err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80),
        });
      }
    }

    return NextResponse.json({
      ok: true,
      applied: apply,
      processed: report.length,
      hint: apply
        ? "Re-run until 'remaining: 0' — each call handles one batch."
        : "Dry run. Re-run with &apply=1 to write.",
      report,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("backfill-sectors failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
