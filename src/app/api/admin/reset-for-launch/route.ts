/**
 * Admin — reset every fund to a clean start for the official launch.
 *
 *   GET /api/admin/reset-for-launch?secret=<CRON_SECRET>                     (dry run)
 *   GET /api/admin/reset-for-launch?secret=...&apply=1&confirm=RESET         (writes)
 *   ...&date=2026-10-01        inception date to set (default 2026-10-01)
 *   ...&theses=1               ALSO delete research (off by default)
 *
 * THIS IS THE MOST DESTRUCTIVE ROUTE IN THE SYSTEM. It deletes every trade and
 * every NAV snapshot for all six funds, which cannot be undone. It therefore
 * requires BOTH apply=1 AND confirm=RESET, and is dry-run by default.
 *
 * DELETED: transactions, trade attachments, positions, NAV snapshots, public
 * holdings snapshots, pending orders. Every fund restarts flat at its starting
 * capital on the inception date.
 *
 * KEPT: securities, prices, FX history, investable universes, constraints,
 * team membership, monthly briefings and — unless theses=1 — research. Prices
 * and universes are expensive to rebuild and are not performance records, so
 * wiping them would cost work without making the restart any cleaner. Research
 * written before launch is still the author's work; it is kept by default, and
 * a thesis with no trades against it simply reads as an unexecuted idea.
 *
 * RUN IT ON OR AFTER THE INCEPTION DATE. Running early is harmless — NAV is not
 * computed before inception — but the funds will show nothing until the date
 * arrives, which looks like a fault.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  funds,
  transactions,
  positions,
  navSnapshots,
  publicHoldingsSnapshots,
  pendingOrders,
  tradeAttachments,
} from "@/db/schema";
import { theses, thesisUpdates, thesisPostMortems } from "@/db/schema-theses";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DEFAULT_DATE = "2026-10-01";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const apply = url.searchParams.get("apply") === "1";
  const confirmed = url.searchParams.get("confirm") === "RESET";
  const wipeTheses = url.searchParams.get("theses") === "1";
  const date = url.searchParams.get("date") ?? DEFAULT_DATE;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ ok: false, error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (apply && !confirmed) {
    return NextResponse.json(
      { ok: false, error: "Refusing to delete. Add &confirm=RESET if you really mean it." },
      { status: 400 }
    );
  }

  try {
    const active = await db
      .select({ id: funds.id, slug: funds.slug, name: funds.name, startingNav: funds.startingNav })
      .from(funds)
      .where(eq(funds.isActive, true));

    const report: Array<Record<string, unknown>> = [];

    for (const fund of active) {
      const txns = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(eq(transactions.fundId, fund.id));
      const txnIds = txns.map((t) => t.id);

      const snaps = await db
        .select({ date: navSnapshots.date })
        .from(navSnapshots)
        .where(eq(navSnapshots.fundId, fund.id));

      const fundTheses = await db
        .select({ id: theses.id })
        .from(theses)
        .where(eq(theses.fundId, fund.id));

      if (apply) {
        if (txnIds.length > 0) {
          await db.delete(tradeAttachments).where(inArray(tradeAttachments.transactionId, txnIds));
          await db.delete(transactions).where(inArray(transactions.id, txnIds));
        }
        await db.delete(positions).where(eq(positions.fundId, fund.id));
        await db.delete(navSnapshots).where(eq(navSnapshots.fundId, fund.id));
        await db.delete(publicHoldingsSnapshots).where(eq(publicHoldingsSnapshots.fundId, fund.id));
        await db.delete(pendingOrders).where(eq(pendingOrders.fundId, fund.id));

        if (wipeTheses && fundTheses.length > 0) {
          const ids = fundTheses.map((t) => t.id);
          await db.delete(thesisPostMortems).where(inArray(thesisPostMortems.thesisId, ids));
          await db.delete(thesisUpdates).where(inArray(thesisUpdates.thesisId, ids));
          await db.delete(theses).where(inArray(theses.id, ids));
        }

        await db.update(funds).set({ inceptionDate: date }).where(eq(funds.id, fund.id));
      }

      report.push({
        fund: fund.slug,
        name: fund.name,
        transactions: txnIds.length,
        navSnapshots: snaps.length,
        theses: wipeTheses ? fundTheses.length : `${fundTheses.length} (kept)`,
        inceptionDate: date,
        startingCapital: fund.startingNav,
      });
    }

    return NextResponse.json({
      ok: true,
      applied: apply,
      date,
      funds: active.length,
      kept: "securities, prices, FX, universes, constraints, team, briefings" + (wipeTheses ? "" : ", theses"),
      report,
      next: apply
        ? [
            "Every fund is flat at its starting capital from " + date + ".",
            "NAV strikes from the first trading day on or after that date, via the usual catch-up.",
            "Nothing else to run.",
          ]
        : "Dry run. Add &apply=1&confirm=RESET to delete.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("reset-for-launch failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
