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
import { and, eq, inArray, isNull, desc, gte } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "@/db/client";
import { funds, transactions, securities, prices } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { buildLedgerState, type Transaction, type Currency } from "@/lib/performance";
import { runSplitProcessing } from "@/workers/process-splits-yahoo";
import { detectCorporateActions, type HeldPriceObservation } from "@/lib/corporate-actions";

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

    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const fundRows = await db.select().from(funds).where(eq(funds.isActive, true));

    // Every currently held security, per fund.
    const held: Array<{ fund: string; securityId: string }> = [];
    const booked = new Set<string>();
    for (const fund of fundRows) {
      const raw = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.fundId, fund.id), isNull(transactions.voidedAt)));
      for (const t of raw) {
        if (t.transactionType === "corporate_action" && t.securityId) {
          booked.add(`${t.securityId}|${t.executedAt.toISOString().slice(0, 10)}`);
        }
      }
      const txns: Transaction[] = raw.map((t) => ({
        id: t.id,
        fundId: t.fundId,
        securityId: t.securityId,
        transactionType: t.transactionType as Transaction["transactionType"],
        quantity: t.quantity,
        price: t.price,
        currency: t.currency as Currency,
        cashImpact: t.cashImpact,
        fxRateToBase: t.fxRateToBase,
        executedAt: t.executedAt,
      }));
      const state = buildLedgerState(txns, now);
      for (const [securityId, pos] of state.positions) {
        if (!pos.quantity.isZero()) held.push({ fund: fund.slug, securityId });
      }
    }

    if (held.length === 0) {
      return NextResponse.json({ ok: true, mode, checked: 0, alerts: [] });
    }

    const secIds = Array.from(new Set(held.map((h) => h.securityId)));
    const secRows = await db
      .select({ id: securities.id, ticker: securities.ticker })
      .from(securities)
      .where(inArray(securities.id, secIds));
    const tickerOf = new Map(secRows.map((s) => [s.id, s.ticker]));

    // The two most recent closes for each held security, in ONE query bounded to
    // the last 30 days, rather than a query per security. Unbounded price reads
    // were the cause of the Supabase egress overage.
    const floor = new Date();
    floor.setUTCDate(floor.getUTCDate() - 30);
    const priceRows = await db
      .select({ securityId: prices.securityId, date: prices.date, close: prices.closePrice })
      .from(prices)
      .where(and(inArray(prices.securityId, secIds), gte(prices.date, floor.toISOString().slice(0, 10))))
      .orderBy(desc(prices.date));
    const recent = new Map<string, Array<{ date: string; close: string }>>();
    for (const r of priceRows) {
      const list = recent.get(r.securityId) ?? [];
      if (list.length < 2) list.push({ date: r.date, close: r.close });
      recent.set(r.securityId, list);
    }

    const observations: HeldPriceObservation[] = held.map((h) => {
      const rows = recent.get(h.securityId) ?? [];
      return {
        fund: h.fund,
        securityId: h.securityId,
        ticker: tickerOf.get(h.securityId) ?? "?",
        latestDate: rows[0]?.date ?? null,
        latestClose: rows[0] ? new Decimal(rows[0].close) : null,
        previousClose: rows[1] ? new Decimal(rows[1].close) : null,
      };
    });

    const alerts = detectCorporateActions(observations, booked, today);
    const body = {
      ok: alerts.length === 0,
      mode,
      checked: observations.length,
      alerts,
      summary: alerts.map((a) => a.message),
    };
    return NextResponse.json(body, { status: alerts.length === 0 ? 200 : 503 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("corporate-actions failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
