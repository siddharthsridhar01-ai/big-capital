import { db } from "@/db/client";
import { funds as fundsTable, securities, users } from "@/db/schema";
import { theses } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { eq, desc } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif, numeric } from "@/lib/typography";

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
      holdingPeriod: theses.holdingPeriod,
      summary: theses.summary,
      memoBlobUrl: theses.memoBlobUrl,
      memoBlobFilename: theses.memoBlobFilename,
      ticker: securities.ticker,
      securityName: securities.name,
      exchange: securities.exchange,
    })
    .from(theses)
    .innerJoin(securities, eq(theses.securityId, securities.id))
    .innerJoin(users, eq(theses.authorUserId, users.id))
    .where(eq(theses.fundId, fund.id))
    .orderBy(desc(theses.openedAt));

  const activeCount = rows.filter((r) => r.status === "active").length;
  const closedCount = rows.filter(
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
        thesis played out. {rows.length} total · {activeCount} active ·{" "}
        {closedCount} closed.
      </div>

      {rows.length === 0 ? (
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
                  { label: "Summary", align: "left" as const, w: "auto" },
                  { label: "Author", align: "left" as const, w: "140px" },
                  { label: "Conviction", align: "left" as const, w: "90px" },
                  { label: "Target wt.", align: "right" as const, w: "80px" },
                  { label: "Opened", align: "right" as const, w: "100px" },
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
              {rows.map((r) => {
                const openedStr = new Date(r.openedAt).toLocaleDateString(
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
                const convColor =
                  r.conviction === "high"
                    ? "#1F5C3A"
                    : r.conviction === "medium"
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
                        <Link
                          href={`/dashboard/funds/${fund.slug}/theses/${r.id}`}
                          style={{
                            color: "#00183A",
                            textDecoration: "none",
                            borderBottom: "1px solid #C8C8C0",
                          }}
                        >
                          {r.ticker}
                        </Link>
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
                      {r.summary}
                      {r.memoBlobUrl ? (
                        <div style={{ marginTop: 4 }}>
                          <a
                            href={`/api/funds/${slug}/theses/${r.id}/memo`}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              fontSize: 11,
                              color: "#00183A",
                              textDecoration: "none",
                              borderBottom: "1px solid #00183A",
                            }}
                          >
                            View memo PDF →
                          </a>
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
                      {r.conviction}
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
                      {r.targetWeightPct
                        ? `${(Number(r.targetWeightPct) * 100).toFixed(2)}%`
                        : "—"}
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
