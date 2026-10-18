import { db } from "@/db/client";
import {
  transactions,
  funds as fundsTable,
  securities,
  users,
  tradeAttachments,
  pendingOrders,
  prices,
} from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { and, desc, eq, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import Decimal from "decimal.js";
import { serif, numeric } from "@/lib/typography";
import { currencySymbol, type Currency } from "@/lib/currency";
import { currentFxToBase } from "@/lib/fx";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
/** Rejected and cancelled orders stay listed this long, so a refusal at the open is seen. */
const RESOLVED_ORDER_DAYS = 7;

const TYPE_LABEL: Record<string, string> = {
  buy: "Buy",
  sell: "Sell",
  short: "Short",
  cover: "Cover",
  dividend: "Dividend",
  corporate_action: "Corp. action",
  cash_deposit: "Deposit",
  fx_adjustment: "FX",
};

const C = {
  ink: "#00183A",
  muted: "#6B6B66",
  faint: "#9A9A8E",
  line: "#E5E5DE",
  row: "#F0EFEA",
  green: "#1F5C3A",
  red: "#7A1F1F",
  amber: "#8A6D1F",
};

/** Whole numbers as integers; fractions (cash in lieu) to four places, trimmed. */
function fmtQty(q: number): string {
  const a = Math.abs(q);
  if (a === 0) return "—";
  return Number.isInteger(a) ? a.toLocaleString("en-GB") : a.toLocaleString("en-GB", { maximumFractionDigits: 4 });
}

function fmtWhen(d: Date): string {
  return new Date(d).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function money(v: number, sym: string, signed = false): string {
  const body = `${sym}${Math.abs(v).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;
  if (!signed) return body;
  return `${v >= 0 ? "+" : "−"}${body}`;
}

function sideColour(t: string): string {
  if (t === "buy" || t === "cover") return C.green;
  if (t === "sell" || t === "short") return C.red;
  return C.muted;
}

export default async function AdminTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ fund?: string; page?: string }>;
}) {
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");
  if (user.role !== "admin") {
    return (
      <main style={{ padding: "28px 32px" }}>
        <div style={{ background: "#FAEAEA", border: "1px solid #E0B8B8", color: C.red, padding: "16px 20px", fontFamily: "system-ui, sans-serif", fontSize: 13 }}>
          Admin role required.
        </div>
      </main>
    );
  }

  const sp = await searchParams;
  const allFunds = await db
    .select({ id: fundsTable.id, slug: fundsTable.slug, baseCurrency: fundsTable.baseCurrency })
    .from(fundsTable)
    .where(eq(fundsTable.isActive, true))
    .orderBy(fundsTable.slug);
  const selected = allFunds.find((f) => f.slug === sp.fund) ?? null;
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  // ------------------------------------------------------------------ orders
  const orderSince = new Date(Date.now() - RESOLVED_ORDER_DAYS * 86400000);
  // Built from operators, not a raw SQL fragment: interpolating a Date into raw
  // SQL hands the driver a JavaScript object it cannot serialise, and the page
  // threw. gte() converts the date through the column's own type.
  const orderWhere: SQL[] = [
    or(
      eq(pendingOrders.status, "pending"),
      and(
        inArray(pendingOrders.status, ["rejected", "cancelled", "expired"]),
        gte(pendingOrders.resolvedAt, orderSince)
      )
    )!,
  ];
  if (selected) orderWhere.push(eq(pendingOrders.fundId, selected.id));

  const orderRows = await db
    .select({ order: pendingOrders, fund: fundsTable, security: securities, by: users })
    .from(pendingOrders)
    .leftJoin(fundsTable, eq(pendingOrders.fundId, fundsTable.id))
    .leftJoin(securities, eq(pendingOrders.securityId, securities.id))
    .leftJoin(users, eq(pendingOrders.submittedByUserId, users.id))
    .where(and(...orderWhere))
    .orderBy(desc(pendingOrders.submittedAt));

  // Latest close for queued securities, for an estimated value. Bounded to 30
  // days: an unbounded price read caused the Supabase egress overage.
  const pendingSecIds = Array.from(
    new Set(orderRows.filter((r) => r.order.status === "pending" && r.order.securityId).map((r) => r.order.securityId as string))
  );
  const lastClose = new Map<string, number>();
  if (pendingSecIds.length > 0) {
    const floor = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const px = await db
      .select({ securityId: prices.securityId, close: prices.closePrice, date: prices.date })
      .from(prices)
      .where(and(inArray(prices.securityId, pendingSecIds), gte(prices.date, floor)))
      .orderBy(desc(prices.date));
    for (const p of px) if (!lastClose.has(p.securityId)) lastClose.set(p.securityId, Number(p.close));
  }
  // Current rates per fund base, for the estimate in each fund's own currency.
  const fxByBase = new Map<string, Map<string, Decimal>>();
  for (const base of new Set(orderRows.map((r) => r.fund?.baseCurrency).filter(Boolean) as string[])) {
    const ccys = orderRows.filter((r) => r.fund?.baseCurrency === base).map((r) => r.security?.currency ?? base);
    fxByBase.set(base, await currentFxToBase(ccys, base as Currency));
  }
  const queuedCount = orderRows.filter((r) => r.order.status === "pending").length;

  // ------------------------------------------------------------ transactions
  const txnWhere = selected ? eq(transactions.fundId, selected.id) : undefined;
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(transactions)
    .where(txnWhere);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pages);

  const rows = await db
    .select({ txn: transactions, fund: fundsTable, security: securities, executedBy: users })
    .from(transactions)
    .leftJoin(fundsTable, eq(transactions.fundId, fundsTable.id))
    .leftJoin(securities, eq(transactions.securityId, securities.id))
    .leftJoin(users, eq(transactions.executedByUserId, users.id))
    .where(txnWhere)
    .orderBy(desc(transactions.executedAt))
    .limit(PAGE_SIZE)
    .offset((current - 1) * PAGE_SIZE);

  // Attachments for THIS page only — this read the entire table on every view.
  const ids = rows.map((r) => r.txn.id);
  const attached = new Set(
    ids.length
      ? (await db.select({ id: tradeAttachments.transactionId }).from(tradeAttachments).where(inArray(tradeAttachments.transactionId, ids))).map((a) => a.id)
      : []
  );

  const href = (p: { fund?: string | null; page?: number }) => {
    const q = new URLSearchParams();
    const f = p.fund === undefined ? selected?.slug : p.fund;
    if (f) q.set("fund", f);
    if (p.page && p.page > 1) q.set("page", String(p.page));
    const s = q.toString();
    return `/dashboard/admin/transactions${s ? `?${s}` : ""}`;
  };

  const TH = (label: string, right = false) => (
    <th
      key={label}
      style={{
        fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: C.muted,
        borderBottom: `1px solid ${C.line}`, padding: "10px 12px", fontWeight: 500,
        textAlign: right ? "right" : "left", whiteSpace: "nowrap",
      }}
    >
      {label}
    </th>
  );
  const TD: React.CSSProperties = { padding: "9px 12px", borderBottom: `1px solid ${C.row}` };
  const BOX: React.CSSProperties = { background: "white", border: "1px solid #D9D9D2", fontFamily: "system-ui, sans-serif", fontSize: 12, overflowX: "auto" };
  const H2: React.CSSProperties = { ...serif, fontWeight: 400, fontSize: 19, color: C.ink, margin: "0 0 4px" };
  const SUB: React.CSSProperties = { fontFamily: "system-ui, sans-serif", fontSize: 11.5, color: C.muted, marginBottom: 10 };

  return (
    <main style={{ padding: "28px 32px 64px" }}>
      <Link href="/dashboard" style={{ fontFamily: "system-ui, sans-serif", fontSize: 12, color: C.muted, textDecoration: "none" }}>
        ← Dashboard
      </Link>

      <div style={{ marginTop: 16, marginBottom: 18 }}>
        <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: C.muted, fontWeight: 500, marginBottom: 6 }}>
          Admin · Transactions
        </div>
        <h1 style={{ ...serif, fontWeight: 400, fontSize: 30, color: C.ink, margin: 0 }}>Transactions</h1>
      </div>

      {/* Fund filter */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 24, fontFamily: "system-ui, sans-serif" }}>
        {[{ slug: null as string | null, label: "All funds" }, ...allFunds.map((f) => ({ slug: f.slug, label: f.slug }))].map((f) => {
          const on = (f.slug ?? null) === (selected?.slug ?? null);
          return (
            <Link
              key={f.label}
              href={href({ fund: f.slug, page: 1 })}
              style={{
                fontSize: 11.5, padding: "5px 11px", textDecoration: "none",
                border: `1px solid ${on ? C.ink : C.line}`, background: on ? C.ink : "white", color: on ? "white" : C.muted,
              }}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      {/* ------------------------------------------------------------ orders */}
      <h2 style={H2}>Orders</h2>
      <div style={SUB}>
        {queuedCount} queued · rejected and cancelled orders shown for {RESOLVED_ORDER_DAYS} days. Values estimated at last price.
      </div>
      {orderRows.length === 0 ? (
        <div style={{ ...BOX, padding: "18px 20px", color: C.muted }}>No queued orders.</div>
      ) : (
        <div style={BOX}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {TH("Submitted")}{TH("Fund")}{TH("Side")}{TH("Ticker")}{TH("Qty", true)}{TH("Est. price", true)}{TH("Est. value", true)}{TH("Status")}{TH("By")}
              </tr>
            </thead>
            <tbody>
              {orderRows.map(({ order, fund, security, by }) => {
                const base = fund?.baseCurrency ?? "GBP";
                const ccy = security?.currency ?? base;
                const qty = Number(order.quantity);
                const pending = order.status === "pending";
                const px = pending ? lastClose.get(order.securityId as string) : order.fillPrice ? Number(order.fillPrice) : undefined;
                const fx = fxByBase.get(base)?.get(ccy)?.toNumber() ?? (ccy === base ? 1 : undefined);
                const value = px != null && fx != null ? qty * px * fx : undefined;
                const statusColour = pending ? C.amber : order.status === "rejected" ? C.red : C.faint;
                const statusLabel = pending ? "Queued" : order.status.charAt(0).toUpperCase() + order.status.slice(1);
                return (
                  <tr key={order.id} style={{ opacity: pending ? 1 : 0.75 }}>
                    <td style={{ ...TD, color: C.muted, fontSize: 11, whiteSpace: "nowrap" }}>{fmtWhen(order.submittedAt)}</td>
                    <td style={{ ...TD, color: C.ink }}>{fund?.slug ?? "—"}</td>
                    <td style={{ ...TD, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 600, color: sideColour(order.side) }}>
                      {TYPE_LABEL[order.side] ?? order.side}
                    </td>
                    <td style={{ ...TD, fontFamily: "ui-monospace, monospace", color: C.ink }}>{security?.ticker ?? "—"}</td>
                    <td style={{ ...TD, textAlign: "right", ...numeric }}>{fmtQty(qty)}</td>
                    <td style={{ ...TD, textAlign: "right", ...numeric, color: C.muted }}>
                      {px != null ? `${currencySymbol(ccy)}${px.toFixed(2)}` : "—"}
                    </td>
                    <td style={{ ...TD, textAlign: "right", ...numeric }}>{value != null ? money(value, currencySymbol(base)) : "—"}</td>
                    <td style={{ ...TD, color: statusColour, fontSize: 11 }} title={order.rejectionReason ?? undefined}>
                      {statusLabel}
                      {order.status === "rejected" && order.rejectionReason ? (
                        <div style={{ fontSize: 10.5, color: C.muted, marginTop: 2, maxWidth: 260, whiteSpace: "normal" }}>{order.rejectionReason}</div>
                      ) : null}
                    </td>
                    <td style={{ ...TD, color: C.muted, fontSize: 11 }}>{by?.fullName ?? by?.email ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ------------------------------------------------------ transactions */}
      <div style={{ marginTop: 34 }}>
        <h2 style={H2}>Transactions</h2>
        <div style={SUB}>
          {total === 0
            ? "None."
            : `${((current - 1) * PAGE_SIZE + 1).toLocaleString("en-GB")}–${Math.min(current * PAGE_SIZE, total).toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")}`}
        </div>
      </div>

      {rows.length > 0 ? (
        <div style={BOX}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {TH("Date")}{TH("Fund")}{TH("Type")}{TH("Ticker")}{TH("Qty", true)}{TH("Price", true)}{TH("Cash impact", true)}{TH("Memo")}{TH("By")}{TH("")}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ txn, fund, security, executedBy }) => {
                const voided = Boolean(txn.voidedAt);
                const cashBase = Number(txn.cashImpact) * Number(txn.fxRateToBase);
                const strike: React.CSSProperties = voided ? { textDecoration: "line-through", color: C.faint } : {};
                return (
                  <tr key={txn.id}>
                    <td style={{ ...TD, color: C.muted, fontSize: 11, whiteSpace: "nowrap" }}>{fmtWhen(txn.executedAt)}</td>
                    <td style={{ ...TD, color: C.ink }}>
                      {fund ? <Link href={`/dashboard/funds/${fund.slug}`} style={{ color: C.ink, textDecoration: "none" }}>{fund.slug}</Link> : "—"}
                    </td>
                    <td style={{ ...TD, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 600, color: voided ? C.faint : sideColour(txn.transactionType), whiteSpace: "nowrap" }}>
                      {TYPE_LABEL[txn.transactionType] ?? txn.transactionType}
                      {voided ? <span style={{ color: C.red, marginLeft: 6 }}>Voided</span> : null}
                    </td>
                    <td style={{ ...TD, fontFamily: "ui-monospace, monospace", color: C.ink, ...strike }}>{security?.ticker ?? "—"}</td>
                    <td style={{ ...TD, textAlign: "right", ...numeric, ...strike }}>{fmtQty(Number(txn.quantity))}</td>
                    <td style={{ ...TD, textAlign: "right", ...numeric, color: C.muted, ...strike }}>
                      {Number(txn.price) ? `${currencySymbol(txn.currency)}${Number(txn.price).toFixed(2)}` : "—"}
                    </td>
                    <td style={{ ...TD, textAlign: "right", ...numeric, color: voided ? C.faint : cashBase >= 0 ? C.green : C.red, ...strike }}>
                      {cashBase === 0 ? "—" : money(cashBase, currencySymbol(fund?.baseCurrency), true)}
                    </td>
                    <td style={{ ...TD, color: C.muted }}>{attached.has(txn.id) ? "📄" : ""}</td>
                    <td style={{ ...TD, color: C.muted, fontSize: 11 }}>{executedBy?.fullName ?? executedBy?.email ?? "—"}</td>
                    <td style={TD}>
                      <Link href={`/dashboard/admin/transactions/${txn.id}`} style={{ color: C.ink, textDecoration: "none", fontSize: 11, whiteSpace: "nowrap" }}>
                        Details →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {pages > 1 ? (
        <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 14, fontFamily: "system-ui, sans-serif", fontSize: 12 }}>
          {current > 1 ? <Link href={href({ page: current - 1 })} style={{ color: C.ink, textDecoration: "none" }}>← Newer</Link> : <span style={{ color: C.faint }}>← Newer</span>}
          <span style={{ color: C.muted }}>Page {current} of {pages}</span>
          {current < pages ? <Link href={href({ page: current + 1 })} style={{ color: C.ink, textDecoration: "none" }}>Older →</Link> : <span style={{ color: C.faint }}>Older →</span>}
        </div>
      ) : null}
    </main>
  );
}
