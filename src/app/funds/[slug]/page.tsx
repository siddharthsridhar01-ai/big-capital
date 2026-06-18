import { db } from "@/db/client";
import { funds as fundsTable, securities, navSnapshots } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { notFound } from "next/navigation";
import { serif, numeric } from "@/lib/typography";
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
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9A9A8E", marginBottom: 10 }}>
            Top holdings
          </div>
          <div style={{ fontSize: 13, color: "#6B6B66", lineHeight: 1.6, fontFamily: "system-ui, sans-serif" }}>
            Lagged holdings disclosure is not yet published for this fund.
          </div>
          <div style={{ fontSize: 10, color: "#9A9A8E", marginTop: 10, lineHeight: 1.5 }}>
            Top holdings will be disclosed monthly and full holdings quarterly,
            each in arrears.
          </div>
        </div>
        <div style={{ background: "white", padding: "18px 22px" }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "#9A9A8E", marginBottom: 10 }}>
            Latest letter
          </div>
          <div style={{ fontSize: 13, color: "#6B6B66", lineHeight: 1.6, fontFamily: "system-ui, sans-serif" }}>
            No monthly commentary has been published yet.
          </div>
        </div>
      </div>
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
