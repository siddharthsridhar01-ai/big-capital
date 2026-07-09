import { db } from "@/db/client";
import { funds as fundsTable, securities, transactions, fundMembers } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { and, eq, isNull } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif } from "@/lib/typography";
import EditTradeForm from "@/components/EditTradeForm";

export const dynamic = "force-dynamic";

function ccySym(cur: string): string {
  return cur === "USD" ? "$" : cur === "EUR" ? "€" : "£";
}

export default async function EditTradePage({
  params,
}: {
  params: Promise<{ slug: string; txnId: string }>;
}) {
  const { slug, txnId } = await params;
  const user = await getOrCreateUser();
  if (!user) redirect("/sign-in");

  const fundRows = await db.select().from(fundsTable).where(eq(fundsTable.slug, slug)).limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  // Auth: admin, or active fund member.
  if (user.role !== "admin") {
    const mem = await db
      .select({ userId: fundMembers.userId })
      .from(fundMembers)
      .where(and(eq(fundMembers.fundId, fund.id), eq(fundMembers.userId, user.id), isNull(fundMembers.endDate)))
      .limit(1);
    if (mem.length === 0) redirect(`/dashboard/funds/${slug}`);
  }

  const rows = await db
    .select({
      id: transactions.id,
      type: transactions.transactionType,
      quantity: transactions.quantity,
      priceNative: transactions.price,
      rationale: transactions.rationale,
      ticker: securities.ticker,
      currency: securities.currency,
    })
    .from(transactions)
    .leftJoin(securities, eq(transactions.securityId, securities.id))
    .where(and(eq(transactions.id, txnId), eq(transactions.fundId, fund.id)))
    .limit(1);
  if (rows.length === 0) notFound();
  const tx = rows[0];

  const sym = ccySym((tx.currency as string) ?? "GBP");
  const qtyAbs = Math.abs(Number(tx.quantity)).toLocaleString();
  const priceStr = tx.priceNative != null ? `${sym}${Number(tx.priceNative).toFixed(2)}` : "";
  const label = `${(tx.type as string).toUpperCase()} ${qtyAbs}${tx.ticker ? " " + tx.ticker : ""}${priceStr ? " @ " + priceStr : ""}`;

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "32px 24px 80px" }}>
      <Link href={`/dashboard/funds/${slug}`} style={{ fontFamily: "system-ui, sans-serif", fontSize: 13, color: "#6B6B66", textDecoration: "none" }}>
        ← Back to fund
      </Link>
      <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#6B6B66", marginTop: 20 }}>
        Edit trade note
      </div>
      <h1 style={{ ...serif, fontSize: 30, color: "#00183A", margin: "6px 0 24px" }}>Edit trade rationale</h1>

      <EditTradeForm
        fundSlug={slug}
        txnId={txnId}
        tradeLabel={label}
        initial={{
          rationale: tx.rationale,
        }}
      />
    </div>
  );
}
