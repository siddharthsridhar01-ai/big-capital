# BIG Capital — Phase 0 Specification

**Status:** Draft v1 for review
**Author:** Claude, for [you]
**Purpose:** Define the data model, business rules, and conventions that all subsequent build phases will implement. This document is the source of truth. Code follows from here, not the other way around.

---

## 1. The funds

Six funds at launch. Each fund is an independent portfolio with its own PM, analyst team, constraints, NAV, and benchmark. Funds do not invest in each other.

| # | Fund | Base ccy | Universe | Long/Short | Benchmark | Starting NAV |
|---|------|----------|----------|------------|-----------|--------------|
| 1 | BIG Capital UK Equity Fund | GBP | FTSE 350 | Long-only | FTSE All-Share | £100,000 |
| 2 | BIG Capital US Equity Fund | USD | S&P 500 + select mid-caps | Long-only | S&P 500 | $100,000 |
| 3 | BIG Capital Global Equity Fund | USD | MSCI World constituents | Long-only | MSCI World | $100,000 |
| 4 | BIG Capital European Equity Fund | EUR | STOXX Europe 600 ex-UK | Long-only | STOXX Europe 600 ex-UK | €100,000 |
| 5 | BIG Capital Emerging Markets Equity Fund | USD | MSCI EM constituents | Long-only | MSCI EM | $100,000 |
| 6 | BIG Capital Long/Short Equity Fund | USD | MSCI World developed | Long + Short | Cash + risk-free rate (or HFRX Equity Hedge) | $100,000 |

Each fund has an **inception date** (the date the £/$100k is first deployed and the NAV series begins). Performance is computed from inception forward — no backtesting.

---

## 2. Roles and permissions

Four roles, each with clearly bounded permissions:

- **Admin** (you, and successors). Can do everything: create funds, assign PMs, edit constraints, override trades, publish content, manage users.
- **Portfolio Manager (PM).** One PM per fund (can be extended to multiple later). Full discretion within their fund's constraints. Can execute trades, write commentary, view full portfolio and P/L for their fund only.
- **Analyst.** Assigned to one or more funds. Can submit research pitches, view their fund's portfolio read-only, but cannot trade. Pitches are visible to the PM and admin.
- **Public.** Anyone visiting the website. Sees fund pages with the lagged disclosure rules in §7.

Auth provider: Clerk or Supabase Auth (TBD in Phase 1). Role stored as a column on the users table.

---

## 3. Data model

The ledger is **transaction-sourced**. Positions, cash balances, and NAV are *computed* from transactions, not stored as primary state. This is non-negotiable — it's what makes performance calculations correct and gives us audit trail for free.

### Core entities

**`funds`**
- `id`, `name`, `slug`, `base_currency`, `benchmark_ticker`, `inception_date`, `starting_nav`, `strategy_description`, `is_active`

**`users`**
- `id`, `email`, `full_name`, `role` (admin | pm | analyst), `bio`, `headshot_url`, `linkedin_url`, `graduation_year`

**`fund_members`** (many-to-many: users ↔ funds)
- `fund_id`, `user_id`, `role_in_fund` (pm | analyst), `start_date`, `end_date` (null = current)

