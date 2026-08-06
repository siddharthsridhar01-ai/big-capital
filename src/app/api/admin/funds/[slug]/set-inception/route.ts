/**
 * Admin — move a fund's inception date and clear everything before it.
 *
 * GET /api/admin/funds/[slug]/set-inception?date=YYYY-MM-DD[&apply=1]
 *
 * Why this exists: a fund set up with an early inception date accumulates
 * simulated/test trades during the setup period. Those inflate the published
 * track record and make the public factsheet (which chains daily returns from
 * the first NAV snapshot) disagree with the dashboard (which compares live NAV
 * against startingNav over the fund's whole life). Moving inception forward and
 * deleting the pre-inception ledger makes the fund start cleanly at
 * startingNav on the new date.
 *
 * Deletes, in FK-safe order: trade attachments -> transactions dated before the
 * new inception -> NAV snapshots dated before it. Positions are NOT deleted
 * here because they are derived; rebuild them afterwards with
 * /api/admin/reconstruct-holdings. Theses are left alone — they are research,
 * not ledger entries.
 *
 * DRY RUN BY DEFAULT. Pass &apply=1 to actually write. This destroys audit
 * history, so it is intended for the setup period only.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db/client";
import {
  funds as fundsTable,
  transactions,
  tradeAttachments,
  navSnapshots,
  securities,
} from "@/db/schema";
import { and, eq, inArray, lt } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { slug } = await params;
  const newInception = url.searchParams.get("date");
  const apply = url.searchParams.get("apply") === "1";

  if (!newInception || !/^\d{4}-\d{2}-\d{2}$/.test(newInception)) {
    return NextResponse.json(
      { ok: false, error: "Pass ?date=YYYY-MM-DD (the new inception date)." },
      { status: 400 }
    );
  }

  try {
    const fundRows = await db
      .select()
      .from(fundsTable)
      .where(eq(fundsTable.slug, slug))
      .limit(1);
    if (fundRows.length === 0) {
      return NextResponse.json({ ok: false, error: `Fund '${slug}' not found` }, { status: 404 });
    }
    const fund = fundRows[0];

    // Transactions executed strictly before the new inception date.
    const cutoff = new Date(`${newInception}T00:00:00Z`);
    const doomedTxns = await db
      .select({
        id: transactions.id,
        type: transactions.transactionType,
        ticker: securities.ticker,
        quantity: transactions.quantity,
        price: transactions.price,
        currency: transactions.currency,
        cashImpact: transactions.cashImpact,
        executedAt: transactions.executedAt,
      })
      .from(transactions)
      .leftJoin(securities, eq(securities.id, transactions.securityId))
      .where(and(eq(transactions.fundId, fund.id), lt(transactions.executedAt, cutoff)));

    // NAV snapshots dated before the new inception date.
    const doomedSnapshots = await db
      .select({ date: navSnapshots.date, nav: navSnapshots.nav })
      .from(navSnapshots)
      .where(and(eq(navSnapshots.fundId, fund.id), lt(navSnapshots.date, newInception)));

    if (apply) {
      const txnIds = doomedTxns.map((t) => t.id);
      if (txnIds.length > 0) {
        // Attachments first — they hold an FK to transactions.
        await db.delete(tradeAttachments).where(inArray(tradeAttachments.transactionId, txnIds));
        await db.delete(transactions).where(inArray(transactions.id, txnIds));
      }
      await db
        .delete(navSnapshots)
        .where(and(eq(navSnapshots.fundId, fund.id), lt(navSnapshots.date, newInception)));
      await db
        .update(fundsTable)
        .set({ inceptionDate: newInception })
        .where(eq(fundsTable.id, fund.id));
    }

    return NextResponse.json({
      ok: true,
      applied: apply,
      fund: fund.slug,
      inceptionDate: { before: fund.inceptionDate, after: apply ? newInception : fund.inceptionDate },
      startingNav: fund.startingNav,
      transactionsBeforeInception: {
        count: doomedTxns.length,
        deleted: apply,
        rows: doomedTxns.map((t) => ({
          type: t.type,
          ticker: t.ticker,
          quantity: t.quantity,
          price: t.price,
          currency: t.currency,
          cashImpact: t.cashImpact,
          executedAt: t.executedAt,
        })),
      },
      navSnapshotsBeforeInception: {
        count: doomedSnapshots.length,
        deleted: apply,
        earliest: doomedSnapshots[0]?.date ?? null,
      },
      hint: apply
        ? "Now run /api/admin/reconstruct-holdings, then /api/admin/compute-nav?from=" + newInception
        : "Dry run only. Re-run with &apply=1 to delete these and move the inception date.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("set-inception failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
