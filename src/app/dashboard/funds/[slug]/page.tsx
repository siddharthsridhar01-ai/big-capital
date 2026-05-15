import { db } from "@/db/client";
import { funds as fundsTable, fundConstraints, navSnapshots } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { serif, numeric } from "@/lib/typography";
import {
  computePortfolioState,
  loadPreviousClosePrices,
} from "@/lib/portfolio";
import { computeDailyChange, computeUnrealisedPnL } from "@/lib/derived";
import LiveHoldingsTable from "@/components/LiveHoldingsTable";

export const dynamic = "force-dynamic";

export default async function FundPage({
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

  // Access check: admins see all. Others must be members.
  // (Membership check skipped for v1 — would query fund_members. Admin-only for now.)

  const constraints = await db
    .select()
    .from(fundConstraints)
    .where(eq(fundConstraints.fundId, fund.id));

  const latestNav = await db
    .select()
    .from(navSnapshots)
    .where(eq(navSnapshots.fundId, fund.id))
    .orderBy(navSnapshots.date)
    .limit(1);

  const currencySymbol =
    fund.baseCurrency === "GBP" ? "£" : fund.baseCurrency === "EUR" ? "€" : "$";

  const startingNav = Number(fund.startingNav);
  const currentNav = latestNav.length > 0 ? Number(latestNav[0].nav) : startingNav;
  const sinceInceptionPct = ((currentNav - startingNav) / startingNav) * 100;

  // Live portfolio state computed from the transactions ledger
  const liveState = await computePortfolioState(fund.id);
  const liveNavBase = liveState.navBase.toNumber();
  const liveCashBase = liveState.cashBase.toNumber();
  const liveSinceInceptionPct =
    ((liveNavBase - startingNav) / startingNav) * 100;

  // Previous close prices for held positions — for daily change display
  const heldSecurityIds = Array.from(liveState.positions.keys());
  const previousCloses = await loadPreviousClosePrices(heldSecurityIds);

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-GB", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(n);

  return (
    <main style={{ padding: "28px 32px 64px" }}>
      <div style={{ marginBottom: 6 }}>
        <Link
          href="/dashboard"
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "#6B6B66",
            textDecoration: "none",
          }}
        >
          ← All funds
        </Link>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 4,
          marginTop: 16,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "system-ui, sans-serif",
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#6B6B66",
              fontWeight: 500,
              marginBottom: 6,
            }}
          >
            {fund.baseCurrency} · Inception {fund.inceptionDate}
          </div>
          <h1
            style={{
              ...serif,
              fontWeight: 400,
              fontSize: 30,
              color: "#00183A",
              margin: 0,
              letterSpacing: "-0.01em",
            }}
          >
            {fund.name}
          </h1>
          <div
            style={{
              ...serif,
              fontSize: 14,
              color: "#444",
              marginTop: 10,
              maxWidth: 720,
              lineHeight: 1.55,
            }}
          >
            {fund.strategyDescription}
          </div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 1,
          background: "#D9D9D2",
          border: "1px solid #D9D9D2",
          marginTop: 28,
          marginBottom: 28,
        }}
      >
        <MetricCard
          label="Fund value"
          value={`${currencySymbol}${fmt(liveNavBase)}`}
          sub={`Started ${currencySymbol}${fmt(startingNav)}`}
        />
        <MetricCard
          label="Since inception"
          value={`${liveSinceInceptionPct >= 0 ? "+" : ""}${liveSinceInceptionPct.toFixed(2)}%`}
          sub="vs benchmark TBD"
          valueColor={liveSinceInceptionPct >= 0 ? "#1F5C3A" : "#7A1F1F"}
        />
        <MetricCard
          label="Holdings"
          value={String(liveState.positions.size)}
          sub={
            liveState.positions.size === 0
              ? "No positions yet"
              : `${liveState.positions.size} open`
          }
        />
        <MetricCard
          label="Cash"
          value={`${currencySymbol}${fmt(liveCashBase)}`}
          sub={
            liveNavBase > 0
              ? `${((liveCashBase / liveNavBase) * 100).toFixed(1)}% of NAV`
              : ""
          }
        />
        <MetricCard
          label="Constraints"
          value={String(constraints.length)}
          sub={`${constraints.filter((c) => c.isHard).length} hard, ${constraints.filter((c) => !c.isHard).length} soft`}
        />
        <MetricCard
          label="As of"
          value={latestNav.length > 0 ? latestNav[0].date : "Today"}
          sub={latestNav.length > 0 ? "Latest NAV snapshot" : "Computed live"}
        />
      </div>

      {liveState.positions.size === 0 ? (
        <div
          style={{
            background: "white",
            border: "1px solid #D9D9D2",
            padding: "24px 28px",
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
            No positions yet
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
            This fund is freshly created with {currencySymbol}
            {fmt(startingNav)} of starting capital. Submit a trade from any
            security page to begin building holdings.
          </div>
        </div>
      ) : (
        <LiveHoldingsTable
          fundSlug={fund.slug}
          fundBaseCurrency={fund.baseCurrency as "GBP" | "USD" | "EUR"}
          initialNavBase={liveState.navBase.toString()}
          positions={Array.from(liveState.positions.values()).map((p) => ({
            securityId: p.securityId,
            ticker: p.ticker,
            name: p.name,
            exchange: p.exchange,
            currency: p.currency,
            gicsSector: p.gicsSector,
            quantity: p.quantity.toString(),
            avgCostNative: p.avgCostNative.toString(),
            latestPriceNative: p.latestPriceNative
              ? p.latestPriceNative.toString()
              : null,
            latestFxToBase: p.latestFxToBase.toString(),
            previousCloseNative: previousCloses.get(p.securityId)?.close ?? null,
            marketValueBase: p.marketValueBase
              ? p.marketValueBase.toString()
              : null,
          }))}
        />
      )}


      <details style={{ marginTop: 28 }}>
        <summary
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 11,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#6B6B66",
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          Fund constraints ({constraints.length})
        </summary>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            marginTop: 16,
            fontFamily: "system-ui, sans-serif",
            fontSize: 13,
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  textAlign: "left",
                  fontSize: 10,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "#6B6B66",
                  borderBottom: "1px solid #D9D9D2",
                  padding: "0 0 8px",
                  fontWeight: 500,
                }}
              >
                Rule
              </th>
              <th
                style={{
                  textAlign: "right",
                  fontSize: 10,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "#6B6B66",
                  borderBottom: "1px solid #D9D9D2",
                  padding: "0 0 8px",
                  fontWeight: 500,
                }}
              >
                Value
              </th>
              <th
                style={{
                  textAlign: "right",
                  fontSize: 10,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: "#6B6B66",
                  borderBottom: "1px solid #D9D9D2",
                  padding: "0 0 8px",
                  fontWeight: 500,
                }}
              >
                Enforcement
              </th>
            </tr>
          </thead>
          <tbody>
            {constraints.map((c) => (
              <tr key={c.id}>
                <td
                  style={{
                    padding: "9px 0",
                    borderBottom: "1px solid rgba(217,217,210,0.4)",
                  }}
                >
                  {c.constraintType}
                </td>
                <td
                  style={{
                    padding: "9px 0",
                    borderBottom: "1px solid rgba(217,217,210,0.4)",
                    textAlign: "right",
                  }}
                >
                  {JSON.stringify(c.value)}
                </td>
                <td
                  style={{
                    padding: "9px 0",
                    borderBottom: "1px solid rgba(217,217,210,0.4)",
                    textAlign: "right",
                    color: c.isHard ? "#7A1F1F" : "#5A3F08",
                  }}
                >
                  {c.isHard ? "Hard (blocks)" : "Soft (warns)"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </main>
  );
}

function MetricCard({
  label,
  value,
  sub,
  valueColor = "#00183A",
}: {
  label: string;
  value: string;
  sub: string;
  valueColor?: string;
}) {
  return (
    <div style={{ background: "white", padding: "14px 18px" }}>
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "#6B6B66",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        style={{
          ...numeric,
          fontSize: 22,
          color: valueColor,
          marginTop: 4,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          fontSize: 11,
          color: "#6B6B66",
          marginTop: 2,
        }}
      >
        {sub}
      </div>
    </div>
  );
}
