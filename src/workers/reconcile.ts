/**
 * Worker: daily reconciliation. Reads the computed NAV snapshots + recent
 * prices and runs the sanity checks in src/lib/reconciliation.ts, returning any
 * anomalies. Read-only — it never writes fund data; the caller records a
 * job_runs row so anomalies show on the admin health page.
 */
import { db } from "../db/client";
import { funds as fundsTable, navSnapshots, prices, securities, transactions } from "../db/schema";
import { and, eq, desc, isNotNull, inArray, gte } from "drizzle-orm";
import Decimal from "decimal.js";
import { reconcileSnapshot, reconcilePriceJumps, type Anomaly, type PricePair } from "../lib/reconciliation";

export interface ReconciliationResult {
  fundsChecked: number;
  securitiesChecked: number;
  anomalies: Anomaly[];
  fails: number;
  warns: number;
}

export async function runReconciliation(): Promise<ReconciliationResult> {
  const anomalies: Anomaly[] = [];

  // Per-fund snapshot checks (latest two snapshots).
  const fundRows = await db
    .select({ id: fundsTable.id, slug: fundsTable.slug, startingNav: fundsTable.startingNav })
    .from(fundsTable)
    .where(eq(fundsTable.isActive, true));

  for (const f of fundRows) {
    const snaps = await db
      .select({ nav: navSnapshots.nav, cashBalance: navSnapshots.cashBalance, positionValue: navSnapshots.positionValue })
      .from(navSnapshots)
      .where(eq(navSnapshots.fundId, f.id))
      .orderBy(desc(navSnapshots.date))
      .limit(2);
    if (snaps.length === 0) continue;
    anomalies.push(
      ...reconcileSnapshot({
        fundSlug: f.slug,
        startingNav: new Decimal(f.startingNav),
        nav: new Decimal(snaps[0].nav),
        cashBalance: new Decimal(snaps[0].cashBalance),
        positionValue: new Decimal(snaps[0].positionValue),
        previousNav: snaps[1] ? new Decimal(snaps[1].nav) : null,
      })
    );
  }

  // Price-jump checks across held securities (latest two price rows each).
  const tradedRows = await db
    .selectDistinct({ securityId: transactions.securityId })
    .from(transactions)
    .where(isNotNull(transactions.securityId));
  const heldIds = tradedRows.map((r) => r.securityId as string);

  let securitiesChecked = 0;
  if (heldIds.length > 0) {
    const secRows = await db
      .select({ id: securities.id, ticker: securities.ticker, exchange: securities.exchange })
      .from(securities)
      .where(inArray(securities.id, heldIds));

    // Batched: one query for recent prices across all held securities, then take
    // the latest two per security in memory (prices are daily, so a 45-day
    // window comfortably contains today + previous close). Same comparison as
    // before — just without a query per security.
    const cutoff = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
    const priceRows = await db
      .select({ securityId: prices.securityId, close: prices.closePrice, date: prices.date })
      .from(prices)
      .where(and(inArray(prices.securityId, heldIds), gte(prices.date, cutoff)))
      .orderBy(desc(prices.date));

    const latestTwo = new Map<string, Array<{ close: string; date: string }>>();
    for (const r of priceRows) {
      const arr = latestTwo.get(r.securityId) ?? [];
      if (arr.length < 2) arr.push({ close: r.close, date: r.date });
      latestTwo.set(r.securityId, arr);
    }

    const pairs: PricePair[] = [];
    for (const s of secRows) {
      const p = latestTwo.get(s.id);
      if (p && p.length === 2) {
        securitiesChecked += 1;
        pairs.push({ ticker: s.ticker, exchange: s.exchange, today: new Decimal(p[0].close), prev: new Decimal(p[1].close) });
      }
    }
    anomalies.push(...reconcilePriceJumps(pairs));
  }

  return {
    fundsChecked: fundRows.length,
    securitiesChecked,
    anomalies,
    fails: anomalies.filter((a) => a.severity === "fail").length,
    warns: anomalies.filter((a) => a.severity === "warn").length,
  };
}
