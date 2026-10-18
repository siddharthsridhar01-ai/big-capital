/**
 * Basket orders.
 *
 *   POST /api/funds/<slug>/basket  { text, label?, apply? }
 *
 * Without apply: a preview. Every order is checked in sequence against the book
 * including queued orders, sales first. Nothing is written.
 *
 * With apply: the whole check is re-run, and only if EVERY order is clean — no
 * soft breach, no hard breach — are all of them queued, in one database
 * transaction. Otherwise nothing is queued. Lines that breach are traded
 * individually through the ticket, where a soft breach can be justified.
 *
 * Basket orders always queue and fill at the next opening print, sales first.
 * An order whose market is open now fills at the NEXT session's open, never at
 * one already seen — the fill worker enforces that.
 *
 * Only the fund's PM, or an admin, may submit.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "@/db/client";
import { funds, securities, investableUniverses, fundConstraints, pendingOrders, prices } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { isFundPm } from "@/lib/fund-role";
import { computePortfolioState } from "@/lib/portfolio";
import { fxRateMapForEngine } from "@/lib/fx";
import { toYahooSymbol } from "@/lib/intraday/yahoo";
import { parseBasket, simulateBasket, type BasketLine } from "@/lib/basket";
import type { FundConstraint, PortfolioContext, ProposedTrade, ConstraintType } from "@/lib/constraints";
import { daysSinceInception } from "@/lib/constraints";
import type { Currency } from "@/lib/currency";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type LineResult = {
  line: number;
  ticker: string;
  name: string | null;
  side: string;
  shares: number;
  price: string | null;
  currency: string | null;
  valueBase: string | null;
  status: "ok" | "soft" | "hard" | "error";
  messages: string[];
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await getOrCreateUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in required" }, { status: 401 });

  const [fund] = await db.select().from(funds).where(eq(funds.slug, slug)).limit(1);
  if (!fund) return NextResponse.json({ ok: false, error: "Fund not found" }, { status: 404 });
  if (!(await isFundPm(user, fund.id))) {
    return NextResponse.json({ ok: false, error: "Only the fund's Portfolio Manager can submit baskets." }, { status: 403 });
  }

  let body: { text?: string; label?: string; apply?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const parsed = parseBasket(body.text ?? "");
  if (parsed.errors.length) return NextResponse.json({ ok: false, parseErrors: parsed.errors }, { status: 400 });
  if (parsed.orders.length === 0) return NextResponse.json({ ok: false, error: "The basket is empty." }, { status: 400 });

  const base = fund.baseCurrency as Currency;

  // ----- The book the basket lands on: current holdings plus queued orders -----
  const state = await computePortfolioState(fund.id, undefined, { includePending: true });

  // ----- Resolve tickers against the universe and current holdings -----
  const universe = await db
    .select({ securityId: investableUniverses.securityId })
    .from(investableUniverses)
    .where(and(eq(investableUniverses.fundId, fund.id), isNull(investableUniverses.removedDate)));
  const candidateIds = Array.from(new Set([...universe.map((u) => u.securityId), ...state.positions.keys()]));
  const candidates = candidateIds.length
    ? await db.select().from(securities).where(inArray(securities.id, candidateIds))
    : [];
  const bySymbol = new Map<string, (typeof candidates)[number]>();
  const byTicker = new Map<string, Array<(typeof candidates)[number]>>();
  for (const s of candidates) {
    bySymbol.set(toYahooSymbol(s.ticker, s.exchange).toUpperCase(), s);
    byTicker.set(s.ticker.toUpperCase(), [...(byTicker.get(s.ticker.toUpperCase()) ?? []), s]);
  }

  const lineResults = new Map<number, LineResult>();
  const resolved: Array<{ line: BasketLine; sec: (typeof candidates)[number] }> = [];
  for (const o of parsed.orders) {
    const exact = bySymbol.get(o.ticker);
    const bare = byTicker.get(o.ticker) ?? [];
    const sec = exact ?? (bare.length === 1 ? bare[0] : undefined);
    if (!sec) {
      const message =
        bare.length > 1
          ? `Ambiguous — use ${bare.map((b) => toYahooSymbol(b.ticker, b.exchange)).join(" or ")}.`
          : "Not in this fund's universe or holdings.";
      lineResults.set(o.line, { line: o.line, ticker: o.ticker, name: null, side: o.side, shares: o.shares, price: null, currency: null, valueBase: null, status: "error", messages: [message] });
      continue;
    }
    resolved.push({ line: o, sec });
  }

  // ----- Prices: held positions from the state, basket names from stored closes -----
  const priceMap = new Map<string, Decimal>();
  for (const [id, p] of state.positions) if (p.latestPriceNative) priceMap.set(id, p.latestPriceNative);
  const needPrice = resolved.map((r) => r.sec.id).filter((id) => !priceMap.has(id));
  if (needPrice.length) {
    const floor = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const rows = await db
      .select({ securityId: prices.securityId, close: prices.closePrice, date: prices.date })
      .from(prices)
      .where(and(inArray(prices.securityId, needPrice), gte(prices.date, floor)))
      .orderBy(desc(prices.date));
    for (const r of rows) if (!priceMap.has(r.securityId)) priceMap.set(r.securityId, new Decimal(r.close));
  }

  // ----- Engine context -----
  const dateStr = new Date().toISOString().slice(0, 10);
  const securityMeta: PortfolioContext["securityMeta"] = new Map();
  const positions: PortfolioContext["positions"] = new Map();
  for (const [id, p] of state.positions) {
    securityMeta.set(id, { ticker: p.ticker, sector: p.gicsSector, currency: p.currency });
    positions.set(id, { securityId: id, quantity: p.quantity, avgCostNative: p.avgCostNative, currency: p.currency });
  }
  for (const r of resolved) {
    securityMeta.set(r.sec.id, { ticker: r.sec.ticker, sector: r.sec.gicsSector, currency: r.sec.currency as Currency });
  }
  const fxRates = await fxRateMapForEngine(
    [
      ...Array.from(state.positions.values()).map((p) => p.currency),
      ...Array.from(state.cashByCurrency.keys()),
      ...resolved.map((r) => r.sec.currency),
    ],
    base,
    dateStr
  );
  const fxOf = (ccy: string) => (ccy === base ? new Decimal(1) : new Decimal(fxRates.get(`${ccy}/${base}/${dateStr}`) ?? "1"));

  const ctx: PortfolioContext = {
    navBase: state.navBase,
    cashByCurrency: state.cashByCurrency,
    positions,
    fxRates,
    baseCurrency: base,
    date: dateStr,
    securityMeta,
    investableUniverse: new Set(universe.map((u) => u.securityId)),
    daysSinceInception: daysSinceInception(fund.inceptionDate),
  };
  const constraintRows = await db
    .select()
    .from(fundConstraints)
    .where(and(eq(fundConstraints.fundId, fund.id), eq(fundConstraints.isActive, true)));
  const constraints: FundConstraint[] = constraintRows.map((c) => ({
    id: c.id,
    constraintType: c.constraintType as ConstraintType,
    value: c.value,
    isHard: c.isHard,
  }));

  // ----- Simulate -----
  const trades: Array<{ key: number; trade: ProposedTrade }> = [];
  for (const r of resolved) {
    const px = priceMap.get(r.sec.id);
    if (!px) {
      lineResults.set(r.line.line, { line: r.line.line, ticker: r.line.ticker, name: r.sec.name, side: r.line.side, shares: r.line.shares, price: null, currency: r.sec.currency, valueBase: null, status: "error", messages: ["No recent price to check against."] });
      continue;
    }
    trades.push({
      key: r.line.line,
      trade: { securityId: r.sec.id, side: r.line.side, quantity: new Decimal(r.line.shares), price: px, currency: r.sec.currency as Currency },
    });
  }
  const sim = simulateBasket(constraints, ctx, trades, priceMap);

  for (const s of sim.results) {
    const r = resolved.find((x) => x.line.line === s.key)!;
    const valueBase = s.trade.price.times(s.trade.quantity).times(fxOf(r.sec.currency));
    const status: LineResult["status"] = s.error ? "error" : s.hard.length ? "hard" : s.soft.length ? "soft" : "ok";
    lineResults.set(s.key, {
      line: s.key,
      ticker: toYahooSymbol(r.sec.ticker, r.sec.exchange),
      name: r.sec.name,
      side: r.line.side,
      shares: r.line.shares,
      price: s.trade.price.toFixed(2),
      currency: r.sec.currency,
      valueBase: valueBase.toFixed(2),
      status,
      messages: s.error ? [s.error] : [...s.hard, ...s.soft].map((v) => v.message),
    });
  }

  const lines = Array.from(lineResults.values()).sort((a, b) => a.line - b.line);
  const clean = lines.every((l) => l.status === "ok");

  // ----- Where the book ends up -----
  let gross = new Decimal(0);
  let net = new Decimal(0);
  for (const [id, pos] of sim.end.positions) {
    const px = priceMap.get(id);
    const meta = sim.end.securityMeta.get(id);
    if (!px || !meta) continue;
    const v = pos.quantity.times(px).times(fxOf(meta.currency));
    gross = gross.plus(v.abs());
    net = net.plus(v);
  }
  let endCash = new Decimal(0);
  for (const [ccy, amt] of sim.end.cashByCurrency) endCash = endCash.plus(amt.times(fxOf(ccy)));
  const nav = state.navBase.isZero() ? new Decimal(1) : state.navBase;
  const sum = (sides: string[]) =>
    lines.filter((l) => sides.includes(l.side) && l.valueBase).reduce((acc, l) => acc.plus(l.valueBase!), new Decimal(0));

  const summary = {
    orders: lines.length,
    ok: lines.filter((l) => l.status === "ok").length,
    breaches: lines.filter((l) => l.status === "soft" || l.status === "hard").length,
    errors: lines.filter((l) => l.status === "error").length,
    buysBase: sum(["buy", "cover"]).toFixed(2),
    salesBase: sum(["sell", "short"]).toFixed(2),
    endCashBase: endCash.toFixed(2),
    endCashPct: endCash.dividedBy(nav).toFixed(4),
    endGrossPct: gross.dividedBy(nav).toFixed(4),
    endNetPct: net.dividedBy(nav).toFixed(4),
    endPositions: Array.from(sim.end.positions.values()).filter((p) => !p.quantity.isZero()).length,
    pendingOrdersIncluded: state.pendingOrdersIncluded ?? 0,
    baseCurrency: base,
  };

  if (!body.apply) return NextResponse.json({ ok: true, clean, lines, summary });

  // ----- Submit: all or nothing -----
  if (!clean) {
    return NextResponse.json(
      { ok: false, clean, lines, summary, error: "Nothing was submitted. Remove or trade the flagged lines individually, then resubmit." },
      { status: 409 }
    );
  }
  const label = (body.label ?? "").trim().slice(0, 80);
  const rationale = label ? `Basket: ${label}` : "Basket order";
  await db.transaction(async (tx) => {
    for (const s of sim.results) {
      await tx.insert(pendingOrders).values({
        fundId: fund.id,
        securityId: s.trade.securityId,
        side: s.trade.side,
        quantity: s.trade.quantity.toString(),
        submittedByUserId: user.id,
        rationale,
        thesisId: null,
        updateNote: null,
        softOverrideJustification: null,
        status: "pending",
      });
    }
  });

  return NextResponse.json({ ok: true, clean, submitted: sim.results.length, lines, summary });
}