**`securities`** (the master list of every instrument that's ever been held or is in any investable universe)
- `id`, `ticker`, `exchange`, `name`, `currency`, `security_type` (equity for now), `isin`, `figi`, `is_active`

**`investable_universes`** (per-fund whitelist of what the PM can trade)
- `fund_id`, `security_id`, `added_date`, `removed_date` (null = currently investable)
- Populated initially from index membership, can be manually adjusted by admin

**`transactions`** (the heart of everything)
- `id`, `fund_id`, `security_id` (nullable for cash transactions), `transaction_type` (buy | sell | short | cover | dividend | cash_deposit | fx | corporate_action), `quantity` (negative for sells/shorts), `price`, `currency`, `executed_at` (timestamp), `executed_by_user_id`, `rationale` (text), `notes`
- For cash transactions, `security_id` is null and `quantity` represents the cash amount
- For dividends, recorded as cash credit on ex-date

**`prices`** (daily EOD prices for every held security and benchmark)
- `security_id`, `date`, `close_price`, `currency`, `source` (e.g., 'polygon', 'finnhub')
- Composite primary key on (security_id, date)

**`fx_rates`** (daily EOD FX rates)
- `from_currency`, `to_currency`, `date`, `rate`, `source`
- Used to convert holdings into a fund's base currency

**`fund_constraints`** (per-fund risk rules, JSON or structured)
- `fund_id`, `constraint_type`, `value`, `is_hard` (true = block trade, false = warn only), `created_at`, `created_by`
- Examples of constraint_type:
  - `universe_only` (true/false — must trade from investable_universes)
  - `max_position_pct` (e.g., 0.08 = 8%)
  - `min_cash_pct` (e.g., 0.02)
  - `max_cash_pct` (e.g., 0.20)
  - `long_only` (true/false)
  - `max_gross_exposure` (e.g., 2.0 for 200% gross — L/S only)
  - `max_net_exposure` (e.g., 0.20 for ±20% net — L/S only)
  - `max_single_sector_pct` (e.g., 0.40)
  - `max_position_count` (e.g., 50)

**`commentary`** (PM-written content for the fund page)
- `id`, `fund_id`, `author_user_id`, `title`, `body_markdown`, `period` (e.g., '2026-Q1'), `published_at`, `is_published`

**`pitches`** (analyst research)
- `id`, `fund_id`, `author_user_id`, `ticker`, `title`, `summary`, `body_markdown`, `attachment_url` (PDF deck), `submitted_at`, `status` (draft | submitted | accepted | rejected | implemented), `pm_notes`

**`nav_snapshots`** (daily computed NAV per fund, for performance series)
- `fund_id`, `date`, `nav` (in base currency), `cash_balance`, `position_value`, `gross_exposure`, `net_exposure`
- Composite key on (fund_id, date). Computed nightly by a scheduled job.

### Derived data (computed, not stored as truth)

- **Current positions per fund:** `SUM(quantity)` over transactions grouped by `(fund_id, security_id)`.
- **Cost basis per position:** Weighted-average from buy transactions. Reduced proportionally on sells.
- **Cash balance per fund:** Starting NAV + dividends + sells − buys + FX adjustments.
- **Live NAV:** Cash + Σ(position_qty × current_price × fx_rate).
- **Realised P&L:** From closed positions, computed at sell time.
- **Unrealised P&L:** (current_price − avg_cost) × quantity.

---

## 4. Trade lifecycle

PM has full discretion. No human approval step. But the system enforces constraints at trade time:

1. PM opens trade ticket in the PM interface.
2. PM selects security (typeahead from investable universe; admin can override to allow off-universe with a flag).
3. PM enters quantity and side (buy / sell / short / cover).
4. System fetches **live quote** from the market data API and pre-fills the price. PM can override (e.g., to model a limit price), but the recorded execution price defaults to the live quote.
5. System computes the **post-trade portfolio** and checks every constraint:
   - Hard constraints fail → trade blocked, error shown with reason.
   - Soft constraints fail → warning shown, PM can confirm to proceed.
6. On confirm: a transaction row is written. Position, cash, and NAV instantly reflect the change.
7. PM is required to enter a **rationale** (free text, min 20 chars). This becomes part of the audit trail and feeds quarterly commentary.

No undo. Mistakes get fixed with an offsetting trade and a note. This mirrors real-world execution and teaches the right discipline.

---

## 5. NAV and returns methodology

This is the part most student funds get wrong. We do it properly.

**Daily NAV** is computed once per day after market close, for every fund:
- For each open position: quantity × that day's close price (in the security's native ccy)
- Convert each position's value to fund's base ccy using that day's FX rate
- Sum positions + cash balance = NAV

**Time-Weighted Return (TWR)** is the primary performance measure. It's the industry standard because it removes the distorting effect of cash flows. For a student fund with a fixed starting NAV and no external flows, TWR ≈ simple return, but we implement TWR properly so the methodology is correct if flows are ever added.

For each day:
- daily_return = (NAV_today − NAV_yesterday − external_flow_today) / (NAV_yesterday + external_flow_today)

TWR over a period = product of (1 + daily_return) − 1.

**Reported metrics on the factsheet:**
- 1M, 3M, 6M, YTD, 1Y, 3Y, 5Y, since-inception returns (whichever are available)
- Annualised return for periods ≥ 1Y
- Return vs benchmark (absolute and excess)
- Volatility (annualised stdev of daily returns × √252)
- Sharpe ratio (vs risk-free rate from a published source — e.g., SONIA for GBP, SOFR for USD)
- Max drawdown
- Beta vs benchmark (for the L/S fund especially)

All metrics computed from `nav_snapshots`. Reproducible, testable, auditable.

---

## 6. Corporate actions and edge cases

Handled from day one (they will happen):

- **Cash dividends:** Detected from market data feed. On ex-date, auto-create a `dividend` transaction crediting cash = qty × DPS. Recorded in transactions, so it flows through NAV and returns correctly.
- **Stock splits:** Auto-adjust held quantity and historical prices on ex-date.
- **Spinoffs, mergers, ticker changes:** Manually flagged by admin via a corporate action ticket. Rare; deal with case-by-case.
- **Delistings:** Position marked as worthless if no acquisition; otherwise convert per terms.
- **Holidays and partial trading days:** No NAV computed on local market holidays for fund's base ccy market. Cross-listed positions valued at last available price.

