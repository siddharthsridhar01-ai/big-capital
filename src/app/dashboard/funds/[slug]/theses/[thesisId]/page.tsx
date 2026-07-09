import { db } from "@/db/client";
import {
  funds as fundsTable,
  securities,
  users,
  transactions,
  positions,
  tradeAttachments,
} from "@/db/schema";
import { theses, thesisPostMortems, thesisUpdates } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import ThesisApprovalActions from "@/components/ThesisApprovalActions";
import { eq, and, asc, desc, isNotNull, inArray } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif, numeric } from "@/lib/typography";
import PostMortemForm from "@/components/PostMortemForm";
import ThesisUpdateForm from "@/components/ThesisUpdateForm";
import AbandonThesisButton from "@/components/AbandonThesisButton";

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

// Compact, duration-first labels for the headline Horizon tile.
const HORIZON_LABELS: Record<string, string> = {
  short: "< 3 months",
  medium: "3–12 months",
  long: "1–3 years",
  indefinite: "Indefinite",
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

// Discriminated event union for the timeline.
type TLEvent =
  | { kind: "open"; date: Date }
  | {
      kind: "trade";
      date: Date;
      txnId: string;
      type: string;
      quantity: string;
      price: string;
      currency: string;
      cashImpact: string;
      rationale: string;
      attachmentFilename: string | null;
    }
  | {
      kind: "update";
      date: Date;
      updateId: string;
      note: string;
      updateTitle: string | null;
      fromTrade: boolean;
      author: string;
      newConviction: string | null;
      newHoldingPeriod: string | null;
      newTargetWeightPct: string | null;
      newTargetPriceNative: string | null;
      attachmentFilename: string | null;
    }
  | { kind: "close"; date: Date }
  | {
      kind: "postmortem";
      date: Date;
      outcome: string;
      realisedReturnPct: string | null;
      whatWorked: string | null;
      whatDidntWork: string | null;
      lessonsLearned: string;
      attachmentFilename: string | null;
    };

const KIND_ORDER: Record<TLEvent["kind"], number> = {
  open: 0,
  trade: 1,
  update: 2,
  close: 3,
  postmortem: 4,
};

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
      approvalStatus: theses.approvalStatus,
      direction: theses.direction,
      conviction: theses.conviction,
      holdingPeriod: theses.holdingPeriod,
      targetWeightPct: theses.targetWeightPct,
      targetPriceNative: theses.targetPriceNative,
      referencePriceNative: theses.referencePriceNative,
      title: theses.title,
      summary: theses.summary,
      openedAt: theses.openedAt,
      closedAt: theses.closedAt,
      memoBlobUrl: theses.memoBlobUrl,
      securityId: theses.securityId,
      authorUserId: theses.authorUserId,
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

  const trades = await db
    .select({
      id: transactions.id,
      type: transactions.transactionType,
      quantity: transactions.quantity,
      price: transactions.price,
      currency: transactions.currency,
      cashImpact: transactions.cashImpact,
      rationale: transactions.rationale,
      executedAt: transactions.executedAt,
    })
    .from(transactions)
    .where(eq(transactions.thesisId, thesisId))
    .orderBy(asc(transactions.executedAt));

  // Per-trade PDF attachments (one shown per trade if present).
  const txnIds = trades.map((tr) => tr.id);
  const attachmentRows =
    txnIds.length > 0
      ? await db
          .select({
            transactionId: tradeAttachments.transactionId,
            filename: tradeAttachments.filename,
          })
          .from(tradeAttachments)
          .where(inArray(tradeAttachments.transactionId, txnIds))
      : [];
  const attachmentByTxn = new Map<string, string>();
  for (const a of attachmentRows) {
    if (!attachmentByTxn.has(a.transactionId)) {
      attachmentByTxn.set(a.transactionId, a.filename);
    }
  }

  const updates = await db
    .select({
      id: thesisUpdates.id,
      note: thesisUpdates.note,
      title: thesisUpdates.title,
      transactionId: thesisUpdates.transactionId,
      createdAt: thesisUpdates.createdAt,
      newConviction: thesisUpdates.newConviction,
      newHoldingPeriod: thesisUpdates.newHoldingPeriod,
      newTargetWeightPct: thesisUpdates.newTargetWeightPct,
      newTargetPriceNative: thesisUpdates.newTargetPriceNative,
      referencePriceNative: thesisUpdates.referencePriceNative,
      attachmentFilename: thesisUpdates.attachmentBlobFilename,
      author: users.fullName,
    })
    .from(thesisUpdates)
    .innerJoin(users, eq(thesisUpdates.authorUserId, users.id))
    .where(eq(thesisUpdates.thesisId, thesisId))
    .orderBy(asc(thesisUpdates.createdAt));

  const pmRows = await db
    .select()
    .from(thesisPostMortems)
    .where(eq(thesisPostMortems.thesisId, thesisId))
    .limit(1);
  const pm = pmRows[0] ?? null;

  // Realised P&L context (latest closed position for this holding).
  let realisedPnl: number | null = null;
  if (t.status === "closed" || t.status === "post_mortem") {
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

  // ---- Build the unified, chronological event list ----
  const events: TLEvent[] = [];
  // The thesis "opened" date is the earliest linked trade's execution date —
  // so attaching an earlier trade moves the opening back. Falls back to the
  // thesis creation date when no trades are linked yet.
  const effectiveOpenedAt =
    trades.length > 0 ? new Date(trades[0].executedAt) : new Date(t.openedAt);
  events.push({ kind: "open", date: effectiveOpenedAt });
  for (const tr of trades) {
    events.push({
      kind: "trade",
      date: new Date(tr.executedAt),
      txnId: tr.id,
      type: tr.type,
      quantity: tr.quantity,
      price: tr.price,
      currency: tr.currency,
      cashImpact: tr.cashImpact,
      rationale: tr.rationale,
      attachmentFilename: attachmentByTxn.get(tr.id) ?? null,
    });
  }
  for (const u of updates) {
    events.push({
      kind: "update",
      date: new Date(u.createdAt),
      updateId: u.id,
      note: u.note,
      updateTitle: u.title,
      fromTrade: u.transactionId != null,
      author: u.author,
      newConviction: u.newConviction,
      newHoldingPeriod: u.newHoldingPeriod,
      newTargetWeightPct: u.newTargetWeightPct,
      newTargetPriceNative: u.newTargetPriceNative,
      attachmentFilename: u.attachmentFilename,
    });
  }
  if (t.closedAt) events.push({ kind: "close", date: new Date(t.closedAt) });
  if (pm) {
    events.push({
      kind: "postmortem",
      date: new Date(pm.writtenAt),
      outcome: pm.outcome,
      realisedReturnPct: pm.realisedReturnPct,
      whatWorked: pm.whatWorked,
      whatDidntWork: pm.whatDidntWork,
      lessonsLearned: pm.lessonsLearned,
      attachmentFilename: pm.attachmentBlobFilename,
    });
  }
  events.sort((a, b) => {
    const d = a.date.getTime() - b.date.getTime();
    return d !== 0 ? d : KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  });

  const memoUrl = `/api/funds/${slug}/theses/${thesisId}/memo`;
  const pmAttachmentUrl = `/api/funds/${slug}/theses/${thesisId}/post-mortem/attachment`;

  // ---- Derive current headline values (latest revision, else opening) ----
  let curConviction = t.conviction as string | null;
  let curHolding = t.holdingPeriod as string | null;
  let curTW = t.targetWeightPct as string | null;
  let curTP = t.targetPriceNative as string | null;
  let curTPRef = t.referencePriceNative as string | null;
  let convRevised = false;
  let holdRevised = false;
  let twRevised = false;
  let tpRevised = false;
  for (const u of updates) {
    if (u.newConviction) {
      curConviction = u.newConviction;
      convRevised = true;
    }
    if (u.newHoldingPeriod) {
      curHolding = u.newHoldingPeriod;
      holdRevised = true;
    }
    if (u.newTargetWeightPct) {
      curTW = u.newTargetWeightPct;
      twRevised = true;
    }
    if (u.newTargetPriceNative) {
      curTP = u.newTargetPriceNative;
      curTPRef = u.referencePriceNative;
      tpRevised = true;
    }
  }

  const convRank: Record<string, number> = { low: 1, medium: 2, high: 3 };
  const arrowFor = (cur: number, base: number) =>
    cur > base ? " ↑" : cur < base ? " ↓" : "";
  const convArrow = convRevised
    ? arrowFor(convRank[curConviction ?? ""] ?? 0, convRank[t.conviction ?? ""] ?? 0)
    : "";
  const twArrow = twRevised
    ? arrowFor(Number(curTW), Number(t.targetWeightPct))
    : "";
  const tpArrow = tpRevised
    ? arrowFor(Number(curTP), Number(t.targetPriceNative))
    : "";

  // Upside = snapshot vs the price when the (current) target was set.
  // For a short thesis, profit is to the downside, so invert.
  let upsidePct: number | null = null;
  if (curTP != null && curTPRef != null && Number(curTPRef) > 0) {
    const raw = (Number(curTP) - Number(curTPRef)) / Number(curTPRef);
    upsidePct = (t.direction === "short" ? -raw : raw) * 100;
  }

  const rating =
    t.direction === "long" ? "Buy" : t.direction === "short" ? "Short" : "—";
  const ratingColor =
    t.direction === "long" ? "#1F5C3A" : t.direction === "short" ? "#7A1F1F" : "#00183A";

  const AMBER = "#8A6D1F";
  const MUTED = "#9A9A8E";
  const capFirst = (s: string | null) =>
    s ? s.charAt(0).toUpperCase() + s.slice(1) : "—";

  return (
    <main style={{ padding: "28px 32px 64px", maxWidth: 820 }}>
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
          alignItems: "flex-start",
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
        <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          <span
            style={{
              fontSize: 10,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: st.color,
              fontWeight: 600,
            }}
          >
            {st.label}
          </span>
          {(user.role === "admin" || t.authorUserId === user.id) && (
            <Link
              href={`/dashboard/funds/${slug}/theses/${thesisId}/edit`}
              style={{
                fontFamily: "system-ui, sans-serif",
                fontSize: 12,
                fontWeight: 500,
                color: "#00183A",
                background: "white",
                border: "1px solid #00183A",
                borderRadius: 4,
                padding: "6px 14px",
                textDecoration: "none",
              }}
            >
              Edit thesis
            </Link>
          )}
        </div>
      </div>
      <h1
        style={{
          ...serif,
          fontWeight: 400,
          fontSize: 26,
          color: "#00183A",
          margin: "0 0 4px",
          letterSpacing: "-0.01em",
        }}
      >
        {t.securityName}
      </h1>
      {t.title && (
        <div style={{ ...serif, fontSize: 18, color: "#3A3A34", margin: "0 0 6px", fontStyle: "italic" }}>
          {t.title}
        </div>
      )}
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 12,
          color: "#6B6B66",
          marginBottom: 16,
        }}
      >
        opened by {t.authorName} · {dateStr(effectiveOpenedAt)}
      </div>

      {t.approvalStatus === "pending" && (
        <div
          style={{
            background: "#FCFBF4",
            border: "1px solid #E7DCae",
            borderRadius: 8,
            padding: "14px 16px",
            marginBottom: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "#8A6D1F", fontWeight: 700 }}>
              Pending approval
            </div>
            <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#6B6B66", marginTop: 3 }}>
              {user.role === "admin" || user.role === "pm"
                ? "Review this thesis, then approve it so trades can be linked to it."
                : "Submitted for review — a PM must approve it before trades can be linked."}
            </div>
          </div>
          {(user.role === "admin" || user.role === "pm") && (
            <ThesisApprovalActions fundSlug={slug} thesisId={thesisId} />
          )}
        </div>
      )}
      {t.approvalStatus === "rejected" && (
        <div style={{ background: "#FBF3F3", border: "1px solid #E4C9C9", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#7A1F1F" }}>
          This thesis was not approved. Trades cannot be linked to it.
        </div>
      )}

      {/* HEADLINE STATS */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
          gap: 8,
          marginBottom: 26,
        }}
      >
        <StatTile
          label="Conviction"
          value={capFirst(curConviction)}
          sub={convRevised ? `revised${convArrow}` : "\u00A0"}
          subColor={convRevised ? AMBER : MUTED}
        />
        <StatTile
          label="Rating"
          value={rating}
          valueColor={ratingColor}
          sub={t.direction ?? "\u00A0"}
        />
        <StatTile
          label="Horizon"
          value={HORIZON_LABELS[curHolding ?? ""] ?? curHolding ?? "—"}
          sub={holdRevised ? "revised" : "\u00A0"}
          subColor={holdRevised ? AMBER : MUTED}
        />
        <StatTile
          label="Target wt."
          value={curTW != null ? `${(Number(curTW) * 100).toFixed(1)}%` : "—"}
          sub={twRevised ? `revised${twArrow}` : "of NAV"}
          subColor={twRevised ? AMBER : MUTED}
        />
        <StatTile
          label="Target px."
          value={curTP != null ? money(curTP, secCur) : "—"}
          sub={tpRevised ? `revised${tpArrow}` : "\u00A0"}
          subColor={tpRevised ? AMBER : MUTED}
        />
        <StatTile
          label="Upside"
          value={
            upsidePct != null
              ? `${upsidePct >= 0 ? "+" : ""}${upsidePct.toFixed(1)}%`
              : "—"
          }
          valueColor={
            upsidePct == null ? "#00183A" : upsidePct >= 0 ? "#1F5C3A" : "#7A1F1F"
          }
          sub={curTPRef != null ? `vs ${money(curTPRef, secCur)}` : "\u00A0"}
        />
      </div>

      {/* TIMELINE */}
      <div style={SECTION_HEADER}>Thesis timeline</div>
      <div style={{ marginBottom: 28 }}>
        {events.map((ev, i) => {
          const last = i === events.length - 1;
          if (ev.kind === "open") {
            return (
              <TimelineItem key={i} color="#00183A" title="Thesis opened" date={dateStr(ev.date)} last={last}>
                {t.title && (
                  <div style={{ ...serif, fontSize: 16, fontWeight: 700, color: "#00183A", marginBottom: 8 }}>
                    {t.title}
                  </div>
                )}
                <div style={{ fontSize: 14, color: "#0A0A0A", lineHeight: 1.6, marginBottom: 12 }}>
                  {t.summary}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: t.memoBlobUrl ? 14 : 0 }}>
                  {t.targetWeightPct ? (
                    <Chip label="Target wt." value={`${(Number(t.targetWeightPct) * 100).toFixed(2)}%`} />
                  ) : null}
                  {t.targetPriceNative ? (
                    <Chip label="Target px." value={money(t.targetPriceNative, secCur)} />
                  ) : null}
                </div>
                {t.memoBlobUrl ? (
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: "#6B6B66" }}>Investment memo</span>
                      <a href={memoUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "#00183A", textDecoration: "none", borderBottom: "1px solid #00183A" }}>
                        Open in new tab ↗
                      </a>
                    </div>
                    <iframe src={memoUrl} title="Thesis memo" style={{ width: "100%", height: 460, border: "1px solid #E5E5DE", background: "#FAFAF7" }} />
                  </div>
                ) : null}
                {(user.role === "admin" || t.authorUserId === user.id) && (
                  <div style={{ marginTop: 12, textAlign: "right" }}>
                    <Link
                      href={`/dashboard/funds/${slug}/theses/${thesisId}/edit`}
                      style={{ fontSize: 11, color: "#00183A", textDecoration: "none", borderBottom: "1px solid #D9D9D2" }}
                    >
                      Edit opening thesis
                    </Link>
                  </div>
                )}
              </TimelineItem>
            );
          }
          if (ev.kind === "trade") {
            const inflow = Number(ev.cashImpact) >= 0;
            const notional = Math.abs(Number(ev.quantity)) * Number(ev.price);
            return (
              <TimelineItem
                key={i}
                color="#3A4D6B"
                title={`${ev.type.toUpperCase()} ${sharesFmt(ev.quantity)} @ ${money(ev.price, ev.currency)}`}
                date={dateStr(ev.date)}
                last={last}
              >
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: ev.rationale ? 10 : 0 }}>
                  <Chip label="Notional" value={money(notional, ev.currency)} />
                  <Chip label="Cash" value={`${inflow ? "+" : "−"}${money(Math.abs(Number(ev.cashImpact)), ev.currency)}`} valueColor={inflow ? "#1F5C3A" : "#7A1F1F"} />
                </div>
                {ev.rationale ? (
                  <div style={{ fontSize: 13, color: "#0A0A0A", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                    {ev.rationale}
                  </div>
                ) : null}
                {ev.attachmentFilename ? (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: "#6B6B66" }}>
                        Trade attachment · {ev.attachmentFilename}
                      </span>
                      <a
                        href={`/api/funds/${slug}/transactions/${ev.txnId}/attachment`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 11, color: "#00183A", textDecoration: "none", borderBottom: "1px solid #00183A" }}
                      >
                        Open in new tab ↗
                      </a>
                    </div>
                    <iframe
                      src={`/api/funds/${slug}/transactions/${ev.txnId}/attachment`}
                      title="Trade attachment"
                      style={{ width: "100%", height: 460, border: "1px solid #E5E5DE", background: "#FAFAF7" }}
                    />
                  </div>
                ) : null}
                {(user.role === "admin" || t.authorUserId === user.id) && (
                  <div style={{ marginTop: 10, textAlign: "right" }}>
                    <Link
                      href={`/dashboard/funds/${slug}/trades/${ev.txnId}/edit`}
                      style={{ fontSize: 11, color: "#00183A", textDecoration: "none", borderBottom: "1px solid #D9D9D2" }}
                    >
                      Edit note / attachment
                    </Link>
                  </div>
                )}
              </TimelineItem>
            );
          }
          if (ev.kind === "update") {
            return (
              <TimelineItem key={i} color="#8A6D1F" title="Thesis update" date={dateStr(ev.date)} last={last}>
                {ev.updateTitle && (
                  <div style={{ ...serif, fontSize: 15, fontWeight: 700, color: "#00183A", marginBottom: 4 }}>
                    {ev.updateTitle}
                  </div>
                )}
                <div style={{ fontSize: 13, color: "#0A0A0A", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                  {ev.note}
                </div>
                {(ev.newConviction ||
                  ev.newHoldingPeriod ||
                  ev.newTargetWeightPct ||
                  ev.newTargetPriceNative) ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
                    {ev.newConviction ? (
                      <Chip label="Conviction →" value={ev.newConviction} />
                    ) : null}
                    {ev.newHoldingPeriod ? (
                      <Chip
                        label="Holding →"
                        value={PERIOD_LABELS[ev.newHoldingPeriod] ?? ev.newHoldingPeriod}
                      />
                    ) : null}
                    {ev.newTargetWeightPct ? (
                      <Chip
                        label="Target wt. →"
                        value={`${(Number(ev.newTargetWeightPct) * 100).toFixed(2)}%`}
                      />
                    ) : null}
                    {ev.newTargetPriceNative ? (
                      <Chip
                        label="Target px. →"
                        value={money(ev.newTargetPriceNative, secCur)}
                      />
                    ) : null}
                  </div>
                ) : null}
                {ev.attachmentFilename ? (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <span style={{ fontSize: 11, color: "#6B6B66" }}>
                        Attachment · {ev.attachmentFilename}
                      </span>
                      <a
                        href={`/api/funds/${slug}/theses/${thesisId}/updates/${ev.updateId}/attachment`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: 11, color: "#00183A", textDecoration: "none", borderBottom: "1px solid #00183A" }}
                      >
                        Open in new tab ↗
                      </a>
                    </div>
                    <iframe
                      src={`/api/funds/${slug}/theses/${thesisId}/updates/${ev.updateId}/attachment`}
                      title="Update attachment"
                      style={{ width: "100%", height: 460, border: "1px solid #E5E5DE", background: "#FAFAF7" }}
                    />
                  </div>
                ) : null}
                <div style={{ fontSize: 10, color: "#9A9A8E", marginTop: 8, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span>
                    {ev.author}
                    {ev.fromTrade ? " · noted alongside a trade" : ""}
                  </span>
                  {(user.role === "admin" || t.authorUserId === user.id) && (
                    <Link
                      href={`/dashboard/funds/${slug}/theses/${thesisId}/updates/${ev.updateId}/edit`}
                      style={{ fontSize: 11, color: "#00183A", textDecoration: "none", borderBottom: "1px solid #D9D9D2" }}
                    >
                      Edit
                    </Link>
                  )}
                </div>
              </TimelineItem>
            );
          }
          if (ev.kind === "close") {
            const abandoned = t.status === "abandoned";
            return (
              <TimelineItem
                key={i}
                color={abandoned ? "#9A9A8E" : "#5A3F08"}
                title={abandoned ? "Thesis abandoned" : "Position closed"}
                date={dateStr(ev.date)}
                last={last}
              >
                <div style={{ fontSize: 13, color: "#0A0A0A", lineHeight: 1.55 }}>
                  {abandoned ? (
                    "This idea was retired without a position being taken."
                  ) : (
                    <>
                      The position was fully closed.
                      {realisedPnlDisplay ? (
                        <>
                          {" "}Realised P&amp;L:{" "}
                          <span style={{ ...numeric, color: realisedPnl != null && realisedPnl < 0 ? "#7A1F1F" : "#1F5C3A" }}>
                            {realisedPnlDisplay}
                          </span>.
                        </>
                      ) : null}
                    </>
                  )}
                </div>
              </TimelineItem>
            );
          }
          // postmortem
          const oc =
            ev.outcome === "win"
              ? { label: "Win", color: "#1F5C3A" }
              : ev.outcome === "loss"
                ? { label: "Loss", color: "#7A1F1F" }
                : { label: "Break-even", color: "#5A3F08" };
          return (
            <TimelineItem key={i} color={oc.color} title={`Post-mortem · ${oc.label}`} date={dateStr(ev.date)} last={last}>
              {ev.realisedReturnPct != null ? (
                <div style={{ ...numeric, fontSize: 13, color: "#00183A", marginBottom: 10 }}>
                  Realised return: {Number(ev.realisedReturnPct) >= 0 ? "+" : ""}
                  {Number(ev.realisedReturnPct).toFixed(2)}%
                </div>
              ) : null}
              <PMBlock label="What worked" value={ev.whatWorked} />
              <PMBlock label="What didn't work" value={ev.whatDidntWork} />
              <PMBlock label="Lessons learned" value={ev.lessonsLearned} />
              {ev.attachmentFilename ? (
                <a href={pmAttachmentUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#00183A", textDecoration: "none", borderBottom: "1px solid #00183A" }}>
                  📄 {ev.attachmentFilename} ↗
                </a>
              ) : null}
            </TimelineItem>
          );
        })}
      </div>

      {/* ACTION: write post-mortem (closed) or add update (active) */}
      {t.status === "closed" && !pm ? (
        <div>
          <div style={SECTION_HEADER}>Write the post-mortem</div>
          <PostMortemForm
            fundSlug={slug}
            thesisId={thesisId}
            defaultOutcome={defaultOutcome}
            realisedPnlDisplay={realisedPnlDisplay}
          />
        </div>
      ) : t.status === "active" ? (
        <div>
          <div style={SECTION_HEADER}>Add an update</div>
          <ThesisUpdateForm fundSlug={slug} thesisId={thesisId} currency={secCur} />
          {trades.length === 0 ? (
            <div
              style={{
                marginTop: 22,
                paddingTop: 16,
                borderTop: "1px solid #E5E5DE",
              }}
            >
              <AbandonThesisButton fundSlug={slug} thesisId={thesisId} />
            </div>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

// --- presentational helpers ---

function TimelineItem({
  color,
  title,
  date,
  last,
  children,
}: {
  color: string;
  title: string;
  date: string;
  last: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "relative",
        paddingLeft: 28,
        paddingBottom: last ? 0 : 22,
        // Connecting line (omit on the last item).
        borderLeft: last ? "2px solid transparent" : "2px solid #E5E5DE",
        marginLeft: 6,
      }}
    >
      {/* Dot */}
      <span
        style={{
          position: "absolute",
          left: -7,
          top: 1,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: color,
          border: "2px solid white",
          boxShadow: `0 0 0 1.5px ${color}`,
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
            fontWeight: 600,
            color: "#00183A",
          }}
        >
          {title}
        </span>
        <span
          style={{
            ...numeric,
            fontSize: 11,
            color: "#9A9A8E",
            marginLeft: "auto",
          }}
        >
          {date}
        </span>
      </div>
      <div
        style={{
          background: "white",
          border: "1px solid #D9D9D2",
          padding: "14px 16px",
          fontFamily: "system-ui, sans-serif",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  sub,
  valueColor = "#00183A",
  subColor = "#9A9A8E",
}: {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
  subColor?: string;
}) {
  return (
    <div
      style={{
        background: "white",
        border: "1px solid #E5E5DE",
        borderRadius: 8,
        padding: "10px 11px",
        fontFamily: "system-ui, sans-serif",
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.03em",
          textTransform: "uppercase",
          color: "#6B6B66",
          marginBottom: 5,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          color: valueColor,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: subColor, marginTop: 3, whiteSpace: "nowrap" }}>
        {sub ?? "\u00A0"}
      </div>
    </div>
  );
}

function Chip({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 6,
        background: "#FAFAF7",
        border: "1px solid #E5E5DE",
        padding: "4px 10px",
        fontSize: 11,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <span style={{ color: "#6B6B66", textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 10 }}>
        {label}
      </span>
      <span style={{ ...numeric, color: valueColor ?? "#00183A", fontWeight: 600 }}>{value}</span>
    </span>
  );
}

function PMBlock({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "#6B6B66",
          fontWeight: 500,
          marginBottom: 3,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, color: "#0A0A0A", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
        {value}
      </div>
    </div>
  );
}
