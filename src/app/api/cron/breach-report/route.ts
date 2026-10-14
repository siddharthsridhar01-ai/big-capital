/**
 * Soft-constraint override report.
 *
 *   GET /api/cron/breach-report?secret=<CRON_SECRET>
 *   ...&days=7        lookback window (default 1)
 *
 * Soft limits exist so a PM can exceed them deliberately and defend it, not so
 * breaches pass unseen. The justification was already being recorded on the
 * trade; nothing ever surfaced it, so in practice an override was invisible
 * unless somebody opened that specific transaction.
 *
 * Called by the Market tick workflow, which runs hourly and has proved reliable.
 * Returns 200 with `overrides: []` when there is nothing to report, so a quiet
 * day stays quiet.
 *
 * NOTE ON DELIVERY: this reports; it does not email. There is no mail provider
 * in the stack, so the workflow surfaces overrides as GitHub annotations, which
 * reach whoever watches the repo. Wiring real email is a small change once a
 * provider exists — see the handover.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, gte, isNotNull, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { transactions, funds, securities, users } from "@/db/schema";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 1), 1), 90);
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);

  try {
    const rows = await db
      .select({
        id: transactions.id,
        createdAt: transactions.createdAt,
        kind: transactions.transactionType,
        quantity: transactions.quantity,
        price: transactions.price,
        overridden: transactions.overriddenConstraints,
        rationale: transactions.rationale,
        fund: funds.slug,
        fundName: funds.name,
        ticker: securities.ticker,
        securityName: securities.name,
        by: users.fullName,
        byEmail: users.email,
      })
      .from(transactions)
      .innerJoin(funds, eq(funds.id, transactions.fundId))
      .leftJoin(securities, eq(securities.id, transactions.securityId))
      .leftJoin(users, eq(users.id, transactions.executedByUserId))
      .where(
        and(
          isNotNull(transactions.overriddenConstraints),
          gte(transactions.createdAt, since)
        )
      )
      .orderBy(desc(transactions.createdAt))
      .limit(100);

    const overrides = rows.map((r) => {
      // Shape written by execute-trade: { violations: [...], justification, acceptedAt }
      const ov = (r.overridden ?? {}) as {
        violations?: Array<{ type?: string; message?: string }>;
        justification?: string;
      };
      const limits = ov.violations ?? [];
      return {
        when: r.createdAt?.toISOString() ?? null,
        fund: r.fund,
        by: r.by ?? r.byEmail ?? "unknown",
        trade: `${String(r.kind).toUpperCase()} ${r.quantity} ${r.ticker ?? "?"} @ ${r.price}`,
        limitsBreached: limits.map((l) => l.type ?? "?"),
        detail: limits.map((l) => l.message ?? "").filter(Boolean),
        justification: ov.justification ?? "(none recorded)",
        rationale: r.rationale,
      };
    });

    return NextResponse.json({
      ok: true,
      windowDays: days,
      count: overrides.length,
      // One line per override, formatted for a workflow annotation.
      summary: overrides.map(
        (o) =>
          `${o.fund}: ${o.by} overrode ${o.limitsBreached.join(", ")} on ${o.trade} — "${o.justification}"`
      ),
      overrides,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("breach-report failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
