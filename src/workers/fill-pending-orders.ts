/**
 * Market-on-open fill worker.
 *
 * Orders submitted while a security's market is shut are queued as
 * `pending_orders` and executed here at that market's next OPENING PRINT — the
 * exchange's official open for the session, not a sampled quote. This mirrors a
 * real market-on-open (MOO) order and keeps the model gaming-proof: the person
 * placing the order cannot know their fill price when they submit, because the
 * open hasn't happened yet.
 *
 * Safety rules that make this defensible:
 *  - Only fills while the security's market is in its REGULAR session, so we
 *    know the session has genuinely opened (timezone-correct per exchange,
 *    since the state comes from the security's own market).
 *  - The opening bar used MUST be today's session. If the price feed is lagging
 *    and still returns a previous session's bar, we skip and retry rather than
 *    fill at an open the submitter has already seen — that would be look-ahead.
 *  - The open is sanity-checked against the last stored close (catches a
 *    pence/wrong-symbol/garbage feed value before it reaches the immutable ledger).
 *  - Constraints are re-checked at fill time inside executeTrade: cash and limits
 *    move overnight, so an order that no longer fits is rejected with a reason
 *    rather than forced through.
 *  - Orders that miss their auction (job outage, prolonged closure) EXPIRE
 *    instead of filling at a much later, unintended open.
 */
import { db } from "@/db/client";
import {
  pendingOrders,
  funds as fundsTable,
  securities as securitiesTable,
  prices as pricesTable,
} from "@/db/schema";
import { theses as thesesTable } from "@/db/schema-theses";
import { and, desc, eq } from "drizzle-orm";
import Decimal from "decimal.js";
import YahooFinance from "yahoo-finance2";
import { toYahooSymbol } from "@/lib/intraday/yahoo";
import { getQuotes } from "@/lib/intraday/cache";
import { activeProvider } from "@/lib/intraday/provider";
import { resolveFxToBase } from "@/lib/fx";
import { checkPriceSanity } from "@/lib/price-guardrail";
import { executeTrade } from "@/lib/execute-trade";
import type { Currency } from "@/lib/portfolio";

const yf = new YahooFinance();

/** Orders older than this that still haven't filled are expired, not filled. */
const MAX_AGE_DAYS = 4;

export interface FillPendingResult {
  examined: number;
  filled: number;
  rejected: number;
  expired: number;
  waiting: number;
  errors: number;
  detail: Array<{
    orderId: string;
    ticker: string;
    outcome: string;
    fillPrice?: string;
    reason?: string;
  }>;
}

