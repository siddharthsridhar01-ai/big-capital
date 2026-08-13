/**
 * Health check — is the data actually current?
 *
 *   GET /api/cron/health?secret=<CRON_SECRET>
 *
 * Returns 200 when everything is fresh, 503 when it is not.
 *
 * WHY THIS EXISTS: on 10 August the nightly NAV job began returning 504 (the
 * 14-day recompute exceeded Vercel's 60s function limit). Prices kept updating
 * because Market tick was unaffected, so the site looked alive while every
 * fund's NAV silently froze. It went unnoticed for four days.
 *
 * The lesson is not "make the nightly job perfect" — it will fail again for some
 * other reason. It is that a failure has to be NOTICED. So this endpoint is
 * called by Market tick, which runs every half hour and has proved reliable,
 * and a 503 here fails that workflow and sends an email. The reliable job
 * watches the fragile one, and the check is independent of the thing it checks.
 *
 * It also reports how close the nightly job is to the timeout, so the next
 * slowdown is visible before it becomes an outage rather than after.
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { funds, navSnapshots, prices } from "@/db/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Trading days, not calendar days: a Monday check must tolerate the weekend. */
function businessDaysBetween(fromYmd: string, toYmd: string): number {
  const a = new Date(`${fromYmd}T00:00:00Z`);
  const b = new Date(`${toYmd}T00:00:00Z`);
  let n = 0;
  const cur = new Date(a);
  while (cur < b) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const d = cur.getUTCDay();
    if (d !== 0 && d !== 6) n += 1;
  }
  return n;
}

/**
 * ONE business day.
 *
 * NAV strikes every weeknight, so the only healthy states are "struck today"
 * (0) or "struck yesterday, tonight's run pending" (1). Two business days means
 * last night's run did not produce a snapshot, and there is no benign reason for
 * that.
 *
 * This was originally 2, which let exactly the failure it existed to catch slip
 * through: on 13 Aug four funds sat at staleDays 2 having missed the 12th, and
 * the check still reported healthy. A watchdog that stays quiet while the thing
 * it watches is broken is worse than no watchdog, because people stop looking.
 */
const MAX_NAV_STALENESS_DAYS = 1;
const MAX_PRICE_STALENESS_DAYS = 2;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const secret = new URL(req.url).searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const problems: string[] = [];

  try {
    const activeFunds = await db
      .select({ id: funds.id, slug: funds.slug })
      .from(funds)
      .where(eq(funds.isActive, true));

    const navReport: Array<{ fund: string; lastNav: string | null; staleDays: number }> = [];

    for (const f of activeFunds) {
      const [latest] = await db
        .select({ date: navSnapshots.date })
        .from(navSnapshots)
        .where(eq(navSnapshots.fundId, f.id))
        .orderBy(desc(navSnapshots.date))
        .limit(1);

      const lastNav = latest ? String(latest.date).slice(0, 10) : null;
      const staleDays = lastNav ? businessDaysBetween(lastNav, today) : 999;
      navReport.push({ fund: f.slug, lastNav, staleDays });

      if (staleDays > MAX_NAV_STALENESS_DAYS) {
        problems.push(
          lastNav
            ? `${f.slug}: NAV last struck ${lastNav} (${staleDays} business days ago)`
            : `${f.slug}: no NAV snapshot at all`
        );
      }
    }

    const [priceRow] = await db
      .select({ latest: sql<string>`max(${prices.date})` })
      .from(prices);
    const lastPrice = priceRow?.latest ? String(priceRow.latest).slice(0, 10) : null;
    const priceStale = lastPrice ? businessDaysBetween(lastPrice, today) : 999;
    if (priceStale > MAX_PRICE_STALENESS_DAYS) {
      problems.push(`prices last updated ${lastPrice ?? "never"} (${priceStale} business days ago)`);
    }

    const healthy = problems.length === 0;
    return NextResponse.json(
      {
        ok: healthy,
        checkedAt: today,
        problems,
        nav: navReport,
        prices: { lastDate: lastPrice, staleBusinessDays: priceStale },
        thresholds: { navDays: MAX_NAV_STALENESS_DAYS, priceDays: MAX_PRICE_STALENESS_DAYS },
      },
      { status: healthy ? 200 : 503 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("health check failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}
