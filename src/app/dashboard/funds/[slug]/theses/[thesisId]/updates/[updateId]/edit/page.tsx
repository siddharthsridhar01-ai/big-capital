import { db } from "@/db/client";
import { funds as fundsTable, securities } from "@/db/schema";
import { theses, thesisUpdates } from "@/db/schema-theses";
import { getOrCreateUser } from "@/lib/auth";
import { and, eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";
import EditThesisUpdateForm from "@/components/EditThesisUpdateForm";

export const dynamic = "force-dynamic";

function ccySym(cur: string): string {
  return cur === "USD" ? "$" : cur === "EUR" ? "€" : "£";
}

export default async function EditThesisUpdatePage({
  params,
}: {
  params: Promise<{ slug: string; thesisId: string; updateId: string }>;
}) {
  const { slug, thesisId, updateId } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  const rows = await db
    .select({
      id: thesisUpdates.id,
      authorUserId: thesisUpdates.authorUserId,
      note: thesisUpdates.note,
      newConviction: thesisUpdates.newConviction,
      newHoldingPeriod: thesisUpdates.newHoldingPeriod,
      newTargetWeightPct: thesisUpdates.newTargetWeightPct,
      newTargetPriceNative: thesisUpdates.newTargetPriceNative,
      attachmentBlobFilename: thesisUpdates.attachmentBlobFilename,
      thesisFundId: theses.fundId,
      currency: securities.currency,
    })
    .from(thesisUpdates)
    .innerJoin(theses, eq(thesisUpdates.thesisId, theses.id))
    .innerJoin(securities, eq(theses.securityId, securities.id))
    .where(and(eq(thesisUpdates.id, updateId), eq(thesisUpdates.thesisId, thesisId)))
    .limit(1);
  if (rows.length === 0 || rows[0].thesisFundId !== fund.id) notFound();
  const u = rows[0];

  const isAuthor = u.authorUserId === user.id;
  if (user.role !== "admin" && !isAuthor) {
    redirect(`/dashboard/funds/${slug}/theses/${thesisId}`);
  }

  const twPercent =
    u.newTargetWeightPct != null && u.newTargetWeightPct !== ""
      ? String(Number(u.newTargetWeightPct) * 100)
      : "";

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "32px 24px 80px" }}>
      <Link href={`/dashboard/funds/${slug}/theses/${thesisId}`} style={{ fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#6B6B66", textDecoration: "none" }}>
        ← Back to thesis
      </Link>
      <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B6B66", marginTop: 20 }}>
        Edit update
      </div>
      <h1 style={{ ...serif, fontSize: 30, color: "#00183A", margin: "6px 0 24px" }}>Edit thesis update</h1>

      <EditThesisUpdateForm
        fundSlug={slug}
        thesisId={thesisId}
        updateId={updateId}
        currencySymbol={ccySym(u.currency as string)}
        initial={{
          note: u.note,
          conviction: (u.newConviction as "" | "high" | "medium" | "low") ?? "",
          holdingPeriod: (u.newHoldingPeriod as "" | "short" | "medium" | "long" | "indefinite") ?? "",
          targetWeightPct: twPercent,
          targetPriceNative: u.newTargetPriceNative != null ? String(u.newTargetPriceNative) : "",
          attachmentFilename: u.attachmentBlobFilename ?? null,
        }}
      />
    </div>
  );
}