export async function fillPendingOrders(): Promise<FillPendingResult> {
  const result: FillPendingResult = {
    examined: 0,
    filled: 0,
    rejected: 0,
    expired: 0,
    waiting: 0,
    errors: 0,
    detail: [],
  };

  const orders = await db
    .select()
    .from(pendingOrders)
    .where(eq(pendingOrders.status, "pending"))
    .orderBy(pendingOrders.submittedAt);

  result.examined = orders.length;
  if (orders.length === 0) return result;

  const todayUtc = new Date().toISOString().slice(0, 10);

  for (const order of orders) {
    let ticker = "?";
    try {
      const secRows = await db
        .select()
        .from(securitiesTable)
        .where(eq(securitiesTable.id, order.securityId))
        .limit(1);
      const fundRows = await db
        .select()
        .from(fundsTable)
        .where(eq(fundsTable.id, order.fundId))
        .limit(1);
      if (secRows.length === 0 || fundRows.length === 0) {
        await resolve(order.id, "rejected", { reason: "Fund or security no longer exists" });
        result.rejected += 1;
        result.detail.push({ orderId: order.id, ticker, outcome: "rejected", reason: "missing fund/security" });
        continue;
      }
      const security = secRows[0];
      const fund = fundRows[0];
      ticker = security.ticker;

      // ---- Expire orders that missed their opening auction ----
      const ageDays =
        (Date.now() - new Date(order.submittedAt).getTime()) / 86400_000;
      if (ageDays > MAX_AGE_DAYS) {
        await resolve(order.id, "expired", {
          reason: `Not filled within ${MAX_AGE_DAYS} days of submission — expired rather than filled at a much later open. Please resubmit if still wanted.`,
        });
        result.expired += 1;
        result.detail.push({ orderId: order.id, ticker, outcome: "expired" });
        continue;
      }

      const sym = toYahooSymbol(security.ticker, security.exchange);

      // ---- Has this security's market actually opened? ----
      const quotes = await getQuotes(activeProvider, [
        { securityId: security.id, symbol: sym },
      ]);
      const state = quotes[0]?.quote?.marketState ?? "UNKNOWN";
      if (state !== "REGULAR") {
        result.waiting += 1;
        result.detail.push({ orderId: order.id, ticker, outcome: "waiting", reason: `market ${state}` });
        continue;
      }

      // ---- Official opening print for TODAY's session ----
      const chart = await yf.chart(sym, {
        period1: new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10),
        interval: "1d",
      });
      const bars = (chart.quotes ?? []).filter(
        (b) => b.date && b.open != null && Number.isFinite(b.open)
      );
      const latest = bars[bars.length - 1];
      const latestDate = latest?.date
        ? new Date(latest.date).toISOString().slice(0, 10)
        : null;

      // The bar MUST be today's session. A lagging feed returning a previous
      // session's bar would otherwise fill at an open the submitter has already
      // seen — look-ahead. Skip and retry on the next run instead.
      if (!latest || latestDate !== todayUtc) {
        result.waiting += 1;
        result.detail.push({
          orderId: order.id,
          ticker,
          outcome: "waiting",
          reason: `opening print not published yet (latest bar ${latestDate ?? "none"})`,
        });
        continue;
      }

      const meta = (chart.meta?.currency as string | undefined) ?? "";
      const isPence = meta === "GBp" || meta === "GBX";
      const openNative = new Decimal(
        isPence ? (latest.open as number) / 100 : (latest.open as number)
      );

      // ---- Price sanity vs last stored close (protects the immutable ledger) ----
      const refRows = await db
        .select({ close: pricesTable.closePrice })
        .from(pricesTable)
        .where(eq(pricesTable.securityId, security.id))
        .orderBy(desc(pricesTable.date))
        .limit(1);
      const sanity = checkPriceSanity(
        openNative,
        refRows.length > 0 ? new Decimal(refRows[0].close) : null
      );
      if (!sanity.ok) {
        await resolve(order.id, "rejected", {
          reason: `Opening price ${openNative.toFixed(4)} ${security.currency} failed the price safety check (${sanity.reason ?? "implausible vs last close"}). Order not filled.`,
        });
        result.rejected += 1;
        result.detail.push({ orderId: order.id, ticker, outcome: "rejected", reason: "price sanity" });
        continue;
      }

      // ---- FX + linked thesis ----
      const fxToBase =
        security.currency === fund.baseCurrency
          ? new Decimal(1)
          : await resolveFxToBase(
              security.currency as Currency,
              fund.baseCurrency as Currency,
              todayUtc
            );

      let linkedThesis: { id: string; direction: string | null; status: string } | null =
        null;
      if (order.thesisId) {
        const tRows = await db
          .select()
          .from(thesesTable)
          .where(eq(thesesTable.id, order.thesisId))
          .limit(1);
        if (tRows.length > 0) {
          linkedThesis = {
            id: tRows[0].id,
            direction: tRows[0].direction,
            status: tRows[0].status,
          };
        }
      }

      // ---- Execute through the shared, lock-protected path ----
      const exec = await executeTrade({
        fund: {
          id: fund.id,
          baseCurrency: fund.baseCurrency,
          tradingFeesBps: fund.tradingFeesBps,
        },
        security: {
          id: security.id,
          ticker: security.ticker,
          currency: security.currency,
          gicsSector: security.gicsSector,
        },
        side: order.side as "buy" | "sell" | "short" | "cover",
        shares: Number(order.quantity),
        priceNative: openNative,
        fxToBase,
        userId: order.submittedByUserId,
        executedAt: new Date(),
        rationale: order.rationale,
        priceProviderLabel: `Opening print ${todayUtc}`,
        linkedThesis,
        updateNote: order.updateNote,
        softOverrideJustification: order.softOverrideJustification,
        memo: null,
      });

      if (!exec.ok) {
        const reason =
          typeof exec.payload.error === "string"
            ? exec.payload.error
            : "Rejected at fill time";
        await resolve(order.id, "rejected", { reason });
        result.rejected += 1;
        result.detail.push({ orderId: order.id, ticker, outcome: "rejected", reason });
        continue;
      }

      await resolve(order.id, "filled", {
        transactionId: exec.transactionId,
        fillPrice: openNative.toString(),
      });
      result.filled += 1;
      result.detail.push({
        orderId: order.id,
        ticker,
        outcome: "filled",
        fillPrice: openNative.toString(),
      });
    } catch (err) {
      result.errors += 1;
      result.detail.push({
        orderId: order.id,
        ticker,
        outcome: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
      console.error("[fill-pending-orders] order failed:", order.id, err);
    }
  }

  return result;
}

async function resolve(
  orderId: string,
  status: "filled" | "rejected" | "expired",
  opts: { reason?: string; transactionId?: string; fillPrice?: string }
) {
  await db
    .update(pendingOrders)
    .set({
      status,
      rejectionReason: opts.reason ?? null,
      filledTransactionId: opts.transactionId ?? null,
      fillPrice: opts.fillPrice ?? null,
      resolvedAt: new Date(),
    })
    .where(and(eq(pendingOrders.id, orderId), eq(pendingOrders.status, "pending")));
}
