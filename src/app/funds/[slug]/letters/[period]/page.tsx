import { db } from "@/db/client";
import { funds as fundsTable, monthlyBriefings, users } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string; period: string }>;
}

function fmtPeriod(p: string): string {
  const [y, m] = p.split("-").map(Number);
  if (!y || !m) return p;
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
}

function fmtDate(d: Date | null): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default async function PublicLetterPage({ params }: PageProps) {
  const { slug, period } = await params;

  const fundRows = await db
    .select({ id: fundsTable.id, name: fundsTable.name, slug: fundsTable.slug })
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  // Only PUBLISHED letters are public — a draft (or missing) period 404s.
  const rows = await db
    .select({
      title: monthlyBriefings.title,
      period: monthlyBriefings.period,
      macroSection: monthlyBriefings.macroSection,
      portfolioActivitySection: monthlyBriefings.portfolioActivitySection,
      performanceCommentarySection: monthlyBriefings.performanceCommentarySection,
      outlookSection: monthlyBriefings.outlookSection,
      publishedAt: monthlyBriefings.publishedAt,
      authorName: users.fullName,
    })
    .from(monthlyBriefings)
    .innerJoin(users, eq(monthlyBriefings.authorUserId, users.id))
    .where(
      and(
        eq(monthlyBriefings.fundId, fund.id),
        eq(monthlyBriefings.period, period),
        eq(monthlyBriefings.status, "published")
      )
    )
    .limit(1);
  if (rows.length === 0) notFound();
  const b = rows[0];

  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "36px 32px 0" }}>
      <Link
        href={`/funds/${fund.slug}`}
        style={{ fontSize: 12, color: "#6B6B66", textDecoration: "none", fontFamily: "system-ui, sans-serif" }}
      >
        ← {fund.name}
      </Link>

      <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "#9A9A8E", margin: "18px 0 6px" }}>
        {fund.name} · {fmtPeriod(b.period)}
      </div>
      <h1 style={{ ...serif, fontSize: 28, color: "#00183A", margin: "0 0 8px", fontWeight: 400, lineHeight: 1.2 }}>
        {b.title}
      </h1>
      <div style={{ fontSize: 12, color: "#9A9A8E", marginBottom: 26, fontFamily: "system-ui, sans-serif" }}>
        {b.authorName}
        {b.publishedAt ? ` · ${fmtDate(b.publishedAt)}` : ""}
      </div>

      <Section title="Macro & market backdrop" body={b.macroSection} />
      <Section title="Portfolio activity" body={b.portfolioActivitySection} />
      <Section title="Performance commentary" body={b.performanceCommentarySection} />
      {b.outlookSection ? <Section title="Outlook" body={b.outlookSection} /> : null}

      <div style={{ height: 24 }} />
    </main>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <section style={{ marginBottom: 26 }}>
      <h2 style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: "#9A9A8E", margin: "0 0 8px", fontFamily: "system-ui, sans-serif", fontWeight: 600 }}>
        {title}
      </h2>
      <div style={{ fontSize: 15, color: "#1A1A1A", lineHeight: 1.75, whiteSpace: "pre-wrap", fontFamily: "Georgia, 'Times New Roman', serif" }}>
        {body}
      </div>
    </section>
  );
}
