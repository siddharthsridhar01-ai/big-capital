import { db } from "@/db/client";
import { funds as fundsTable, securities, users } from "@/db/schema";
import { theses } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";
import EditThesisForm from "@/components/EditThesisForm";

export const dynamic = "force-dynamic";

function ccySym(cur: string): string {
  return cur === "USD" ? "$" : cur === "EUR" ? "€" : "£";
}

export default async function EditThesisPage({
  params,
}: {
  params: Promise<{ slug: string; thesisId: string }>;
}) {
  const { slug, thesisId } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  const rows = await db
    .select({
      id: theses.id,
      authorUserId: theses.authorUserId,
      conviction: theses.conviction,
      holdingPeriod: theses.holdingPeriod,
      title: theses.title,
      summary: theses.summary,
      targetWeightPct: theses.targetWeightPct,
      targetPriceNative: theses.targetPriceNative,
      memoBlobFilename: theses.memoBlobFilename,
      ticker: securities.ticker,
      securityName: securities.name,
      securityCurrency: securities.currency,
    })
    .from(theses)
    .innerJoin(securities, eq(theses.securityId, securities.id))
    .where(and(eq(theses.id, thesisId), eq(theses.fundId, fund.id)))
    .limit(1);
  if (rows.length === 0) notFound();
  const t = rows[0];

  // Only the fund admin or the thesis author may edit.
  const isAuthor = t.authorUserId === user.id;
  if (user.role !== "admin" && !isAuthor) {
    redirect(`/dashboard/funds/${slug}/theses/${thesisId}`);
  }

  // Stored target weight is a fraction (0.05); the form shows it as a percent.
  const twPercent =
    t.targetWeightPct != null && t.targetWeightPct !== ""
      ? String(Number(t.targetWeightPct) * 100)
      : "";

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "32px 24px 80px" }}>
      <Link
        href={`/dashboard/funds/${slug}/theses/${thesisId}`}
        style={{ fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#6B6B66", textDecoration: "none" }}
      >
        ← Back to thesis
      </Link>
      <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B6B66", marginTop: 20 }}>
        {t.ticker} · Edit
      </div>
      <h1 style={{ ...serif, fontSize: 30, color: "#00183A", margin: "6px 0 24px" }}>Edit thesis</h1>

      <EditThesisForm
        fundSlug={slug}
        thesisId={thesisId}
        ticker={t.ticker}
        securityName={t.securityName}
        currencySymbol={ccySym(t.securityCurrency as string)}
        initial={{
          conviction: t.conviction as "high" | "medium" | "low",
          holdingPeriod: t.holdingPeriod as "short" | "medium" | "long" | "indefinite",
          title: t.title ?? "",
          summary: t.summary,
          targetWeightPct: twPercent,
          targetPriceNative: t.targetPriceNative != null ? String(t.targetPriceNative) : "",
          memoFilename: t.memoBlobFilename ?? null,
        }}
      />
    </div>
  );
}
