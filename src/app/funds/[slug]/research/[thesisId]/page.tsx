/**
 * Public view of a featured thesis.
 *
 * Renders ONLY if the thesis is both featured and approved — otherwise 404, so
 * an unfeatured or unreviewed thesis cannot be reached by guessing its id.
 *
 * Deliberately omits the analyst's working: no financial model, no target
 * weight. The memo and the argument are what a reader should see; sizing is the
 * fund's business.
 */
import { db } from "@/db/client";
import { funds, securities, users } from "@/db/schema";
import { theses } from "@/db/schema-theses";
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";

const CONVICTION: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };
const HORIZON: Record<string, string> = {
  short: "Short (< 3 months)",
  medium: "Medium (3–12 months)",
  long: "Long (1–3 years)",
  indefinite: "Indefinite",
};

export default async function PublicThesisPage({
  params,
}: {
  params: Promise<{ slug: string; thesisId: string }>;
}) {
  const { slug, thesisId } = await params;

  const [fund] = await db
    .select({ id: funds.id, name: funds.name, slug: funds.slug })
    .from(funds)
    .where(eq(funds.slug, slug))
    .limit(1);
  if (!fund) notFound();

  const [t] = await db
    .select({
      id: theses.id,
      title: theses.title,
      summary: theses.summary,
      direction: theses.direction,
      conviction: theses.conviction,
      holdingPeriod: theses.holdingPeriod,
      status: theses.status,
      memoBlobUrl: theses.memoBlobUrl,
      createdAt: theses.createdAt,
      ticker: securities.ticker,
      securityName: securities.name,
      author: users.fullName,
    })
    .from(theses)
    .leftJoin(securities, eq(securities.id, theses.securityId))
    .leftJoin(users, eq(users.id, theses.authorUserId))
    .where(
      and(
        eq(theses.id, thesisId),
        eq(theses.fundId, fund.id),
        eq(theses.isFeatured, true),
        eq(theses.approvalStatus, "approved")
      )
    )
    .limit(1);
  if (!t) notFound();

  const META: React.CSSProperties = {
    fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase",
    color: "#9A9A8E", fontFamily: "system-ui, sans-serif",
  };
  const VAL: React.CSSProperties = { fontSize: 14, color: "#00183A", fontFamily: "system-ui, sans-serif", marginTop: 3 };

  return (
    <main style={{ maxWidth: 820, margin: "0 auto", padding: "40px 24px 80px" }}>
      <Link href={`/funds/${fund.slug}`} style={{ fontSize: 12, color: "#6B6B66", textDecoration: "none", fontFamily: "system-ui, sans-serif" }}>
        &larr; {fund.name}
      </Link>

      <div style={{ ...META, marginTop: 22, color: t.direction === "short" ? "#7A1F1F" : "#2F5D45" }}>
        {t.direction === "short" ? "Short" : "Long"} · {t.ticker ?? "—"}
        {t.status !== "active" ? " · Closed" : ""}
      </div>
      <h1 style={{ ...serif, fontSize: 32, color: "#00183A", margin: "6px 0 4px", lineHeight: 1.2 }}>
        {t.title ?? t.securityName ?? "Investment thesis"}
      </h1>
      {t.securityName && t.title ? (
        <div style={{ fontSize: 14, color: "#6B6B66", fontFamily: "system-ui, sans-serif" }}>{t.securityName}</div>
      ) : null}

      <div style={{ display: "flex", gap: 32, flexWrap: "wrap", margin: "24px 0", padding: "16px 0", borderTop: "1px solid #E5E5DE", borderBottom: "1px solid #E5E5DE" }}>
        <div><div style={META}>Conviction</div><div style={VAL}>{CONVICTION[t.conviction ?? ""] ?? "—"}</div></div>
        <div><div style={META}>Horizon</div><div style={VAL}>{HORIZON[t.holdingPeriod ?? ""] ?? "—"}</div></div>
        {t.author ? <div><div style={META}>Analyst</div><div style={VAL}>{t.author}</div></div> : null}
        <div>
          <div style={META}>Written</div>
          <div style={VAL}>{t.createdAt ? new Date(t.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "—"}</div>
        </div>
      </div>

      <div style={{ ...serif, fontSize: 17, color: "#222", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>{t.summary}</div>

      {t.memoBlobUrl ? (
        <div style={{ marginTop: 32 }}>
          <div style={{ ...META, marginBottom: 8 }}>Investment memo</div>
          <iframe
            src={`/api/funds/${fund.slug}/research/${t.id}/memo`}
            title="Investment memo"
            style={{ width: "100%", height: 720, border: "1px solid #E5E5DE", background: "#FAFAF7" }}
          />
        </div>
      ) : null}

      <div style={{ marginTop: 40, fontSize: 11, color: "#9A9A8E", lineHeight: 1.6, fontFamily: "system-ui, sans-serif" }}>
        Student research for a paper-traded educational fund. Not investment advice. No client capital
        is managed, and the fund may have changed or exited this position since publication.
      </div>
    </main>
  );
}
