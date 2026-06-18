import { db } from "@/db/client";
import {
  funds as fundsTable,
  securities,
  users,
  transactions,
  positions,
} from "@/db/schema";
import { theses, thesisPostMortems, thesisUpdates } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { eq, and, asc, desc, isNotNull } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif, numeric } from "@/lib/typography";
import PostMortemForm from "@/components/PostMortemForm";
import ThesisUpdateForm from "@/components/ThesisUpdateForm";

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
      type: string;
      quantity: string;
      price: string;
      currency: string;
      cashImpact: string;
      rationale: string;
    }
  | { kind: "update"; date: Date; note: string; fromTrade: boolean; author: string }
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
      direction: theses.direction,
      conviction: theses.conviction,
      holdingPeriod: theses.holdingPeriod,
      targetWeightPct: theses.targetWeightPct,
      targetPriceNative: theses.targetPriceNative,
      summary: theses.summary,
      openedAt: theses.openedAt,
      closedAt: theses.closedAt,
      memoBlobUrl: theses.memoBlobUrl,
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

  const updates = await db
    .select({
      id: thesisUpdates.id,
      note: thesisUpdates.note,
      transactionId: thesisUpdates.transactionId,
      createdAt: thesisUpdates.createdAt,
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
  events.push({ kind: "open", date: new Date(t.openedAt) });
  for (const tr of trades) {
    events.push({
      kind: "trade",
      date: new Date(tr.executedAt),
      type: tr.type,
      quantity: tr.quantity,
      price: tr.price,
      currency: tr.currency,
      cashImpact: tr.cashImpact,
      rationale: tr.rationale,
    });
  }
  for (const u of updates) {
    events.push({
      kind: "update",
      date: new Date(u.createdAt),
      note: u.note,
      fromTrade: u.transactionId != null,
      author: u.author,
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
          margin: "0 0 4px",
          letterSpacing: "-0.01em",
        }}
      >
        {t.securityName}
      </h1>
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 12,
          color: "#6B6B66",
          marginBottom: 24,
        }}
      >
        {t.direction ? `${t.direction} · ` : ""}
        {t.conviction} conviction · {PERIOD_LABELS[t.holdingPeriod] ?? t.holdingPeriod} ·
        opened by {t.authorName}
      </div>

      {/* TIMELINE */}
      <div style={SECTION_HEADER}>Thesis timeline</div>
      <div style={{ marginBottom: 28 }}>
        {events.map((ev, i) => {
          const last = i === events.length - 1;
          if (ev.kind === "open") {
            return (
              <TimelineItem key={i} color="#00183A" title="Thesis opened" date={dateStr(ev.date)} last={last}>
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
              </TimelineItem>
            );
          }
          if (ev.kind === "update") {
            return (
              <TimelineItem key={i} color="#8A6D1F" title="Thesis update" date={dateStr(ev.date)} last={last}>
                <div style={{ fontSize: 13, color: "#0A0A0A", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
                  {ev.note}
                </div>
                <div style={{ fontSize: 10, color: "#9A9A8E", marginTop: 6 }}>
                  {ev.author}
                  {ev.fromTrade ? " · noted alongside a trade" : ""}
                </div>
              </TimelineItem>
            );
          }
          if (ev.kind === "close") {
            return (
              <TimelineItem key={i} color="#5A3F08" title="Position closed" date={dateStr(ev.date)} last={last}>
                <div style={{ fontSize: 13, color: "#0A0A0A", lineHeight: 1.55 }}>
                  The position was fully closed.
                  {realisedPnlDisplay ? (
                    <>
                      {" "}Realised P&amp;L:{" "}
                      <span style={{ ...numeric, color: realisedPnl != null && realisedPnl < 0 ? "#7A1F1F" : "#1F5C3A" }}>
                        {realisedPnlDisplay}
                      </span>.
                    </>
                  ) : null}
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
          <ThesisUpdateForm fundSlug={slug} thesisId={thesisId} />
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
        }}
      >
        {children}
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
