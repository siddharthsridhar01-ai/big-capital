/**
 * Corporate action early warning.
 *
 * Scans every held security for signs of an event that is not processed
 * automatically, and records each finding in the corporate action feed exactly
 * once (dedupe_key is unique):
 *
 *   - SEC filings, for US-listed holdings: the official deal trail, from a 13D
 *     stake through merger registration to Form 25-NSE delisting.
 *   - Headlines, for every holding: European stocks file nothing with the SEC,
 *     so news is the best available signal for them.
 *   - Price signatures: a large unexplained move, or a holding that has stopped
 *     being priced.
 *
 * This only ever WARNS. It never books anything: a takeover, merger or spin-off
 * has terms that must be confirmed by a person. What it guarantees is that no
 * such event can happen to a held security without appearing in the feed.
 *
 * Only filings and headlines from the last LOOKBACK_DAYS are recorded, so the
 * first run does not fill the feed with years of history.
 */
import { db } from "../db/client";
import {
  funds as fundsTable,
  transactions as transactionsTable,
  securities as securitiesTable,
  prices as pricesTable,
  corporateActionEvents,
} from "../db/schema";
import { and, eq, inArray, isNull, desc, gte } from "drizzle-orm";
import Decimal from "decimal.js";
import YahooFinance from "yahoo-finance2";
import { buildLedgerState, type Transaction, type Currency } from "../lib/performance";
import { toYahooSymbol } from "../lib/intraday/yahoo";
import {
  classifyFiling,
  classifyHeadline,
  detectCorporateActions,
  type HeldPriceObservation,
  type WarningSeverity,
} from "../lib/corporate-actions";

const yf = new YahooFinance();
const LOOKBACK_DAYS = 30;
const CONCURRENCY = 8;

export interface ScanResult {
  securitiesScanned: number;
  newEvents: Array<{ kind: string; severity: WarningSeverity; ticker: string; title: string }>;
  /** Unresolved price-signature events still open — e.g. a holding still unpriced. */
  openCritical: number;
  errors: Array<{ scope: string; message: string }>;
}

/** Insert once; returns true only when this call created the event. */
async function record(e: typeof corporateActionEvents.$inferInsert): Promise<boolean> {
  const rows = await db
    .insert(corporateActionEvents)
    .values(e)
    .onConflictDoNothing({ target: corporateActionEvents.dedupeKey })
    .returning({ id: corporateActionEvents.id });
  return rows.length > 0;
}

function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** The first meaningful word of a company name, for matching headlines. */
function nameKey(name: string): string {
  return (name.split(/\s+/).find((w) => w.length > 2 && !/^(the|plc|ag|sa|nv|se|inc|ltd)$/i.test(w)) ?? name).toLowerCase();
}

