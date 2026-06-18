import { db } from "@/db/client";
import {
  funds as fundsTable,
  securities,
  users,
  transactions,
  positions,
} from "@/db/schema";
import { theses, thesisPostMortems } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { eq, and, asc, desc, isNotNull } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif, numeric } from "@/lib/typography";
import PostMortemForm from "@/components/PostMortemForm";

export const dynamic = "force-dynamic";

type Cur = "GBP" | "USD" | "EUR";
const sym = (c: string) => (c === "GBP" ? "£" : c === "EUR" ? "€" : "$");
function money(v: string | number | null, c: string) {
  const n = Number(v ?? 0);
  return (
    (n < 0 ? "−" : "") +
    sym(c) +
    new Intl.NumberFormat("en-GB", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Math.abs(n))
  );
}
function sharesFmt(v: string | number) {
  return new Intl.NumberFormat("en-GB").format(Math.abs(Number(v)));
}
function dateStr(d: Date | string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const PERIOD_LABELS: Record<string, string> = {
  short: "Short (< 3 months)",
  medium: "Medium (3-12 months)",
  long: "Long (1-3 years)",
  indefinite: "Indefinite",
};

const META_LABEL: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#6B6B66",
  fontWeight: 500,
  marginBottom: 3,
};
const META_VALUE: React.CSSProperties = {
  fontSize: 13,
  color: "#0A0A0A",
};
const SECTION_HEADER: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#6B6B66",
  fontWeight: 500,
  marginBottom: 10,
  fontFamily: "system-ui, sans-serif",
};

function statusStyle(status: string): { label: string; color: string } {
  switch (status) {
    case "active":
      return { label: "Active", color: "#1F5C3A" };
    case "closed":
      return { label: "Closed · awaiting review", color: "#5A3F08" };
    case "post_mortem":
      return { label: "Reviewed", color: "#00183A" };
    default:
      return { label: "Abandoned", color: "#9A9A8E" };
  }
}

