import { db } from "@/db/client";
import { funds as fundsTable, monthlyBriefings } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";
import BriefingEditor from "@/components/BriefingEditor";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string; id: string }>;
}

export default async function EditBriefingPage({ params }: PageProps) {
  const { slug, id } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db
    .select({ id: fundsTable.id })
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  const rows = await db
    .select()
    .from(monthlyBriefings)
    .where(and(eq(monthlyBriefings.id, id), eq(monthlyBriefings.fundId, fund.id)))
    .limit(1);
  if (rows.length === 0) notFound();
  const b = rows[0];

  return (
    <main style={{ padding: "28px 32px 64px", maxWidth: 820 }}>
      <Link href={`/dashboard/funds/${slug}/briefings`} style={{ fontSize: 12, color: "#6B6B66", textDecoration: "none", fontFamily: "system-ui, sans-serif" }}>
        ← Briefings
      </Link>
      <h1 style={{ ...serif, fontSize: 26, color: "#00183A", margin: "10px 0 22px", fontWeight: 400 }}>Edit briefing</h1>
      <BriefingEditor
        fundSlug={slug}
        initial={{
          id: b.id,
          period: b.period,
          title: b.title,
          macroSection: b.macroSection,
          portfolioActivitySection: b.portfolioActivitySection,
          performanceCommentarySection: b.performanceCommentarySection,
          outlookSection: b.outlookSection ?? "",
          status: b.status,
        }}
      />
    </main>
  );
}
