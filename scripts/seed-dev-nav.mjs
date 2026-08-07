/**
 * DEV ONLY — write a simulated NAV history straight into nav_snapshots.
 *
 * Generating a realistic ledger and replaying it is slow and fiddly; for
 * front-end work all that matters is that the charts have a plausible series to
 * draw. This skips the ledger entirely and fabricates the snapshots.
 *
 * What it produces:
 *   - A fund line as a random walk (slight positive drift, ~12% annualised vol)
 *     so it visibly diverges from the benchmark instead of sitting flat.
 *   - A benchmark line built from the fund's REAL benchmark closes, so the
 *     comparison behaves exactly as it does in production.
 *   - Both anchored at the fund's startingNav on the inception date, which is
 *     what makes the two lines start together at 100,000.
 *
 * It also moves inception to the first date the benchmark actually has prices.
 * A fund whose inceptionDate predates its data starts the chart mid-history,
 * which is why the benchmark appeared to begin below 100k.
 *
 * Safety: refuses unless DB_ENV=dev AND the connection string is the dev
 * project. Run through the guard so .env.local is loaded:
 *
 *   npm run dev:seed-nav
 *
 * Re-running replaces the series rather than stacking up.
 */
import postgres from "postgres";

const DEV_PROJECT_REF = "fndvplaiuobiwdhyrzeg";
const FUND_SLUGS = ["uk-equity", "global-equity"];
const ANNUAL_DRIFT = 0.08; // 8% a year
const ANNUAL_VOL = 0.12; // 12% annualised
const CASH_WEIGHT = 0.04; // 4% of NAV held in cash

const url = process.env.DATABASE_URL ?? "";
if (process.env.DB_ENV !== "dev") {
  console.error("Refusing to run: DB_ENV is not 'dev'.");
  process.exit(1);
}
if (!url.includes(DEV_PROJECT_REF)) {
  console.error("Refusing to run: DATABASE_URL is not the dev project.");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

/** Deterministic PRNG, so re-runs give the same series. */
let seed = 424242;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
/** Box-Muller: uniform -> standard normal. */
const gauss = () => {
  const u = Math.max(rnd(), 1e-9);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

try {
  for (const slug of FUND_SLUGS) {
    const [fund] = await sql`
      select id, slug, starting_nav, benchmark_security_id, inception_date
      from funds where slug = ${slug} limit 1`;
    if (!fund) {
      console.log(`skip ${slug}: not found`);
      continue;
    }
    if (!fund.benchmark_security_id) {
      console.log(`skip ${slug}: no benchmark set (run set-benchmark-proxies)`);
      continue;
    }

    // Real benchmark closes drive both the benchmark line and the date grid.
    const bench = await sql`
      select date, close_price from prices
      where security_id = ${fund.benchmark_security_id}
      order by date asc`;
    if (bench.length < 5) {
      console.log(`skip ${slug}: benchmark has only ${bench.length} price rows`);
      continue;
    }

    // Start where the benchmark data actually starts, so both lines begin
    // together at startingNav rather than the fund appearing mid-history.
    const firstDate = ymd(bench[0].date);
    await sql`update funds set inception_date = ${firstDate} where id = ${fund.id}`;

    await sql`delete from nav_snapshots where fund_id = ${fund.id}`;

    const startingNav = Number(fund.starting_nav);
    const dailyDrift = ANNUAL_DRIFT / 252;
    const dailyVol = ANNUAL_VOL / Math.sqrt(252);

    let nav = startingNav;
    let prevBench = null;
    const rows = [];

    for (let i = 0; i < bench.length; i++) {
      const date = ymd(bench[i].date);
      const benchClose = Number(bench[i].close_price);

      let dailyReturn = null;
      if (i > 0) {
        dailyReturn = dailyDrift + dailyVol * gauss();
        nav = nav * (1 + dailyReturn);
      }

      let benchmarkDailyReturn = null;
      if (prevBench != null && prevBench > 0) {
        benchmarkDailyReturn = benchClose / prevBench - 1;
      }
      prevBench = benchClose;

      const cash = nav * CASH_WEIGHT;
      const positions = nav - cash;

      rows.push({
        fund_id: fund.id,
        date,
        nav: nav.toFixed(6),
        cash_balance: cash.toFixed(6),
        position_value: positions.toFixed(6),
        gross_exposure: positions.toFixed(6),
        net_exposure: positions.toFixed(6),
        daily_return: dailyReturn == null ? null : dailyReturn.toFixed(8),
        benchmark_value: benchClose.toFixed(6),
        benchmark_daily_return:
          benchmarkDailyReturn == null ? null : benchmarkDailyReturn.toFixed(8),
      });
    }

    // Chunked to stay well under the parameter limit.
    for (let i = 0; i < rows.length; i += 200) {
      await sql`insert into nav_snapshots ${sql(rows.slice(i, i + 200))}`;
    }

    const totalReturn = (nav / startingNav - 1) * 100;
    const benchReturn =
      (Number(bench[bench.length - 1].close_price) / Number(bench[0].close_price) - 1) * 100;
    console.log(
      `${slug.padEnd(14)} ${rows.length} days  ${firstDate} -> ${ymd(bench[bench.length - 1].date)}  ` +
        `fund ${totalReturn >= 0 ? "+" : ""}${totalReturn.toFixed(2)}%  bench ${benchReturn >= 0 ? "+" : ""}${benchReturn.toFixed(2)}%`
    );
  }
  console.log("\nDone. Both lines start at startingNav on the inception date.");
} catch (err) {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