export default async function ThesisDetailPage({
  params,
}: {
  params: Promise<{ slug: string; thesisId: string }>;
}) {
  const { slug, thesisId } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];
  const baseCur = fund.baseCurrency as Cur;

  const thesisRows = await db
    .select({
      id: theses.id,
      status: theses.status,
      direction: theses.direction,
      conviction: theses.conviction,
      holdingPeriod: theses.holdingPeriod,
      targetWeightPct: theses.targetWeightPct,
      targetPriceNative: theses.targetPriceNative,
      summary: theses.summary,
      openedAt: theses.openedAt,
      closedAt: theses.closedAt,
      memoBlobUrl: theses.memoBlobUrl,
      memoBlobFilename: theses.memoBlobFilename,
      securityId: theses.securityId,
      authorName: users.fullName,
      ticker: securities.ticker,
      securityName: securities.name,
      exchange: securities.exchange,
      securityCurrency: securities.currency,
    })
    .from(theses)
    .innerJoin(securities, eq(theses.securityId, securities.id))
    .innerJoin(users, eq(theses.authorUserId, users.id))
    .where(and(eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
    .limit(1);
  if (thesisRows.length === 0) notFound();
  const t = thesisRows[0];
  const secCur = t.securityCurrency as Cur;
  const st = statusStyle(t.status);

  // Linked trades, oldest first — the execution timeline for this thesis.
  const trades = await db
    .select({
      id: transactions.id,
      type: transactions.transactionType,
      quantity: transactions.quantity,
      price: transactions.price,
      currency: transactions.currency,
      cashImpact: transactions.cashImpact,
      executedAt: transactions.executedAt,
    })
    .from(transactions)
    .where(eq(transactions.thesisId, thesisId))
    .orderBy(asc(transactions.executedAt));

  // Existing post-mortem, if any.
  const pmRows = await db
    .select()
    .from(thesisPostMortems)
    .where(eq(thesisPostMortems.thesisId, thesisId))
    .limit(1);
  const pm = pmRows[0] ?? null;

  // Most recent realised P&L for this holding — context for the post-mortem
  // form (and to pre-select the outcome). Best-effort: the latest closed
  // position on this fund + security.
  let realisedPnl: number | null = null;
  if (t.status === "closed") {
    const posRows = await db
      .select({ realisedPnlBase: positions.realisedPnlBase })
      .from(positions)
      .where(
        and(
          eq(positions.fundId, fund.id),
          eq(positions.securityId, t.securityId),
          isNotNull(positions.closedAt)
        )
      )
      .orderBy(desc(positions.closedAt))
      .limit(1);
    if (posRows.length > 0 && posRows[0].realisedPnlBase != null) {
      realisedPnl = Number(posRows[0].realisedPnlBase);
    }
  }
  const defaultOutcome: "win" | "loss" | "break_even" =
    realisedPnl == null || realisedPnl === 0
      ? "break_even"
      : realisedPnl > 0
        ? "win"
        : "loss";
  const realisedPnlDisplay =
    realisedPnl == null
      ? null
      : (realisedPnl >= 0 ? "+" : "−") +
        sym(baseCur) +
        new Intl.NumberFormat("en-GB", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(Math.abs(realisedPnl));

  const memoUrl = `/api/funds/${slug}/theses/${thesisId}/memo`;

  return (
    <main style={{ padding: "28px 32px 64px", maxWidth: 880 }}>
      <div style={{ marginBottom: 6 }}>
        <Link
          href={`/dashboard/funds/${slug}/theses`}
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "#6B6B66",
            textDecoration: "none",
          }}
        >
          ← {fund.name} · theses
        </Link>
      </div>

      {/* HEADER */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          marginTop: 12,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 13,
            fontWeight: 600,
            color: "#00183A",
          }}
        >
          {t.ticker}
        </span>
        <span style={{ fontSize: 11, color: "#6B6B66" }}>{t.exchange}</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 10,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: st.color,
            fontWeight: 600,
          }}
        >
          {st.label}
        </span>
      </div>
      <h1
        style={{
          ...serif,
          fontWeight: 400,
          fontSize: 26,
          color: "#00183A",
          margin: "0 0 16px",
          letterSpacing: "-0.01em",
        }}
      >
        {t.securityName}
      </h1>

      {/* META GRID */}
      <div
        style={{
          background: "white",
          border: "1px solid #D9D9D2",
          padding: "16px 20px",
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: "16px 20px",
          fontFamily: "system-ui, sans-serif",
          marginBottom: 24,
        }}
      >
        <div>
          <div style={META_LABEL}>Conviction</div>
          <div style={{ ...META_VALUE, textTransform: "capitalize" }}>
            {t.conviction}
          </div>
        </div>
        <div>
          <div style={META_LABEL}>Holding period</div>
          <div style={META_VALUE}>
            {PERIOD_LABELS[t.holdingPeriod] ?? t.holdingPeriod}
          </div>
        </div>
        <div>
          <div style={META_LABEL}>Direction</div>
          <div style={{ ...META_VALUE, textTransform: "capitalize" }}>
            {t.direction ?? "—"}
          </div>
        </div>
        <div>
          <div style={META_LABEL}>Author</div>
          <div style={META_VALUE}>{t.authorName}</div>
        </div>
        <div>
          <div style={META_LABEL}>Target weight</div>
          <div style={{ ...META_VALUE, ...numeric }}>
            {t.targetWeightPct
              ? `${(Number(t.targetWeightPct) * 100).toFixed(2)}%`
              : "—"}
          </div>
        </div>
        <div>
          <div style={META_LABEL}>Target price</div>
          <div style={{ ...META_VALUE, ...numeric }}>
            {t.targetPriceNative
              ? money(t.targetPriceNative, secCur)
              : "—"}
          </div>
        </div>
        <div>
          <div style={META_LABEL}>Opened</div>
          <div style={{ ...META_VALUE, ...numeric }}>{dateStr(t.openedAt)}</div>
        </div>
        <div>
          <div style={META_LABEL}>Closed</div>
          <div style={{ ...META_VALUE, ...numeric }}>{dateStr(t.closedAt)}</div>
        </div>
      </div>

      {/* SUMMARY */}
      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_HEADER}>Summary</div>
        <div
          style={{
            background: "white",
            border: "1px solid #D9D9D2",
            padding: "16px 20px",
            fontSize: 14,
            color: "#0A0A0A",
            lineHeight: 1.6,
            fontFamily: "system-ui, sans-serif",
          }}
        >
          {t.summary}
        </div>
      </div>

      {/* MEMO */}
      <div style={{ marginBottom: 24 }}>
        <div
          style={{
            ...SECTION_HEADER,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <span>Investment memo</span>
          {t.memoBlobUrl ? (
            <a
              href={memoUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                textTransform: "none",
                letterSpacing: 0,
                fontSize: 11,
                color: "#00183A",
                textDecoration: "none",
                borderBottom: "1px solid #00183A",
              }}
            >
              Open in new tab ↗
            </a>
          ) : null}
        </div>
        {t.memoBlobUrl ? (
          <iframe
            src={memoUrl}
            title="Thesis memo"
            style={{
              width: "100%",
              height: 560,
              border: "1px solid #D9D9D2",
              background: "#FAFAF7",
            }}
          />
        ) : (
          <div
            style={{
              background: "white",
              border: "1px solid #D9D9D2",
              padding: "16px 20px",
              fontSize: 13,
              color: "#9A9A8E",
              fontFamily: "system-ui, sans-serif",
            }}
          >
            No memo attached to this thesis.
          </div>
        )}
      </div>

      {/* TRADE TIMELINE */}
      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_HEADER}>Trade timeline</div>
        <div
          style={{
            background: "white",
            border: "1px solid #D9D9D2",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
          }}
        >
          {trades.length === 0 ? (
            <div style={{ padding: "16px 20px", color: "#9A9A8E" }}>
              No trades linked to this thesis yet.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {[
                    ["Date", "left"],
                    ["Type", "left"],
                    ["Qty", "right"],
                    ["Price", "right"],
                    ["Notional", "right"],
                    ["Cash impact", "right"],
                  ].map(([label, align]) => (
                    <th
                      key={label}
                      style={{
                        fontSize: 10,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: "#6B6B66",
                        borderBottom: "1px solid #E5E5DE",
                        padding: "9px 14px",
                        fontWeight: 500,
                        textAlign: align as "left" | "right",
                      }}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.map((tr) => {
                  const notional = Math.abs(Number(tr.quantity)) * Number(tr.price);
                  const inflow = Number(tr.cashImpact) >= 0;
                  return (
                    <tr key={tr.id}>
                      <td style={tdStyle}>{dateStr(tr.executedAt)}</td>
                      <td style={{ ...tdStyle, fontWeight: 600, color: "#00183A" }}>
                        {tr.type.toUpperCase()}
                      </td>
                      <td style={{ ...tdStyle, ...numeric, textAlign: "right" }}>
                        {sharesFmt(tr.quantity)}
                      </td>
                      <td style={{ ...tdStyle, ...numeric, textAlign: "right" }}>
                        {money(tr.price, tr.currency)}
                      </td>
                      <td style={{ ...tdStyle, ...numeric, textAlign: "right" }}>
                        {money(notional, tr.currency)}
                      </td>
                      <td
                        style={{
                          ...tdStyle,
                          ...numeric,
                          textAlign: "right",
                          color: inflow ? "#1F5C3A" : "#7A1F1F",
                        }}
                      >
                        {inflow ? "+" : "−"}
                        {money(tr.cashImpact, tr.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* POST-MORTEM */}
      <div>
        <div style={SECTION_HEADER}>Post-mortem</div>
        {pm ? (
          <RecordedPostMortem
            outcome={pm.outcome}
            realisedReturnPct={pm.realisedReturnPct}
            whatWorked={pm.whatWorked}
            whatDidntWork={pm.whatDidntWork}
            lessonsLearned={pm.lessonsLearned}
            writtenAt={pm.writtenAt}
            attachmentFilename={pm.attachmentBlobFilename}
            attachmentUrl={`/api/funds/${slug}/theses/${thesisId}/post-mortem/attachment`}
          />
        ) : t.status === "closed" ? (
          <PostMortemForm
            fundSlug={slug}
            thesisId={thesisId}
            defaultOutcome={defaultOutcome}
            realisedPnlDisplay={realisedPnlDisplay}
          />
        ) : (
          <div
            style={{
              background: "white",
              border: "1px solid #D9D9D2",
              padding: "16px 20px",
              fontSize: 13,
              color: "#9A9A8E",
              fontFamily: "system-ui, sans-serif",
              lineHeight: 1.5,
            }}
          >
            {t.status === "active"
              ? "This thesis is live. A post-mortem can be written once the position fully closes."
              : "This thesis was abandoned without a completed position, so there's no post-mortem."}
          </div>
        )}
      </div>
    </main>
  );
}

const tdStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #F0EFEA",
  color: "#0A0A0A",
  verticalAlign: "top",
};

function RecordedPostMortem({
  outcome,
  realisedReturnPct,
  whatWorked,
  whatDidntWork,
  lessonsLearned,
  writtenAt,
  attachmentFilename,
  attachmentUrl,
}: {
  outcome: string;
  realisedReturnPct: string | null;
  whatWorked: string | null;
  whatDidntWork: string | null;
  lessonsLearned: string;
  writtenAt: Date | string;
  attachmentFilename: string | null;
  attachmentUrl: string;
}) {
  const outcomeStyle =
    outcome === "win"
      ? { label: "Win", color: "#1F5C3A" }
      : outcome === "loss"
        ? { label: "Loss", color: "#7A1F1F" }
        : { label: "Break-even", color: "#5A3F08" };
  const block = (label: string, value: string | null) =>
    value ? (
      <div style={{ marginBottom: 14 }}>
        <div style={META_LABEL}>{label}</div>
        <div
          style={{
            fontSize: 13,
            color: "#0A0A0A",
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
          }}
        >
          {value}
        </div>
      </div>
    ) : null;

  return (
    <div
      style={{
        background: "white",
        border: "1px solid #D9D9D2",
        padding: "18px 22px",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 14,
          marginBottom: 16,
          paddingBottom: 12,
          borderBottom: "1px solid #F0EFEA",
        }}
      >
        <span
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            fontWeight: 700,
            color: outcomeStyle.color,
          }}
        >
          {outcomeStyle.label}
        </span>
        {realisedReturnPct != null ? (
          <span style={{ ...numeric, fontSize: 13, color: "#00183A" }}>
            {Number(realisedReturnPct) >= 0 ? "+" : ""}
            {Number(realisedReturnPct).toFixed(2)}%
          </span>
        ) : null}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "#9A9A8E" }}>
          {dateStr(writtenAt)}
        </span>
      </div>
      {block("What worked", whatWorked)}
      {block("What didn't work", whatDidntWork)}
      {block("Lessons learned", lessonsLearned)}
      {attachmentFilename ? (
        <div style={{ marginTop: 6 }}>
          <a
            href={attachmentUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 12,
              color: "#00183A",
              textDecoration: "none",
              borderBottom: "1px solid #00183A",
            }}
          >
            📄 {attachmentFilename} ↗
          </a>
        </div>
      ) : null}
    </div>
  );
}
