/**
 * DEV ONLY — generate a plausible trade history for the UK Equity Fund.
 *
 * An empty ledger makes the dev environment useless for testing anything that
 * matters: NAV, performance, exposures, holdings disclosure, reconciliation.
 * This fabricates a believable set of trades so those screens have something to
 * render.
 *
 * Safety: refuses to run unless DB_ENV=dev AND the connection string points at
 * the dev Supabase project. Run it through the guard so .env.local is loaded:
 *
 *   npm run dev:seed-trades
 *
 * Ordering matters — prices must exist before trades can be priced:
 *   1. npm run dev                                    (start the app)
 *   2. GET /api/admin/seed-uk-universe?secret=...     (securities)
 *   3. GET /api/admin/backfill-prices?secret=...      (price history)
 *   4. npm run dev:seed-trades                        (this script)
 *   5. GET /api/admin/reconstruct-holdings?secret=... (positions)
 *   6. GET /api/admin/compute-nav?from=<inception>&secret=...
 *
 * Idempotent-ish: it deletes any trades it previously created for the fund
 * before inserting, so re-running gives a fresh history rather than stacking up.
 */
import postgres from "postgres";

const DEV_PROJECT_REF = "fndvplaiuobiwdhyrzeg";
const FUND_SLUG = "uk-equity";
const TRADE_COUNT = 14;
const SEED_USER_EMAIL = "dev-seed@big-capital.local";

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

/** Deterministic PRNG so re-runs produce the same history. */
let seed = 20260807;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

try {
  const [fund] = await sql`
    select id, slug, base_currency, inception_date, starting_nav, trading_fees_bps
    from funds where slug = ${FUND_SLUG} limit 1`;
  if (!fund) throw new Error(`Fund '${FUND_SLUG}' not found — run npm run db:seed first.`);

  // A user is required: transactions.executed_by_user_id is NOT NULL.
  let [user] = await sql`select id from users where email = ${SEED_USER_EMAIL} limit 1`;
  if (!user) {
    [user] = await sql`
      insert into users (email, full_name, role)
      values (${SEED_USER_EMAIL}, 'Dev Seed', 'admin')
      returning id`;
    console.log("created dev seed user");
  }

  // Only trade securities that actually have priced history, so every trade can
  // be struck at a real close.
  const candidates = await sql`
    select s.id, s.ticker, s.currency, count(p.date)::int as price_days,
           min(p.date) as first_date, max(p.date) as last_date
    from securities s
    join prices p on p.security_id = s.id
    where s.is_benchmark = false and s.currency = 'GBP'
    group by s.id, s.ticker, s.currency
    having count(p.date) > 20
    order by count(p.date) desc
    limit 25`;

  if (candidates.length < 4) {
    throw new Error(
      `Only ${candidates.length} priced GBP securities found. Run seed-uk-universe and backfill-prices first.`
    );
  }
  console.log(`${candidates.length} priced securities available`);

  // Clear anything this script created before, so re-runs are clean.
  const deleted = await sql`
    delete from transactions
    where fund_id = ${fund.id} and executed_by_user_id = ${user.id}
    returning id`;
  if (deleted.length) console.log(`removed ${deleted.length} previously seeded trades`);

  const feeBps = Number(fund.trading_fees_bps ?? 5);
  const startingNav = Number(fund.starting_nav);
  // postgres.js returns date columns as JS Date objects, not strings.
  const inceptionStr =
    fund.inception_date instanceof Date
      ? fund.inception_date.toISOString().slice(0, 10)
      : String(fund.inception_date).slice(0, 10);

  // Spread trades across the fund's life, skipping weekends.
  const windowStart = new Date(`${inceptionStr}T00:00:00Z`);
  const windowEnd = new Date();
  const spanDays = Math.max(
    30,
    Math.floor((windowEnd - windowStart) / 86400000) - 2
  );

  const held = new Map(); // securityId -> { ticker, qty }
  const rows = [];

  for (let i = 0; i < TRADE_COUNT; i++) {
    // Push each trade a little further through the window.
    const dayOffset = Math.floor((spanDays * (i + 1)) / (TRADE_COUNT + 1));
    const when = new Date(windowStart.getTime() + dayOffset * 86400000);
    while (when.getUTCDay() === 0 || when.getUTCDay() === 6) {
      when.setUTCDate(when.getUTCDate() + 1);
    }
    const dateStr = when.toISOString().slice(0, 10);

    // Sell roughly a third of the time once we hold something.
    const heldList = [...held.entries()].filter(([, h]) => h.qty > 0);
    const doSell = heldList.length > 0 && rnd() < 0.35;

    const secId = doSell ? pick(heldList)[0] : pick(candidates).id;
    const sec = candidates.find((c) => c.id === secId);
    if (!sec) continue;

    const [priceRow] = await sql`
      select close_price, currency from prices
      where security_id = ${secId} and date <= ${dateStr}
      order by date desc limit 1`;
    if (!priceRow) continue;

    const price = Number(priceRow.close_price);
    if (!Number.isFinite(price) || price <= 0) continue;

    let qty;
    if (doSell) {
      const cur = held.get(secId).qty;
      qty = -Math.max(1, Math.floor(cur * (rnd() < 0.5 ? 0.5 : 1))); // half or full exit
    } else {
      // Target 2–6% of starting NAV per position.
      const target = startingNav * (0.02 + rnd() * 0.04);
      qty = Math.max(1, Math.floor(target / price));
    }

    const notional = Math.abs(qty) * price;
    const fee = (notional * feeBps) / 10000;
    // buy: cash out (negative). sell: qty is negative, so -qty*price is positive.
    const cashImpact = -qty * price - fee;

    rows.push({
      fund_id: fund.id,
      security_id: secId,
      transaction_type: doSell ? "sell" : "buy",
      quantity: qty.toFixed(8),
      price: price.toFixed(6),
      currency: priceRow.currency,
      cash_impact: cashImpact.toFixed(6),
      fx_rate_to_base: "1.00000000",
      executed_at: new Date(`${dateStr}T15:30:00Z`),
      submitted_at: new Date(`${dateStr}T15:30:00Z`),
      executed_by_user_id: user.id,
      fee_amount: fee.toFixed(6),
      rationale: doSell
        ? `Dev seed: trimming ${sec.ticker} to rebalance the book after a run-up.`
        : `Dev seed: initiating ${sec.ticker} on a valuation and quality screen.`,
    });

    const prev = held.get(secId)?.qty ?? 0;
    held.set(secId, { ticker: sec.ticker, qty: prev + qty });
    console.log(
      `  ${dateStr}  ${doSell ? "SELL" : "BUY "} ${String(Math.abs(qty)).padStart(5)} ${sec.ticker.padEnd(6)} @ ${price.toFixed(2)}`
    );
  }

  if (rows.length === 0) throw new Error("No trades generated — check price history exists.");
  await sql`insert into transactions ${sql(rows)}`;

  const open = [...held.values()].filter((h) => h.qty > 0);
  console.log(`\ninserted ${rows.length} trades; ${open.length} open positions:`);
  for (const h of open) console.log(`   ${h.ticker}  ${h.qty}`);
  console.log(`\nNext: /api/admin/reconstruct-holdings then /api/admin/compute-nav?from=${inceptionStr}`);
} catch (err) {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
