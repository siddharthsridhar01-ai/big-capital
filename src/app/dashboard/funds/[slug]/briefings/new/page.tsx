import { db } from "@/db/client";
import { funds as fundsTable } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getOrCreateUser } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";
import BriefingEditor from "@/components/BriefingEditor";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function NewBriefingPage({ params }: PageProps) {
  const { slug } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db
    .select({ name: fundsTable.name })
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) notFound();

  return (
    <main style={{ padding: "28px 32px 64px", maxWidth: 820 }}>
      <Link href={`/dashboard/funds/${slug}/briefings`} style={{ fontSize: 12, color: "#6B6B66", textDecoration: "none", fontFamily: "system-ui, sans-serif" }}>
        ← Briefings
      </Link>
      <h1 style={{ ...serif, fontSize: 26, color: "#00183A", margin: "10px 0 22px", fontWeight: 400 }}>New briefing</h1>
      <BriefingEditor fundSlug={slug} />
    </main>
  );
}