---

## 7. Disclosure rules (internal vs public)

| Data | Internal (PM / admin) | Public website |
|------|------------------------|----------------|
| NAV and daily returns | Live | Updated daily, with 1-day lag |
| Performance metrics vs benchmark | Live | Updated daily |
| Top 10 holdings | Live | Updated monthly, as of last month-end |
| Full holdings | Live | Updated quarterly, as of last quarter-end |
| Individual trades | Live (PM sees own fund) | Never |
| Cash balance % | Live | Shown only as part of monthly top 10 view |
| Sector / geography breakdown | Live | Updated monthly |
| Commentary | Live drafts | Published when PM publishes |
| Pitches | Visible to fund team | Selected pitches publishable by admin |

PMs see everything for their own fund. Admins see everything for all funds. PMs do *not* see other funds' live trades (they see lagged public view only) — this prevents copying and keeps strategies independent.

---

## 8. Tech stack (locked unless you object)

- **Frontend (PM app + public site):** Next.js 15 (App Router), TypeScript, Tailwind, shadcn/ui
- **Backend:** Next.js API routes / Server Actions, plus a small Node worker for scheduled jobs (price fetch, NAV snapshot, dividend ingest)
- **Database:** Postgres via Supabase (free tier sufficient)
- **ORM:** Drizzle (lightweight, TypeScript-first, easier than Prisma to hand over)
- **Auth:** Clerk (simpler hand-off than Supabase Auth)
- **Market data:** TBD between Polygon, Finnhub, Alpha Vantage, and EOD Historical Data based on free-tier limits for the universes we need (esp. UK and EU coverage). I'll evaluate in Phase 1.
- **FX rates:** ECB daily reference rates (free, official)
- **File storage:** Supabase Storage (headshots, pitch PDFs)
- **Hosting:** Vercel
- **Scheduled jobs:** Vercel Cron + a queue table for retries
- **Monitoring:** Sentry (free tier) + email alerts on job failure

Total infra cost target: under $25/month. Should fit in $0 for the first several months.

---

## 9. What's explicitly out of scope (for now)

Calling these out so we don't scope-creep:

- Backtesting historical strategies
- Options, futures, fixed income, FX as instruments (equities only)
- Live broker connectivity (this is paper trading)
- Mobile native apps
- Multi-currency reporting at the firm level (each fund reports in its own base ccy; firm-level AUM is the sum at current FX)
- Complex tax/cost accounting beyond weighted-average cost basis
- Investor accounts or external subscriptions/redemptions
- ESG scoring, factor analysis, attribution analysis beyond benchmark comparison

Some of these (especially attribution and factor analysis) are good Phase 7+ additions once the core is solid.

---

## 10. Operational handover plan

Because student funds turn over every 1–3 years:

- README with full setup steps for a new dev
- Annual "tech handover" doc covering: how to add a fund, how to onboard a new PM, how to rotate API keys, how to recover from a failed price fetch, how to restore from backup
- Daily DB backup to Supabase point-in-time + weekly export to long-term storage
- All secrets in environment variables, documented but not committed
- "Break glass" admin runbook for fixing bad data via SQL when needed

---

## 11. Open questions for you to resolve

1. **Risk-free rate source per currency** — happy with SONIA (GBP) / SOFR (USD) / €STR (EUR)?
2. **L/S fund benchmark** — cash + RFR, or HFRX Equity Hedge index? The HFRX is more "correct" but harder to source freely. I'd default to cash + RFR for simplicity unless you want otherwise.
3. **Pitch publishing** — should accepted analyst pitches be publishable on the website (gives analysts visible CV credit) or kept internal? My recommendation: publishable with PM approval, since the public-facing CV value is a big recruitment tool for the fund.
4. **Sector classification** — GICS is standard but proprietary. ICB (FTSE/Russell) is similar. We can use whichever the market data provider gives us free; flagging because the "sector breakdown" chart depends on this.
5. **Soft vs hard constraints default** — my proposal: `universe_only`, `long_only`, `max_gross_exposure`, `max_net_exposure` are hard. Everything else (position size, cash %, sector concentration) is soft (warning only, PM can override with rationale). Agree?
6. **PM rationale enforcement** — required on every trade (my recommendation), or optional? Required teaches discipline and creates content for commentary.

---

## Next step after sign-off

Once you approve this document (with edits), I move into **Phase 1: Core ledger & pricing.** That phase delivers:
- The Postgres schema as Drizzle migrations
- The market data pipeline (daily price + FX fetch jobs)
- The NAV snapshot job
- A seed dataset with the six funds, their inception, and the investable universes
- A test suite proving NAV and TWR calculations against known examples

No UI yet in Phase 1 — just a correct, tested backend. The PM interface is Phase 2.
