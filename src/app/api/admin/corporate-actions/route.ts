/**
 * Admin — the corporate action feed.
 *
 *   GET  /api/admin/corporate-actions                 the feed, newest first
 *   POST /api/admin/corporate-actions
 *        { action: "book", ...BookingRequest }        preview (apply:false) or book
 *        { action: "dismiss", eventId, reason }       reviewed, no action needed
 *
 * Signed-in admins only. Booking is previewed first by design; see
 * src/workers/book-corporate-action.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { corporateActionEvents, securities, funds, transactions } from "@/db/schema";
import { buildLedgerState, type Transaction, type Currency } from "@/lib/performance";
import { getOrCreateUser } from "@/lib/auth";
import { bookCorporateAction, type BookingRequest } from "@/workers/book-corporate-action";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function admin() {
  const u = await getOrCreateUser();
  return u && u.role === "admin" ? u : null;
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  try {
    const events = await db
      .select()
      .from(corporateActionEvents)
      .orderBy(desc(corporateActionEvents.detectedAt))
      .limit(150);

    const secIds = Array.from(new Set(events.map((e) => e.securityId)));
    const fundIds = Array.from(new Set(events.map((e) => e.fundId).filter(Boolean) as string[]));
    const secRows = secIds.length
      ? await db
          .select({ id: securities.id, ticker: securities.ticker, name: securities.name, currency: securities.currency })
          .from(securities)
          .where(inArray(securities.id, secIds))
      : [];
    const fundRows = fundIds.length
      ? await db.select({ id: funds.id, slug: funds.slug }).from(funds).where(inArray(funds.id, fundIds))
      : [];
    const sec = new Map(secRows.map((s) => [s.id, s]));
    const fnd = new Map(fundRows.map((f) => [f.id, f.slug]));

    // Every security currently held by any fund, so an admin can book a deal
    // they know about before the scan has spotted it.
    const activeFunds = await db.select().from(funds).where(eq(funds.isActive, true));
    const heldIds = new Map<string, Set<string>>();
    for (const f of activeFunds) {
      const raw = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.fundId, f.id), isNull(transactions.voidedAt)));
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
      for (const [id, pos] of buildLedgerState(txns, new Date()).positions) {
        if (pos.quantity.isZero()) continue;
        if (!heldIds.has(id)) heldIds.set(id, new Set());
        heldIds.get(id)!.add(f.slug);
      }
    }
    const heldSecs = heldIds.size
      ? await db
          .select({ id: securities.id, ticker: securities.ticker, name: securities.name, currency: securities.currency })
          .from(securities)
          .where(inArray(securities.id, Array.from(heldIds.keys())))
      : [];

    return NextResponse.json({
      ok: true,
      held: heldSecs
        .map((h) => ({ ...h, funds: Array.from(heldIds.get(h.id) ?? []) }))
        .sort((a, b) => a.ticker.localeCompare(b.ticker)),
      events: events.map((e) => ({
        ...e,
        ticker: sec.get(e.securityId)?.ticker ?? "?",
        securityName: sec.get(e.securityId)?.name ?? null,
        currency: sec.get(e.securityId)?.currency ?? null,
        fund: e.fundId ? fnd.get(e.fundId) ?? null : null,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await admin();
  if (!user) return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action === "dismiss") {
    const eventId = String(body.eventId ?? "");
    const reason = String(body.reason ?? "").trim();
    if (!eventId) return NextResponse.json({ ok: false, error: "eventId required" }, { status: 400 });
    if (reason.length < 5) {
      return NextResponse.json({ ok: false, error: "Say briefly why no action is needed." }, { status: 400 });
    }
    const [e] = await db.select().from(corporateActionEvents).where(eq(corporateActionEvents.id, eventId)).limit(1);
    if (!e) return NextResponse.json({ ok: false, error: "Event not found" }, { status: 404 });
    await db
      .update(corporateActionEvents)
      .set({
        status: "dismissed",
        resolvedAt: new Date(),
        resolvedByUserId: user.id,
        detail: `${e.detail ?? ""}\n\nDismissed: ${reason}`.trim(),
      })
      .where(eq(corporateActionEvents.id, eventId));
    return NextResponse.json({ ok: true });
  }

  if (body.action === "book") {
    const result = await bookCorporateAction({
      kind: body.kind === "spin_off" ? "spin_off" : "merger",
      securityId: String(body.securityId ?? ""),
      effectiveDate: String(body.effectiveDate ?? ""),
      ratio: String(body.ratio ?? "0"),
      cashPerShare: body.cashPerShare != null ? String(body.cashPerShare) : undefined,
      receivedSymbol: body.receivedSymbol != null ? String(body.receivedSymbol) : undefined,
      receivedPrice: body.receivedPrice != null ? String(body.receivedPrice) : undefined,
      parentPrice: body.parentPrice != null ? String(body.parentPrice) : undefined,
      eventId: body.eventId != null ? String(body.eventId) : undefined,
      apply: body.apply === true,
      userId: user.id,
    } satisfies BookingRequest);
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }

  return NextResponse.json({ ok: false, error: "action must be book or dismiss" }, { status: 400 });
}
