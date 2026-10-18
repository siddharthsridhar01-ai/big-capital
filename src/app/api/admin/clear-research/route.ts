/**
 * Admin — clear pre-launch research and monthly letters.
 *
 *   GET /api/admin/clear-research?before=YYYY-MM-DD                          (preview)
 *   GET /api/admin/clear-research?before=YYYY-MM-DD&apply=1&confirm=CLEAR    (writes)
 *
 * Deletes theses (with their updates and post-mortems) and monthly letters
 * CREATED BEFORE the given date, across every fund.
 *
 * Separate from the launch reset on purpose. That reset has already run, and
 * PMs may have queued orders since; re-running it to catch research would delete
 * those orders too. This touches research and letters only — never trades,
 * positions, NAV or orders.
 *
 * Filtered by date rather than clearing everything because a PM may already have
 * written a thesis for Monday's open and linked a queued order to it. Clearing
 * only what predates the cutoff removes old test material while keeping
 * anything written for the launch.
 *
 * A thesis linked to an order or trade is UNLINKED from it rather than taking
 * the order with it: the order still executes, it just no longer points at the
 * deleted research.
 */
import { NextRequest, NextResponse } from "next/server";
import { inArray, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { monthlyBriefings, pendingOrders, transactions, funds } from "@/db/schema";
import { theses, thesisUpdates, thesisPostMortems } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  const viaSecret =
    auth === `Bearer ${process.env.CRON_SECRET}` || secret === process.env.CRON_SECRET;
  if (!viaSecret) {
    const user = await getOrCreateUser();
    if (!user || user.role !== "admin") {
      return NextResponse.json({ ok: false, error: "Admin only" }, { status: 401 });
    }
  }

  const apply = url.searchParams.get("apply") === "1";
  const confirmed = url.searchParams.get("confirm") === "CLEAR";
  const before = url.searchParams.get("before") ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) {
    return NextResponse.json({ ok: false, error: "before must be YYYY-MM-DD" }, { status: 400 });
  }
  if (apply && !confirmed) {
    return NextResponse.json(
      { ok: false, error: "Refusing to delete. Add &confirm=CLEAR if you mean it." },
      { status: 400 }
    );
  }
  const cutoff = new Date(`${before}T00:00:00Z`);

  try {
    const fundRows = await db.select({ id: funds.id, slug: funds.slug }).from(funds);
    const slugOf = new Map(fundRows.map((f) => [f.id, f.slug]));

    const oldTheses = await db
      .select({ id: theses.id, fundId: theses.fundId, title: theses.title, createdAt: theses.createdAt })
      .from(theses)
      .where(lt(theses.createdAt, cutoff));
    const oldLetters = await db
      .select({ id: monthlyBriefings.id, fundId: monthlyBriefings.fundId, period: monthlyBriefings.period })
      .from(monthlyBriefings)
      .where(lt(monthlyBriefings.createdAt, cutoff));

    const thesisIds = oldTheses.map((t) => t.id);

    if (apply) {
      if (thesisIds.length > 0) {
        // Unlink first, so orders and trades survive their research being removed.
        await db.update(pendingOrders).set({ thesisId: null }).where(inArray(pendingOrders.thesisId, thesisIds));
        await db.update(transactions).set({ thesisId: null }).where(inArray(transactions.thesisId, thesisIds));
        await db.delete(thesisPostMortems).where(inArray(thesisPostMortems.thesisId, thesisIds));
        await db.delete(thesisUpdates).where(inArray(thesisUpdates.thesisId, thesisIds));
        await db.delete(theses).where(inArray(theses.id, thesisIds));
      }
      if (oldLetters.length > 0) {
        await db.delete(monthlyBriefings).where(inArray(monthlyBriefings.id, oldLetters.map((l) => l.id)));
      }
    }

    return NextResponse.json({
      ok: true,
      applied: apply,
      before,
      theses: oldTheses.map((t) => ({
        fund: slugOf.get(t.fundId) ?? "?",
        title: t.title ?? "(untitled)",
        created: t.createdAt?.toISOString().slice(0, 10) ?? null,
      })),
      letters: oldLetters.map((l) => ({ fund: slugOf.get(l.fundId) ?? "?", period: l.period })),
      kept: "Trades, orders, positions, NAV, universes, team. Anything created on or after the cutoff.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("clear-research failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
