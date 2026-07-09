import { db } from "@/db/client";
import { funds as fundsTable, securities, users, transactions } from "@/db/schema";
import { theses, thesisUpdates } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import ThesisApprovalActions from "@/components/ThesisApprovalActions";
import { eq, desc, inArray, min } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif, numeric } from "@/lib/typography";
import PdfMemoCard from "@/components/PdfMemoCard";

export const dynamic = "force-dynamic";

export default async function ThesesListPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  const rows = await db
    .select({
      id: theses.id,
      authorUserId: theses.authorUserId,
      authorName: users.fullName,
      openedAt: theses.openedAt,
      closedAt: theses.closedAt,
      status: theses.status,
      direction: theses.direction,
      conviction: theses.conviction,
      targetWeightPct: theses.targetWeightPct,
      targetPriceNative: theses.targetPriceNative,
      holdingPeriod: theses.holdingPeriod,
      title: theses.title,
      summary: theses.summary,
      memoBlobUrl: theses.memoBlobUrl,
      memoBlobFilename: theses.memoBlobFilename,
      ticker: securities.ticker,
      securityName: securities.name,
      exchange: securities.exchange,
      currency: securities.currency,
      approvalStatus: theses.approvalStatus,
    })
    .from(theses)
    .innerJoin(securities, eq(theses.securityId, securities.id))
    .innerJoin(users, eq(theses.authorUserId, users.id))
    .where(eq(theses.fundId, fund.id))
    .orderBy(desc(theses.openedAt));

  // Effective opened date = earliest linked trade (so the list matches the
  // thesis timeline). Fall back to the creation date when nothing's linked.
  const thesisIds = rows.map((r) => r.id);
  const earliestTradeByThesis = new Map<string, Date>();
  if (thesisIds.length > 0) {
    const mins = await db
      .select({ thesisId: transactions.thesisId, earliest: min(transactions.executedAt) })
      .from(transactions)
      .where(inArray(transactions.thesisId, thesisIds))
      .groupBy(transactions.thesisId);
    for (const m of mins) {
      if (m.thesisId && m.earliest) earliestTradeByThesis.set(m.thesisId, new Date(m.earliest));
    }
  }
  const effectiveOpened = (r: (typeof rows)[number]): Date =>
    earliestTradeByThesis.get(r.id) ?? new Date(r.openedAt);
  rows.sort((a, b) => effectiveOpened(b).getTime() - effectiveOpened(a).getTime());

  // Each thesis is a living view: derive its CURRENT state from the most recent
  // updates (latest non-null revision wins), plus the single latest update note.
  const latestUpdateByThesis = new Map<string, { note: string; createdAt: Date }>();
  const currentByThesis = new Map<
    string,
    { conviction: string | null; tw: string | null; tp: string | null; convRev: boolean; twRev: boolean; tpRev: boolean }
  >();
  if (thesisIds.length > 0) {
    const ups = await db
      .select({
        thesisId: thesisUpdates.thesisId,
        note: thesisUpdates.note,
        createdAt: thesisUpdates.createdAt,
        newConviction: thesisUpdates.newConviction,
        newTargetWeightPct: thesisUpdates.newTargetWeightPct,
        newTargetPriceNative: thesisUpdates.newTargetPriceNative,
      })
      .from(thesisUpdates)
      .where(inArray(thesisUpdates.thesisId, thesisIds))
      .orderBy(desc(thesisUpdates.createdAt)); // newest first → first non-null is the latest revision
    for (const u of ups) {
      if (!latestUpdateByThesis.has(u.thesisId)) {
        latestUpdateByThesis.set(u.thesisId, { note: u.note, createdAt: new Date(u.createdAt) });
      }
      const cur =
        currentByThesis.get(u.thesisId) ?? { conviction: null, tw: null, tp: null, convRev: false, twRev: false, tpRev: false };
      if (cur.conviction === null && u.newConviction) {
        cur.conviction = u.newConviction;
        cur.convRev = true;
      }
      if (cur.tw === null && u.newTargetWeightPct != null) {
        cur.tw = String(u.newTargetWeightPct);
        cur.twRev = true;
      }
      if (cur.tp === null && u.newTargetPriceNative != null) {
        cur.tp = String(u.newTargetPriceNative);
        cur.tpRev = true;
      }
      currentByThesis.set(u.thesisId, cur);
    }
  }
  // Current value accessors (fall back to the opening thesis when never revised).
  const curConviction = (r: (typeof rows)[number]) => currentByThesis.get(r.id)?.conviction ?? (r.conviction as string | null);
  const curTW = (r: (typeof rows)[number]) => currentByThesis.get(r.id)?.tw ?? (r.targetWeightPct as string | null);
  const curTP = (r: (typeof rows)[number]) => currentByThesis.get(r.id)?.tp ?? (r.targetPriceNative as string | null);
  const rev = (r: (typeof rows)[number], f: "convRev" | "twRev" | "tpRev") => currentByThesis.get(r.id)?.[f] ?? false;

  const approvedRows = rows.filter((r) => r.approvalStatus === "approved");
  const canApprove = user.role === "admin" || user.role === "pm";
  // Under-review = pending or rejected. PMs/admins see all of them; anyone else
  // sees only their own, so a rejected submission never silently disappears.
  const reviewRows = rows.filter(
    (r) =>
      (r.approvalStatus === "pending" || r.approvalStatus === "rejected") &&
      (canApprove || r.authorUserId === user.id)
  );
  const pendingCount = rows.filter((r) => r.approvalStatus === "pending").length;

  const activeCount = approvedRows.filter((r) => r.status === "active").length;
  const closedCount = approvedRows.filter(
    (r) => r.status === "closed" || r.status === "post_mortem"
  ).length;

  const baseSym =
    fund.baseCurrency === "GBP" ? "£" : fund.baseCurrency === "EUR" ? "€" : "$";
  void baseSym;

  return (
    <main style={{ padding: "28px 32px 64px" }}>
      <div style={{ marginBottom: 6 }}>
        <Link
          href={`/dashboard/funds/${fund.slug}`}
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "#6B6B66",
            textDecoration: "none",
          }}
        >
          ← {fund.name}
        </Link>
      </div>
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#6B6B66",
          fontWeight: 500,
          marginTop: 12,
        }}
      >
        Investment theses
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginTop: 4,
          marginBottom: 8,
        }}
      >
        <h1
          style={{
            ...serif,
            fontWeight: 400,
            fontSize: 28,
            color: "#00183A",
            margin: 0,
            letterSpacing: "-0.01em",
          }}
        >
          {fund.name}
        </h1>
        <Link
          href={`/dashboard/funds/${fund.slug}/theses/new`}
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "white",
            textDecoration: "none",
            background: "#00183A",
            padding: "9px 16px",
            border: "1px solid #00183A",
            whiteSpace: "nowrap",
            fontWeight: 500,
          }}
        >
          + New thesis
        </Link>
      </div>
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
          color: "#6B6B66",
          marginBottom: 24,
          maxWidth: 720,
          lineHeight: 1.5,
        }}
      >
        Investment theses document the rationale, conviction, and target for
        each idea. Trades execute on a thesis; post-mortems review how the
        thesis played out. {approvedRows.length} total · {activeCount} active ·{" "}
        {closedCount} closed
        {pendingCount > 0 ? ` · ${pendingCount} pending approval` : ""}.
      </div>

      {reviewRows.length > 0 && (
        <div
          style={{
            background: "#FCFBF4",
            border: "1px solid #E7DCae",
            borderRadius: 8,
            padding: "16px 18px",
            marginBottom: 20,
          }}
        >
          <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "#8A6D1F", fontWeight: 700, marginBottom: 12 }}>
            {canApprove ? "Awaiting review" : "Your submissions"} ({reviewRows.length})
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {reviewRows.map((r) => {
              const rejected = r.approvalStatus === "rejected";
              return (
                <div key={r.id} style={{ display: "flex", alignItems: "flex-start", gap: 14, paddingBottom: 10, borderBottom: "1px solid #EFEAD6" }}>
                  <div style={{ minWidth: 70 }}>
                    <Link href={`/dashboard/funds/${fund.slug}/theses/${r.id}`} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, fontWeight: 600, color: "#00183A", textDecoration: "none" }}>
                      {r.ticker}
                    </Link>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                      <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 9, letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 700, color: rejected ? "#7A1F1F" : "#8A6D1F", background: rejected ? "#FBF0F0" : "#F5EED6", border: `1px solid ${rejected ? "#E4C9C9" : "#E7DCae"}`, borderRadius: 3, padding: "1px 6px" }}>
                        {rejected ? "Not approved" : "Pending"}
                      </span>
                      {r.title && <span style={{ ...serif, fontSize: 14, fontWeight: 700, color: "#00183A" }}>{r.title}</span>}
                    </div>
                    <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#0A0A0A", lineHeight: 1.4 }}>
                      {r.summary.length > 160 ? r.summary.slice(0, 160).trimEnd() + "…" : r.summary}
                    </div>
                    <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: "#9A9A8E", marginTop: 3 }}>
                      Submitted by {r.authorName ?? "—"}
                    </div>
                  </div>
                  {canApprove ? (
                    <ThesisApprovalActions fundSlug={fund.slug} thesisId={r.id} />
                  ) : (
                    <span style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, color: rejected ? "#7A1F1F" : "#8A6D1F", fontWeight: 600, whiteSpace: "nowrap" }}>
                      {rejected ? "Not approved" : "Awaiting approval"}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {approvedRows.length === 0 ? (
        <div
          style={{
            background: "white",
            border: "1px solid #D9D9D2",
            padding: "32px 28px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              ...serif,
              fontSize: 18,
              color: "#00183A",
              marginBottom: 8,
            }}
          >
            No theses yet
          </div>
          <div
            style={{
              fontFamily: "system-ui, sans-serif",
              fontSize: 13,
              color: "#6B6B66",
              maxWidth: 480,
              margin: "0 auto",
              lineHeight: 1.55,
            }}
          >
            A thesis is the rationale behind an investment idea — what you
            believe, why, and how strongly. Write one before placing a trade,
            so the system can link every transaction back to its reasoning.
          </div>
        </div>
      ) : (
        <div
          style={{
            background: "white",
            border: "1px solid #D9D9D2",
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
            <thead>
              <tr>
                {[
                  { label: "Status", align: "left" as const, w: "90px" },
                  { label: "Ticker", align: "left" as const, w: "80px" },
                  { label: "Latest update", align: "left" as const, w: "auto" },
                  { label: "Author", align: "left" as const, w: "130px" },
                  { label: "Conviction", align: "left" as const, w: "84px" },
                  { label: "Target wt.", align: "right" as const, w: "76px" },
                  { label: "Target px.", align: "right" as const, w: "84px" },
                  { label: "Opened", align: "right" as const, w: "100px" },
                  { label: "", align: "right" as const, w: "40px" },
                ].map((h) => (
                  <th
                    key={h.label}
                    style={{
                      fontSize: 10,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      color: "#6B6B66",
                      borderBottom: "1px solid #E5E5DE",
                      padding: "10px 14px",
                      fontWeight: 500,
                      textAlign: h.align,
                      width: h.w,
                    }}
                  >
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {approvedRows.map((r) => {
                const openedStr = effectiveOpened(r).toLocaleDateString(
                  "en-GB",
                  { day: "2-digit", month: "short", year: "numeric" }
                );
                const statusLabel =
                  r.status === "active"
                    ? "Active"
                    : r.status === "closed"
                      ? "Closed"
                      : r.status === "post_mortem"
                        ? "Reviewed"
                        : "Abandoned";
                const statusColor =
                  r.status === "active"
                    ? "#1F5C3A"
                    : r.status === "closed"
                      ? "#5A3F08"
                      : r.status === "post_mortem"
                        ? "#00183A"
                        : "#9A9A8E";
                const convNow = curConviction(r);
                const convColor =
                  convNow === "high"
                    ? "#1F5C3A"
                    : convNow === "medium"
                      ? "#5A3F08"
                      : "#6B6B66";
                return (
                  <tr key={r.id}>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        verticalAlign: "top",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 10,
                          letterSpacing: "0.05em",
                          textTransform: "uppercase",
                          color: statusColor,
                          fontWeight: 600,
                        }}
                      >
                        {statusLabel}
                      </span>
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        verticalAlign: "top",
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "ui-monospace, monospace",
                          fontSize: 12,
                          fontWeight: 600,
                          color: "#00183A",
                        }}
                      >
                        {r.ticker}
                      </div>
                      <div
                        style={{
                          fontSize: 10,
                          color: "#6B6B66",
                          marginTop: 1,
                        }}
                      >
                        {r.securityName}
                      </div>
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        color: "#0A0A0A",
                        lineHeight: 1.45,
                        maxWidth: 480,
                        verticalAlign: "top",
                        wordBreak: "break-word",
                        overflowWrap: "anywhere",
                      }}
                    >
                      <Link
                        href={`/dashboard/funds/${slug}/theses/${r.id}`}
                        style={{ textDecoration: "none", display: "block" }}
                      >
                        {latestUpdateByThesis.get(r.id) ? (
                          <>
                            <div style={{ fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase", color: "#8A6D1F", fontWeight: 600, marginBottom: 2 }}>
                              {latestUpdateByThesis.get(r.id)!.createdAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                            </div>
                            <div style={{ color: "#00183A", fontWeight: 500 }}>
                              {(() => {
                                const n = latestUpdateByThesis.get(r.id)!.note;
                                return n.length > 160 ? n.slice(0, 160).trimEnd() + "…" : n;
                              })()}
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={{ fontSize: 10, letterSpacing: "0.04em", textTransform: "uppercase", color: "#9A9A8E", fontWeight: 600, marginBottom: 2 }}>
                              {openedStr}
                            </div>
                            <div style={{ color: "#00183A", fontWeight: 500 }}>{r.summary}</div>
                          </>
                        )}
                      </Link>
                      {r.memoBlobUrl ? (
                        <div style={{ marginTop: 8 }}>
                          <PdfMemoCard
                            href={`/api/funds/${slug}/theses/${r.id}/memo`}
                            filename={r.memoBlobFilename ?? "memo.pdf"}
                          />
                        </div>
                      ) : null}
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        color: "#0A0A0A",
                        fontSize: 12,
                        verticalAlign: "top",
                      }}
                    >
                      {r.authorName ?? "—"}
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        verticalAlign: "top",
                        fontSize: 11,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        color: convColor,
                        fontWeight: 600,
                      }}
                    >
                      {convNow ?? "—"}
                      {rev(r, "convRev") && (
                        <div style={{ fontSize: 9, color: "#8A6D1F", fontWeight: 600, marginTop: 2 }}>revised ↑</div>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        textAlign: "right",
                        ...numeric,
                        color: "#0A0A0A",
                        verticalAlign: "top",
                      }}
                    >
                      {curTW(r)
                        ? `${(Number(curTW(r)) * 100).toFixed(2)}%`
                        : "—"}
                      {rev(r, "twRev") && (
                        <div style={{ fontSize: 9, color: "#8A6D1F", fontWeight: 600, marginTop: 2 }}>revised ↑</div>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        textAlign: "right",
                        ...numeric,
                        color: "#0A0A0A",
                        verticalAlign: "top",
                      }}
                    >
                      {curTP(r)
                        ? `${r.currency === "USD" ? "$" : r.currency === "EUR" ? "€" : "£"}${Number(curTP(r)).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                      {rev(r, "tpRev") && (
                        <div style={{ fontSize: 9, color: "#8A6D1F", fontWeight: 600, marginTop: 2 }}>revised ↑</div>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        textAlign: "right",
                        ...numeric,
                        color: "#6B6B66",
                        fontSize: 11,
                        verticalAlign: "top",
                      }}
                    >
                      {openedStr}
                    </td>
                    <td
                      style={{
                        padding: "12px 14px",
                        borderBottom: "1px solid #F0EFEA",
                        textAlign: "right",
                        verticalAlign: "top",
                      }}
                    >
                      <Link
                        href={`/dashboard/funds/${fund.slug}/theses/${r.id}`}
                        aria-label="Open thesis"
                        title="Open thesis"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 26,
                          height: 26,
                          borderRadius: 5,
                          border: "1px solid #D9D9D2",
                          color: "#00183A",
                          textDecoration: "none",
                          fontSize: 15,
                          lineHeight: 1,
                        }}
                      >
                        →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
