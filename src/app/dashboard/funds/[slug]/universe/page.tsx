import { db } from "@/db/client";
import {
  funds as fundsTable,
  investableUniverses,
  securities,
  prices,
  transactions,
  fundMembers,
} from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { eq, isNull, and, inArray, desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { serif, numeric } from "@/lib/typography";
import UniverseTable from "@/components/UniverseTable";
import AddToUniverse from "@/components/AddToUniverse";

export const dynamic = "force-dynamic";

export default async function FundUniversePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const user = await getOrCreateUser();
  if (!user) return null;

  const { slug } = await params;
  const fundRows = await db
    .select()
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  // Can this user add to the universe? Admins always; otherwise current members.
  let canManage = user.role === "admin";
  if (!canManage) {
    const membership = await db
      .select({ id: fundMembers.userId })
      .from(fundMembers)
      .where(and(eq(fundMembers.fundId, fund.id), eq(fundMembers.userId, user.id), isNull(fundMembers.endDate)))
      .limit(1);
    canManage = membership.length > 0;
  }

  // Fetch the active investable universe for this fund
  const universeRows = await db
    .select({
      securityId: securities.id,
      ticker: securities.ticker,
      name: securities.name,
      exchange: securities.exchange,
      currency: securities.currency,
      gicsSector: securities.gicsSector,
      gicsIndustry: securities.gicsIndustry,
      isin: securities.isin,
      addedDate: investableUniverses.addedDate,
    })
    .from(investableUniverses)
    .innerJoin(
      securities,
      eq(investableUniverses.securityId, securities.id)
    )
    .where(
      and(
        eq(investableUniverses.fundId, fund.id),
        isNull(investableUniverses.removedDate)
      )
    );

  // Fetch latest close price per security for context
  const securityIds = universeRows.map((r) => r.securityId);
  const priceMap = new Map<string, { closePrice: string; date: string }>();
  if (securityIds.length > 0) {
    const priceRows = await db
      .select({
        securityId: prices.securityId,
        closePrice: prices.closePrice,
        date: prices.date,
      })
      .from(prices)
      .where(inArray(prices.securityId, securityIds))
      .orderBy(desc(prices.date));
    for (const p of priceRows) {
      if (!priceMap.has(p.securityId)) {
        priceMap.set(p.securityId, {
          closePrice: p.closePrice,
          date: p.date,
        });
      }
    }
  }

  // Compute "trades count" across all funds per security — proxy for "popular"
  // until we have real market cap data from EODHD
  const tradeCounts = new Map<string, number>();
  if (securityIds.length > 0) {
    const tradeRows = await db
      .select({
        securityId: transactions.securityId,
      })
      .from(transactions)
      .where(inArray(transactions.securityId, securityIds));
    for (const t of tradeRows) {
      if (t.securityId) {
        tradeCounts.set(
          t.securityId,
          (tradeCounts.get(t.securityId) ?? 0) + 1
        );
      }
    }
  }

  // Assemble the rows
  const rows = universeRows.map((r) => ({
    securityId: r.securityId,
    ticker: r.ticker,
    name: r.name,
    exchange: r.exchange,
    currency: r.currency as "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR" | "TWD",
    gicsSector: r.gicsSector,
    gicsIndustry: r.gicsIndustry,
    latestPrice: priceMap.get(r.securityId)?.closePrice ?? null,
    latestPriceDate: priceMap.get(r.securityId)?.date ?? null,
    tradeCount: tradeCounts.get(r.securityId) ?? 0,
  }));

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
        Investable universe
      </div>
      <h1
        style={{
          ...serif,
          fontWeight: 400,
          fontSize: 28,
          color: "#00183A",
          margin: "4px 0 8px",
          letterSpacing: "-0.01em",
        }}
      >
        {fund.name}
      </h1>
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 13,
          color: "#6B6B66",
          marginBottom: 28,
          maxWidth: 720,
          lineHeight: 1.5,
        }}
      >
        Securities approved for trading in this fund. Click any name to open
        its security page and place a trade.{" "}
        {canManage
          ? "Add any listed name below — it's validated live and becomes tradable immediately."
          : "The investable universe is managed by the fund's PMs."}
      </div>

      {canManage && <AddToUniverse fundSlug={fund.slug} />}

      <UniverseTable
        rows={rows}
        fundSlug={fund.slug}
        fundBaseCurrency={fund.baseCurrency as "GBP" | "USD" | "EUR" | "JPY" | "HKD" | "CNY" | "KRW" | "SGD" | "INR" | "TWD"}
      />
    </main>
  );
}
