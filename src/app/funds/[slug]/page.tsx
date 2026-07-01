import { db } from "@/db/client";
import { funds as fundsTable, securities, navSnapshots, monthlyBriefings, publicHoldingsSnapshots } from "@/db/schema";
import { eq, asc, and, desc } from "drizzle-orm";
import { notFound } from "next/navigation";
import Link from "next/link";
import { serif, numeric } from "@/lib/typography";
import type { HoldingsSnapshotPayload } from "@/lib/holdings-reconstruction";
import {
  computeFundPerformance,
  pctLabel,
  SnapshotRow,
} from "@/lib/public-performance";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Format a signed weight fraction as a percentage, e.g. 0.054 -> "5.4%", -0.03 -> "−3.0%". */
function pctWeight(weight: number): string {
  const pct = weight * 100;
  const sign = pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

export default async function PublicFundPage({ params }: PageProps) {
  const { slug } = await params;

  const fundRows = await db
    .select({
      id: fundsTable.id,
      name: fundsTable.name,
      slug: fundsTable.slug,
      baseCurrency: fundsTable.baseCurrency,
      strategyDescription: fundsTable.strategyDescription,
      inceptionDate: fundsTable.inceptionDate,
      benchmarkSecurityId: fundsTable.benchmarkSecurityId,
    })
    .from(fundsTable)
    .where(eq(fundsTable.slug, slug))
    .limit(1);
  if (fundRows.length === 0) notFound();
  const fund = fundRows[0];

  let benchmarkName: string | null = null;
  if (fund.benchmarkSecurityId) {
    const b = await db
      .select({ name: securities.name, ticker: securities.ticker })
      .from(securities)
      .where(eq(securities.id, fund.benchmarkSecurityId))
      .limit(1);
    benchmarkName = b[0]?.name ?? b[0]?.ticker ?? null;
  }

  const snapRows = await db
    .select({
      date: navSnapshots.date,
      dailyReturn: navSnapshots.dailyReturn,
      benchmarkDailyReturn: navSnapshots.benchmarkDailyReturn,
    })
    .from(navSnapshots)
    .where(eq(navSnapshots.fundId, fund.id))
    .orderBy(asc(navSnapshots.date));

  const snaps: SnapshotRow[] = snapRows.map((s) => ({
    date: s.date,
    dailyReturn: s.dailyReturn,
    benchmarkDailyReturn: s.benchmarkDailyReturn,
  }));
  const perf = computeFundPerformance(snaps, fund.inceptionDate);
  const asOf = snaps.length > 0 ? snaps[snaps.length - 1].date : null;

  // Latest published monthly letter (public). Drafts are never read here.
  const letterRows = await db
    .select({
      period: monthlyBriefings.period,
      title: monthlyBriefings.title,
      macroSection: monthlyBriefings.macroSection,
    })
    .from(monthlyBriefings)
    .where(
      and(
        eq(monthlyBriefings.fundId, fund.id),
        eq(monthlyBriefings.status, "published")
      )
    )
    .orderBy(desc(monthlyBriefings.period))
    .limit(1);
  const latestLetter = letterRows[0] ?? null;
  const letterTeaser = latestLetter
    ? latestLetter.macroSection.length > 160
      ? latestLetter.macroSection.slice(0, 160).trimEnd() + "…"
      : latestLetter.macroSection
    : null;

  // Public holdings disclosure (read ONLY the lagged snapshots, never live positions).
  const top10Rows = await db
    .select({ asOfDate: publicHoldingsSnapshots.asOfDate, holdings: publicHoldingsSnapshots.holdings })
    .from(publicHoldingsSnapshots)
    .where(
      and(
        eq(publicHoldingsSnapshots.fundId, fund.id),
        eq(publicHoldingsSnapshots.disclosureType, "top10")
      )
    )
    .orderBy(desc(publicHoldingsSnapshots.asOfDate))
    .limit(1);
  const fullRows = await db
    .select({ asOfDate: publicHoldingsSnapshots.asOfDate, holdings: publicHoldingsSnapshots.holdings })
    .from(publicHoldingsSnapshots)
    .where(
      and(
        eq(publicHoldingsSnapshots.fundId, fund.id),
        eq(publicHoldingsSnapshots.disclosureType, "full")
      )
    )
    .orderBy(desc(publicHoldingsSnapshots.asOfDate))
    .limit(1);

  const top10 = top10Rows[0]
    ? { asOf: top10Rows[0].asOfDate, payload: top10Rows[0].holdings as HoldingsSnapshotPayload }
    : null;
  const full = fullRows[0]
    ? { asOf: fullRows[0].asOfDate, payload: fullRows[0].holdings as HoldingsSnapshotPayload }
    : null;

  const anyValuedAtCost = top10?.payload.holdings.some((h) => h.valuedAtCost) ?? false;
  const topConcentration =
    top10?.payload.holdings.reduce((acc, h) => acc + (h.weight > 0 ? h.weight : 0), 0) ?? 0;

  // Sector allocation. Prefer the full (quarterly) snapshot; if it has no
  // holdings yet, fall back to the top-10 snapshot ONLY when it is complete
  // (otherCount === 0), so we never build a sector chart from truncated data.
  const sectorSource =
    full && full.payload.holdings.length > 0
      ? { holdings: full.payload.holdings, cashWeight: full.payload.cashWeight, asOf: full.asOf }
      : top10 && top10.payload.otherCount === 0 && top10.payload.holdings.length > 0
        ? { holdings: top10.payload.holdings, cashWeight: top10.payload.cashWeight, asOf: top10.asOf }
        : null;

  const sectorAllocation = sectorSource
    ? (() => {
        const bySector = new Map<string, number>();
        for (const h of sectorSource.holdings) {
          const key = h.sector ?? "Unclassified";
          bySector.set(key, (bySector.get(key) ?? 0) + Math.abs(h.weight));
        }
        const rows = Array.from(bySector.entries())
          .map(([sector, weight]) => ({ sector, weight }))
          .sort((a, b) => b.weight - a.weight);
        const maxWeight = rows.length > 0 ? Math.max(rows[0].weight, sectorSource.cashWeight) : 1;
        return { rows, maxWeight, cashWeight: sectorSource.cashWeight, asOf: sectorSource.asOf };
      })()
    : null;

  const returnValue = perf.isAnnualised ? perf.annualisedReturn : perf.cumulativeReturn;
  const returnColor =
    returnValue == null ? "#9A9A8E" : returnValue >= 0 ? "#1F5C3A" : "#7A1F1F";
  const excessColor =
    perf.excess == null ? "#9A9A8E" : perf.excess >= 0 ? "#1F5C3A" : "#7A1F1F";

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "32px 32px 0" }}>
      {/* Hero */}
      <div style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "#9A9A8E", marginBottom: 6 }}>
        {fund.baseCurrency} · Inception {fmtDate(fund.inceptionDate)}
      </div>
      <h1 style={{ ...serif, fontSize: 30, color: "#00183A", margin: "0 0 8px", fontWeight: 400, letterSpacing: "-0.01em" }}>
        {fund.name}
      </h1>
      <p style={{ fontSize: 14, color: "#444", lineHeight: 1.6, maxWidth: 600, margin: "0 0 22px", fontFamily: "system-ui, sans-serif" }}>
        {fund.strategyDescription ??
          "A research-led equity strategy, paper-traded by the society's analysts."}
      </p>

      {/* Stats strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0,1fr))", gap: 1, background: "#E5E5DE", border: "1px solid #E5E5DE" }}>
        <Stat
          label={perf.isAnnualised ? "Return p.a." : "Return"}
          value={pctLabel(returnValue)}
          valueColor={returnColor}
          sub={perf.isAnnualised ? "annualised" : "since inception"}
        />
        <Stat
          label="Benchmark"
          value={pctLabel(perf.benchmarkCumulative)}
          sub={benchmarkName ?? "since inception"}
        />
        <Stat
          label="Excess"
          value={pctLabel(perf.excess)}
          valueColor={excessColor}
          sub="vs benchmark"
        />
        <Stat
          label="Volatility"
          value={perf.annualisedVol && perf.annualisedVol > 0 ? pctLabel(perf.annualisedVol, false) : "—"}
          sub="annualised"
        />
        <Stat
          label="Sharpe"
          value={perf.sharpe != null ? perf.sharpe.toFixed(2) : "—"}
          sub={perf.isAnnualised ? "annualised" : "needs 1 yr"}
        />
        <Stat label="Holdings" value="—" sub="disclosed on lag" />
      </div>

      {/* Performance chart */}
      <div style={{ marginTop: 22 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <span style={{ fontSize: 12, color: "#6B6B66", fontFamily: "system-ui, sans-serif" }}>
            Cumulative return since inception · paper NAV
          </span>
          {perf.benchmarkSeries.length > 0 ? (
            <span style={{ fontSize: 11, color: "#9A9A8E", fontFamily: "system-ui, sans-serif" }}>
              <span style={{ color: "#00183A" }}>■</span> Fund &nbsp;
              <span style={{ color: "#9A9A8E" }}>■</span> {benchmarkName ?? "Benchmark"}
            </span>
          ) : null}
        </div>
        <PerformanceChart
          fund={perf.fundSeries.map((p) => p.pct)}
          benchmark={perf.benchmarkSeries.map((p) => p.pct)}
        />
        {asOf ? (
          <div style={{ fontSize: 10, color: "#9A9A8E", marginTop: 6, fontFamily: "system-ui, sans-serif" }}>
            As at {fmtDate(asOf)}
          </div>
        ) : null}
      </div>

      {/* Lower section: holdings + letter (placeholders until later workstreams) */}
      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 1, background: "#E5E5DE", border: "1px solid #E5E5DE", marginTop: 26 }}>
        <div style={{ background: "white", padding: "18px 22px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
            <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9A9A8E" }}>
              Top holdings
            </span>
            {top10 ? (
              <span style={{ fontSize: 10, color: "#9A9A8E" }}>as at {fmtDate(top10.asOf)}</span>
            ) : null}
          </div>

          {top10 ? (
            <>
              <div style={{ fontSize: 13, color: "#0A0A0A", fontFamily: "system-ui, sans-serif" }}>
                {top10.payload.holdings.map((h, i) => (
                  <div
                    key={h.securityId}
                    style={{ display: "grid", gridTemplateColumns: "16px 1fr auto", gap: 8, padding: "6px 0", borderBottom: "1px solid #ECEBE4" }}
                  >
                    <span style={{ color: "#9A9A8E" }}>{i + 1}</span>
                    <span>
                      {h.name}
                      {h.sector ? <span style={{ color: "#9A9A8E", fontSize: 11 }}> · {h.sector}</span> : null}
                      {h.valuedAtCost ? <span style={{ color: "#8A6D1F" }}> *</span> : null}
                    </span>
                    <span style={{ textAlign: "right", ...numeric, color: h.weight < 0 ? "#7A1F1F" : "#00183A" }}>
                      {pctWeight(h.weight)}
                    </span>
                  </div>
                ))}
                {top10.payload.otherCount > 0 ? (
                  <div style={{ display: "grid", gridTemplateColumns: "16px 1fr auto", gap: 8, padding: "6px 0", borderBottom: "1px solid #ECEBE4", color: "#6B6B66" }}>
                    <span />
                    <span>Other holdings ({top10.payload.otherCount})</span>
                    <span style={{ textAlign: "right", ...numeric }}>{pctWeight(top10.payload.otherWeight)}</span>
                  </div>
                ) : null}
                <div style={{ display: "grid", gridTemplateColumns: "16px 1fr auto", gap: 8, padding: "6px 0", color: "#6B6B66" }}>
                  <span />
                  <span>Cash</span>
                  <span style={{ textAlign: "right", ...numeric }}>{pctWeight(top10.payload.cashWeight)}</span>
                </div>
              </div>
              {anyValuedAtCost ? (
                <div style={{ fontSize: 10, color: "#8A6D1F", marginTop: 8, lineHeight: 1.5 }}>
                  * Valued at cost — awaiting market price data.
                </div>
              ) : null}
              <div style={{ fontSize: 10, color: "#9A9A8E", marginTop: 8, lineHeight: 1.5 }}>
                Top holdings disclosed monthly, full holdings quarterly, each in arrears. Weights as a percentage of NAV.
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 13, color: "#6B6B66", lineHeight: 1.6, fontFamily: "system-ui, sans-serif" }}>
                Lagged holdings disclosure is not yet published for this fund.
              </div>
              <div style={{ fontSize: 10, color: "#9A9A8E", marginTop: 10, lineHeight: 1.5 }}>
                Top holdings will be disclosed monthly and full holdings quarterly,
                each in arrears.
              </div>
            </>
          )}
        </div>
        <div style={{ background: "white", padding: "18px 22px" }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9A9A8E", marginBottom: 10 }}>
            Latest letter
          </div>
          {latestLetter ? (
            <Link
              href={`/funds/${fund.slug}/letters/${latestLetter.period}`}
              style={{ textDecoration: "none", display: "block" }}
            >
              <div style={{ ...serif, fontSize: 15, color: "#00183A", marginBottom: 6 }}>
                {latestLetter.title}
              </div>
              <div style={{ fontSize: 12.5, color: "#444", lineHeight: 1.6, fontFamily: "system-ui, sans-serif" }}>
                {letterTeaser}
              </div>
              <div style={{ fontSize: 12, color: "#00183A", marginTop: 8, borderBottom: "1px solid #00183A", display: "inline-block" }}>
                Read the letter →
              </div>
            </Link>
          ) : (
            <div style={{ fontSize: 13, color: "#6B6B66", lineHeight: 1.6, fontFamily: "system-ui, sans-serif" }}>
              No monthly commentary has been published yet.
            </div>
          )}
        </div>
      </div>

      {(sectorAllocation && sectorAllocation.rows.length > 0) || top10 ? (
        <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 1, background: "#E5E5DE", border: "1px solid #E5E5DE", marginTop: 1 }}>
          {/* Sector allocation (from the full, quarterly snapshot) */}
          <div style={{ background: "white", padding: "18px 22px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9A9A8E" }}>
                Sector allocation
              </span>
              {sectorAllocation ? <span style={{ fontSize: 10, color: "#9A9A8E" }}>as at {fmtDate(sectorAllocation.asOf)}</span> : null}
            </div>
            {sectorAllocation && sectorAllocation.rows.length > 0 ? (
              <div style={{ fontSize: 12, fontFamily: "system-ui, sans-serif" }}>
                {sectorAllocation.rows.map((r) => (
                  <div key={r.sector} style={{ display: "grid", gridTemplateColumns: "128px 1fr 44px", gap: 8, alignItems: "center", marginBottom: 7 }}>
                    <span style={{ color: "#0A0A0A" }}>{r.sector}</span>
                    <span style={{ background: "#EFEEE8", borderRadius: 2 }}>
                      <span style={{ display: "block", height: 8, width: `${Math.max(2, (r.weight / sectorAllocation.maxWeight) * 100)}%`, background: "#00183A", borderRadius: 2 }} />
                    </span>
                    <span style={{ textAlign: "right", ...numeric, color: "#00183A" }}>{pctWeight(r.weight)}</span>
                  </div>
                ))}
                <div style={{ display: "grid", gridTemplateColumns: "128px 1fr 44px", gap: 8, alignItems: "center", marginTop: 4 }}>
                  <span style={{ color: "#6B6B66" }}>Cash</span>
                  <span style={{ background: "#EFEEE8", borderRadius: 2 }}>
                    <span style={{ display: "block", height: 8, width: `${Math.max(2, (sectorAllocation.cashWeight / sectorAllocation.maxWeight) * 100)}%`, background: "#9A9A8E", borderRadius: 2 }} />
                  </span>
                  <span style={{ textAlign: "right", ...numeric, color: "#6B6B66" }}>{pctWeight(sectorAllocation.cashWeight)}</span>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "#6B6B66", lineHeight: 1.6, fontFamily: "system-ui, sans-serif" }}>
                Full holdings are disclosed quarterly. Sector breakdown appears once the first quarter-end is published.
              </div>
            )}
          </div>

          {/* Characteristics */}
          <div style={{ background: "white", padding: "18px 22px" }}>
            <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9A9A8E", marginBottom: 12 }}>
              Characteristics
            </div>
            {top10 ? (
              <div style={{ fontSize: 13, fontFamily: "system-ui, sans-serif" }}>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #ECEBE4" }}>
                  <span style={{ color: "#6B6B66" }}>Holdings</span>
                  <span style={numeric}>{top10.payload.totalHoldings}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #ECEBE4" }}>
                  <span style={{ color: "#6B6B66" }}>Top 10 concentration</span>
                  <span style={numeric}>{pctWeight(topConcentration)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
                  <span style={{ color: "#6B6B66" }}>Invested / Cash</span>
                  <span style={numeric}>
                    {pctWeight(1 - top10.payload.cashWeight)} / {pctWeight(top10.payload.cashWeight)}
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "#6B6B66", lineHeight: 1.6, fontFamily: "system-ui, sans-serif" }}>
                Published alongside holdings disclosure.
              </div>
            )}
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Stat({
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
    <div style={{ background: "white", padding: "12px 14px", minWidth: 0 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "#9A9A8E", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </div>
      <div style={{ ...numeric, fontSize: 19, color: valueColor, marginTop: 4 }}>{value}</div>
      <div style={{ fontSize: 10, color: "#9A9A8E", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {sub}
      </div>
    </div>
  );
}

/**
 * Server-rendered SVG line chart of cumulative-return series (%). No client
 * JS — fast, SEO-friendly, and avoids the empty-container chart warning.
 */
function PerformanceChart({
  fund,
  benchmark,
}: {
  fund: number[];
  benchmark: number[];
}) {
  const W = 920;
  const H = 200;
  const pad = { top: 14, right: 8, bottom: 18, left: 8 };

  if (fund.length < 2) {
    return (
      <div
        style={{
          border: "1px solid #E5E5DE",
          background: "white",
          padding: "28px 22px",
          fontSize: 13,
          color: "#6B6B66",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
        }}
      >
        The performance chart will appear as daily data accumulates.
      </div>
    );
  }

  const all = [...fund, ...benchmark, 0];
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const range = max - min;
  min -= range * 0.08;
  max += range * 0.08;

  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const x = (i: number, n: number) =>
    pad.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v: number) => pad.top + (1 - (v - min) / (max - min)) * plotH;
  const toPoints = (s: number[]) => s.map((v, i) => `${x(i, s.length).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const zeroY = y(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", border: "1px solid #E5E5DE", background: "white" }} role="img" aria-label="Cumulative return since inception">
      {/* zero baseline */}
      <line x1={pad.left} y1={zeroY} x2={W - pad.right} y2={zeroY} stroke="#E5E5DE" strokeWidth="1" />
      <text x={pad.left + 2} y={zeroY - 4} fontSize="10" fill="#9A9A8E" fontFamily="system-ui">0%</text>
      <text x={pad.left + 2} y={pad.top + 8} fontSize="10" fill="#9A9A8E" fontFamily="system-ui">{max.toFixed(1)}%</text>
      {benchmark.length > 1 ? (
        <polyline fill="none" stroke="#9A9A8E" strokeWidth="1.5" points={toPoints(benchmark)} />
      ) : null}
      <polyline fill="none" stroke="#00183A" strokeWidth="2" points={toPoints(fund)} />
    </svg>
  );
}
