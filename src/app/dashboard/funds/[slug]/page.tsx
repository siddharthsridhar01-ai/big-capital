import { db } from "@/db/client";
import {
  funds as fundsTable,
  fundConstraints,
  navSnapshots,
  transactions,
} from "@/db/schema";
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
import NavChart from "@/components/NavChart";
import ExposuresPanel from "@/components/ExposuresPanel";

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

  // Dedupe by constraintType — repeat setup runs accidentally insert
  // duplicate rows. The constraint engine ignores duplicates; the display
  // also shows only one per type. If a hard and soft version exist for the
  // same type, prefer the hard (more restrictive).
  const dedupedConstraints = (() => {
    const map = new Map<string, typeof constraints[number]>();
    for (const c of constraints) {
      const existing = map.get(c.constraintType);
      if (!existing || (c.isHard && !existing.isHard)) {
        map.set(c.constraintType, c);
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      // Hard ones first, then alpha within each group
      if (a.isHard !== b.isHard) return a.isHard ? -1 : 1;
      return a.constraintType.localeCompare(b.constraintType);
    });
  })();

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

  // === NAV chart data points ===
  // Combine:
  //  1. The inception point (£100k at fund.inceptionDate)
  //  2. Daily NAV snapshots from the cron job (when accumulated)
  //  3. NAV at each transaction date (computed from transactions ledger)
  //  4. The live NAV (added by the chart component itself)
  // We don't have rich daily snapshots yet — over time the cron will populate
  // them and this chart will get richer organically.
  const navPoints: { date: string; nav: number; event?: string }[] = [];
  const inceptionStr = String(fund.inceptionDate).slice(0, 10);
  navPoints.push({
    date: inceptionStr,
    nav: startingNav,
    event: "Inception",
  });

  // Pull NAV snapshots (when daily cron has accumulated them)
  const snapshots = await db
    .select({ date: navSnapshots.date, nav: navSnapshots.nav })
    .from(navSnapshots)
    .where(eq(navSnapshots.fundId, fund.id))
    .orderBy(navSnapshots.date);
  for (const s of snapshots) {
    const dateStr = String(s.date).slice(0, 10);
    if (dateStr !== inceptionStr) {
      navPoints.push({ date: dateStr, nav: Number(s.nav) });
    }
  }

  // For dates between inception and today where we have transactions but no
  // NAV snapshot, the NAV at the transaction moment is unchanged by the
  // transaction itself (cash flows into/out of position value at execution
  // price). So we don't need to interpolate trade dates — they're already on
  // the curve. Once daily snapshots fill in, the line gets smoother.

  const fmt = (n: number) =>
    new Intl.NumberFormat("en-GB", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
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
        <Link
          href={`/dashboard/funds/${fund.slug}/universe`}
          style={{
            fontFamily: "system-ui, sans-serif",
            fontSize: 12,
            color: "#00183A",
            textDecoration: "none",
            border: "1px solid #00183A",
            padding: "8px 14px",
            background: "white",
            whiteSpace: "nowrap",
          }}
        >
          Browse universe →
        </Link>
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
          value={String(dedupedConstraints.length)}
          sub={`${dedupedConstraints.filter((c) => c.isHard).length} hard, ${dedupedConstraints.filter((c) => !c.isHard).length} soft`}
        />
        <MetricCard
          label="As of"
          value={latestNav.length > 0 ? latestNav[0].date : "Today"}
          sub={latestNav.length > 0 ? "Latest NAV snapshot" : "Computed live"}
        />
      </div>

      {/* NAV chart since inception */}
      <div style={{ marginBottom: 28 }}>
        <NavChart
          fundName={fund.name}
          fundBaseCurrency={fund.baseCurrency as "GBP" | "USD" | "EUR"}
          startingNav={startingNav}
          inceptionDate={inceptionStr}
          points={navPoints}
          liveNav={liveNavBase}
        />
      </div>

      <ExposuresPanel
        baseCurrency={fund.baseCurrency as "GBP" | "USD" | "EUR"}
        navBase={liveState.navBase.toNumber()}
        positions={Array.from(liveState.positions.values()).map((p) => ({
          securityId: p.securityId,
          ticker: p.ticker,
          name: p.name,
          exchange: p.exchange,
          currency: p.currency,
          gicsSector: p.gicsSector,
          quantity: p.quantity.toNumber(),
          marketValueBase: p.marketValueBase
            ? p.marketValueBase.toNumber()
            : null,
        }))}
        cashByCurrency={
          new Map(
            Array.from(liveState.cashByCurrency.entries()).map(([k, v]) => [
              k,
              v.toNumber(),
            ])
          )
        }
        sectorExposures={
          new Map(
            Array.from(liveState.sectorExposures.entries()).map(([k, v]) => [
              k,
              v.toNumber(),
            ])
          )
        }
        longExposure={liveState.longExposure.toNumber()}
        shortExposure={liveState.shortExposure.toNumber()}
        grossExposure={liveState.grossExposure.toNumber()}
        netExposure={liveState.netExposure.toNumber()}
      />

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
          Fund constraints ({dedupedConstraints.length})
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
                Limit
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
            {dedupedConstraints.map((c) => (
              <tr key={c.id}>
                <td
                  style={{
                    padding: "9px 0",
                    borderBottom: "1px solid rgba(217,217,210,0.4)",
                    color: "#0A0A0A",
                  }}
                >
                  {prettyConstraintLabel(c.constraintType)}
                </td>
                <td
                  style={{
                    padding: "9px 0",
                    borderBottom: "1px solid rgba(217,217,210,0.4)",
                    textAlign: "right",
                    ...numeric,
                    color: "#0A0A0A",
                  }}
                >
                  {prettyConstraintValue(c.constraintType, c.value)}
                </td>
                <td
                  style={{
                    padding: "9px 0",
                    borderBottom: "1px solid rgba(217,217,210,0.4)",
                    textAlign: "right",
                    color: c.isHard ? "#7A1F1F" : "#5A3F08",
                    fontSize: 11,
                    letterSpacing: "0.05em",
                    fontWeight: 600,
                    textTransform: "uppercase",
                  }}
                >
                  {c.isHard ? "Blocked" : "Warning"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Constraint display helpers
// ---------------------------------------------------------------------------

function prettyConstraintLabel(type: string): string {
  const labels: Record<string, string> = {
    universe_only: "Investable universe",
    long_only: "Long-only",
    max_position_pct: "Max position size",
    min_cash_pct: "Min cash holding",
    max_cash_pct: "Max cash holding",
    max_single_sector_pct: "Max single sector",
    max_position_count: "Max position count",
    max_gross_exposure: "Max gross exposure",
    max_net_exposure: "Max net exposure",
  };
  return labels[type] ?? type;
}

function prettyConstraintValue(type: string, value: unknown): string {
  // Boolean toggles → "Enabled"
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  // Position count is an integer (not a ratio)
  if (type === "max_position_count" && typeof value === "number") {
    return `${value} positions`;
  }
  // Gross/net exposure are multiples (1.5x, 0.2x band)
  if (
    (type === "max_gross_exposure" || type === "max_net_exposure") &&
    typeof value === "number"
  ) {
    return `${value.toFixed(2)}×`;
  }
  // All other numeric constraints are percentages (0.08 → 8%)
  if (typeof value === "number") {
    return `${(value * 100).toFixed(2)}%`;
  }
  return String(value);
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