export async function runCorporateActionScan(): Promise<ScanResult> {
  const result: ScanResult = { securitiesScanned: 0, newEvents: [], openCritical: 0, errors: [] };
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000);

  // ----- Held securities across all active funds -----
  const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.isActive, true));
  const held: Array<{ fund: string; fundId: string; securityId: string }> = [];
  const bookedActions = new Set<string>();
  for (const fund of fundRows) {
    const raw = await db
      .select()
      .from(transactionsTable)
      .where(and(eq(transactionsTable.fundId, fund.id), isNull(transactionsTable.voidedAt)));
    for (const t of raw) {
      if (t.transactionType === "corporate_action" && t.securityId) {
        bookedActions.add(`${t.securityId}|${t.executedAt.toISOString().slice(0, 10)}`);
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
    for (const [securityId, pos] of buildLedgerState(txns, new Date()).positions) {
      if (!pos.quantity.isZero()) held.push({ fund: fund.slug, fundId: fund.id, securityId });
    }
  }
  if (held.length === 0) return result;

  const secIds = Array.from(new Set(held.map((h) => h.securityId)));
  const secRows = await db.select().from(securitiesTable).where(inArray(securitiesTable.id, secIds));
  const secById = new Map(secRows.map((s) => [s.id, s]));
  result.securitiesScanned = secIds.length;

  // ----- Filings and headlines, per security, in parallel batches -----
  for (let i = 0; i < secIds.length; i += CONCURRENCY) {
    await Promise.all(
      secIds.slice(i, i + CONCURRENCY).map(async (secId) => {
        const sec = secById.get(secId);
        if (!sec) return;
        const sym = toYahooSymbol(sec.ticker, sec.exchange);

        // SEC filings: only US-listed securities file with the SEC.
        if (sec.currency === "USD") {
          try {
            const qs = await yf.quoteSummary(sym, { modules: ["secFilings"] });
            const filings = (qs.secFilings?.filings ?? []) as Array<{
              type: string;
              title: string;
              edgarUrl: string;
              epochDate: Date;
            }>;
            for (const f of filings) {
              const when = new Date(f.epochDate);
              if (when < since) continue;
              const meaning = classifyFiling(f.type);
              if (!meaning) continue;
              const date = when.toISOString().slice(0, 10);
              const created = await record({
                securityId: secId,
                kind: "filing",
                status: "detected",
                source: "sec_filing",
                title: `${sec.ticker}: ${f.type} filed`,
                detail: `${meaning.meaning} ${f.title ?? ""}`.trim(),
                evidenceUrl: f.edgarUrl,
                eventDate: date,
                dedupeKey: `filing|${secId}|${f.type}|${date}`,
                impact: { severity: meaning.severity },
              });
              if (created) {
                result.newEvents.push({ kind: "filing", severity: meaning.severity, ticker: sec.ticker, title: `${f.type}: ${meaning.meaning}` });
              }
            }
          } catch (err) {
            result.errors.push({ scope: `filings ${sym}`, message: err instanceof Error ? err.message : String(err) });
          }
        }

        // Headlines: every holding. Only stories plausibly ABOUT this company —
        // tagged with its symbol, or naming it — are considered.
        try {
          const s = await yf.search(sym, { newsCount: 10, quotesCount: 0 });
          const key = nameKey(sec.name ?? sec.ticker);
          for (const n of (s.news ?? []) as Array<{
            title: string;
            link?: string;
            providerPublishTime: Date;
            relatedTickers?: string[];
          }>) {
            const when = new Date(n.providerPublishTime);
            if (when < since) continue;
            const aboutIt =
              (n.relatedTickers ?? []).includes(sym) || n.title.toLowerCase().includes(key);
            if (!aboutIt) continue;
            const hit = classifyHeadline(n.title);
            if (!hit) continue;
            const created = await record({
              securityId: secId,
              kind: "news",
              status: "detected",
              source: "news",
              title: `${sec.ticker}: ${hit.label}`,
              detail: n.title,
              evidenceUrl: n.link ?? null,
              eventDate: when.toISOString().slice(0, 10),
              dedupeKey: `news|${secId}|${shortHash(n.title)}`,
              impact: { severity: hit.severity },
            });
            if (created) {
              result.newEvents.push({ kind: "news", severity: hit.severity, ticker: sec.ticker, title: n.title });
            }
          }
        } catch (err) {
          result.errors.push({ scope: `news ${sym}`, message: err instanceof Error ? err.message : String(err) });
        }
      })
    );
  }

  // ----- Price signatures -----
  const floor = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const priceRows = await db
    .select({ securityId: pricesTable.securityId, date: pricesTable.date, close: pricesTable.closePrice })
    .from(pricesTable)
    .where(and(inArray(pricesTable.securityId, secIds), gte(pricesTable.date, floor)))
    .orderBy(desc(pricesTable.date));
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
      ticker: secById.get(h.securityId)?.ticker ?? "?",
      latestDate: rows[0]?.date ?? null,
      latestClose: rows[0] ? new Decimal(rows[0].close) : null,
      previousClose: rows[1] ? new Decimal(rows[1].close) : null,
    };
  });

  for (const a of detectCorporateActions(observations, bookedActions, today)) {
    const sec = held.find((h) => h.fund === a.fund && secById.get(h.securityId)?.ticker === a.ticker);
    if (!sec) continue;
    const dateKey = a.kind === "large_move" ? a.date : a.lastPriced ?? "never";
    const created = await record({
      securityId: sec.securityId,
      fundId: sec.fundId,
      kind: a.kind,
      status: "detected",
      source: "price",
      title: `${a.ticker}: ${a.kind === "large_move" ? "large unexplained move" : "stopped being priced"}`,
      detail: a.message,
      eventDate: a.kind === "large_move" ? a.date : a.lastPriced,
      dedupeKey: `${a.kind}|${sec.fundId}|${sec.securityId}|${dateKey}`,
      impact: { severity: a.kind === "stale_price" ? "critical" : "warning" },
    });
    if (created) {
      result.newEvents.push({
        kind: a.kind,
        severity: a.kind === "stale_price" ? "critical" : "warning",
        ticker: a.ticker,
        title: a.message,
      });
    }
  }

  // A holding that is still unpriced is an ACTIVE problem — a zombie position
  // nobody has booked. It keeps alerting nightly until resolved, rather than
  // emailing once and being forgotten.
  const open = await db
    .select({ id: corporateActionEvents.id })
    .from(corporateActionEvents)
    .where(and(eq(corporateActionEvents.kind, "stale_price"), eq(corporateActionEvents.status, "detected")));
  result.openCritical = open.length;

  return result;
}
