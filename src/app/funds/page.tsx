import { db } from "@/db/client";
import { funds as fundsTable, navSnapshots } from "@/db/schema";
import { asc } from "drizzle-orm";
import Link from "next/link";
import { serif, numeric } from "@/lib/typography";
import { computeFundPerformance, pctLabel, SnapshotRow } from "@/lib/public-performance";

export const dynamic = "force-dynamic";

export default async function PublicFundsIndex() {
  const funds = await db
    .select({
      id: fundsTable.id,
      name: fundsTable.name,
      slug: fundsTable.slug,
      baseCurrency: fundsTable.baseCurrency,
      strategyDescription: fundsTable.strategyDescription,
      inceptionDate: fundsTable.inceptionDate,
    })
    .from(fundsTable)
    .orderBy(asc(fundsTable.name));

  // One snapshots query, grouped by fund, to show a since-inception return.
  const allSnaps = await db
    .select({
      fundId: navSnapshots.fundId,
      date: navSnapshots.date,
      dailyReturn: navSnapshots.dailyReturn,
      benchmarkDailyReturn: navSnapshots.benchmarkDailyReturn,
    })
    .from(navSnapshots)
    .orderBy(asc(navSnapshots.date));

  const byFund = new Map<string, SnapshotRow[]>();
  for (const s of allSnaps) {
    const arr = byFund.get(s.fundId) ?? [];
    arr.push({
      date: s.date,
      dailyReturn: s.dailyReturn,
      benchmarkDailyReturn: s.benchmarkDailyReturn,
    });
    byFund.set(s.fundId, arr);
  }

  return (
    <main style={{ maxWidth: 920, margin: "0 auto", padding: "36px 32px 0" }}>
      <h1 style={{ ...serif, fontSize: 30, color: "#00183A", margin: "0 0 8px", fontWeight: 400 }}>
        Our funds
      </h1>
      <p
        style={{
          fontSize: 14,
          color: "#444",
          lineHeight: 1.6,
          maxWidth: 600,
          marginBottom: 28,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        Six paper-traded equity strategies, each managed by society analysts
        under a formal thesis-and-review process.
      </p>

      <div style={{ display: "grid", gap: 1, background: "#E5E5DE", border: "1px solid #E5E5DE" }}>
        {funds.map((f) => {
          const perf = computeFundPerformance(
            byFund.get(f.id) ?? [],
            f.inceptionDate
          );
          const ret = perf.cumulativeReturn;
          const retColor = ret == null ? "#9A9A8E" : ret >= 0 ? "#1F5C3A" : "#7A1F1F";
          return (
            <Link
              key={f.id}
              href={`/funds/${f.slug}`}
              style={{ textDecoration: "none", background: "white", display: "block" }}
            >
              <div
                style={{
                  padding: "18px 22px",
                  display: "flex",
                  alignItems: "center",
                  gap: 18,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ ...serif, fontSize: 18, color: "#00183A", marginBottom: 3 }}>
                    {f.name}
                  </div>
                  <div
                    style={{
                      fontSize: 12.5,
                      color: "#6B6B66",
                      lineHeight: 1.5,
                      fontFamily: "system-ui, sans-serif",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {f.strategyDescription ?? `${f.baseCurrency} equity strategy`}
                  </div>
                </div>
                <div style={{ textAlign: "right", flex: "0 0 auto" }}>
                  <div style={{ ...numeric, fontSize: 18, color: retColor }}>
                    {pctLabel(ret)}
                  </div>
                  <div style={{ fontSize: 10, color: "#9A9A8E", marginTop: 2 }}>
                    since inception
                  </div>
                </div>
                <span style={{ color: "#C8C8C0", fontSize: 18 }}>›</span>
              </div>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
