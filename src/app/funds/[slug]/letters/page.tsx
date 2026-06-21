import { db } from "@/db/client";
import { funds as fundsTable, monthlyBriefings } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

function fmtPeriod(p: string): string {
  const [y, m] = p.split("-").map(Number);
  if (!y || !m) return p;
  return new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export default async function PublicLettersIndex({ params }: PageProps) {
  const { slug } = await params;

  const fundRows = await db
    .select({ id: fundsTable.id, name: fundsTable.name, slug: fundsTable.slug })
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  const letters = await db
    .select({
      period: monthlyBriefings.period,
      title: monthlyBriefings.title,
    })
    .from(monthlyBriefings)
    .where(
      and(
        eq(monthlyBriefings.fundId, fund.id),
        eq(monthlyBriefings.status, "published")
      )
    )
    .orderBy(desc(monthlyBriefings.period));

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "36px 32px 0" }}>
      <Link href={`/funds/${fund.slug}`} style={{ fontSize: 12, color: "#6B6B66", textDecoration: "none", fontFamily: "system-ui, sans-serif" }}>
        ← {fund.name}
      </Link>
      <h1 style={{ ...serif, fontSize: 28, color: "#00183A", margin: "16px 0 22px", fontWeight: 400 }}>
        Letters
      </h1>

      {letters.length === 0 ? (
        <div style={{ border: "1px solid #E5E5DE", background: "white", padding: "18px 20px", fontSize: 13, color: "#6B6B66", fontFamily: "system-ui, sans-serif" }}>
          No letters have been published for this fund yet.
        </div>
      ) : (
        <div style={{ border: "1px solid #E5E5DE" }}>
          {letters.map((l, i) => (
            <Link
              key={l.period}
              href={`/funds/${fund.slug}/letters/${l.period}`}
              style={{ textDecoration: "none", display: "block", background: "white", borderBottom: i < letters.length - 1 ? "1px solid #E5E5DE" : "none" }}
            >
              <div style={{ padding: "15px 18px", display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ ...serif, fontSize: 16, color: "#00183A", marginBottom: 2 }}>{l.title}</div>
                  <div style={{ fontSize: 12, color: "#9A9A8E", fontFamily: "system-ui, sans-serif" }}>{fmtPeriod(l.period)}</div>
                </div>
                <span style={{ color: "#C8C8C0" }}>›</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
