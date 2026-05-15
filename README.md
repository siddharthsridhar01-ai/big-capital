# BIG Capital

Student-run fund management platform: live paper-traded portfolios across six equity strategies, with PM trading workflows, analyst research memos, post-mortems, monthly briefings, and a public-facing factsheet website.

## Project Status

**Phase 1: Core ledger & performance engine — COMPLETE**
**Phase 1b: Market data pipeline — COMPLETE (tested, awaiting deployment)**

What's done:
- Full database schema (`src/db/schema.ts`)
- Performance calculation engine (`src/lib/performance.ts`) — TWR, NAV, volatility, Sharpe, max DD, beta
- Constraints engine (`src/lib/constraints.ts`)
- Seed data for six funds with their default constraints (`src/db/seed.ts`)
- EODHD market data client (`src/lib/eodhd.ts`) — typed, retry, schema-validated
- ECB FX rates client (`src/lib/ecb-fx.ts`) — cross-rate expansion, EUR-based
- Three scheduled workers (`src/workers/`) — fetch-fx, fetch-prices, compute-nav
- Vercel cron configuration (`vercel.json`) with API routes
- Auth-protected cron endpoints (`src/app/api/cron/`)
- Project scaffold (Next.js 15, Drizzle, Vitest, TypeScript strict)
- **42 tests passing across performance, EODHD, ECB FX**
- Design system locked (`docs/design-system.md`) — factsheet + PM dashboard mockups approved

What's next:
- Provision Supabase Postgres + run migrations + seed
- Sign up for EODHD (apply 50% academic discount) + add token to env
- Phase 2: PM trade interface (the dashboard)
- Phase 3: Public website with fund pages and factsheets
- Phase 4: Memo/post-mortem/briefing workflows

## Architecture summary

- **Transaction-sourced ledger.** Positions, cash balances, and NAV are computed from the `transactions` table, never stored as primary state.
- **Six funds, three currencies (GBP/USD/EUR).** Each fund holds in its base currency; FX is applied at trade time and at NAV computation.
- **Constraints are data, not code.** Per-fund constraints (universe, max position, gross/net exposure, etc.) are configured in the database and evaluated at trade time.
- **Time-Weighted Return** is the performance methodology, computed daily and chained.
- **Public site lags internal data:** performance daily, top 10 monthly, full holdings quarterly. Trades and PM rationales never public.

See `docs/phase-0-spec.md` for the full design document.

## Setup

```bash
# Install deps
pnpm install

# Set up environment
cp .env.example .env
# Edit .env to point DATABASE_URL at a Postgres instance (Supabase free tier works)

# Run migrations
pnpm db:generate
pnpm db:migrate

# Seed initial data
pnpm db:seed

# Run tests
pnpm test
```

## Tech stack

- **Frontend:** Next.js 15 (App Router), TypeScript strict, Tailwind
- **Backend:** Next.js Server Actions / API routes
- **Database:** Postgres (Supabase)
- **ORM:** Drizzle
- **Auth:** Clerk
- **Decimal math:** decimal.js (no floating-point currency!)
- **Tests:** Vitest
- **Market data:** TBD — evaluating Polygon, Finnhub, Alpha Vantage, EOD Historical Data
- **FX:** ECB daily reference rates
- **Hosting:** Vercel

## The funds

| Fund | Base ccy | Universe | Benchmark |
|------|----------|----------|-----------|
| BIG Capital UK Equity Fund | GBP | FTSE 350 | FTSE All-Share |
| BIG Capital US Equity Fund | USD | S&P 500 + select mid-caps | S&P 500 |
| BIG Capital Global Equity Fund | USD | MSCI World | MSCI World |
| BIG Capital European Equity Fund | EUR | STOXX Europe 600 ex-UK | STOXX Europe 600 ex-UK |
| BIG Capital Emerging Markets Equity Fund | USD | MSCI EM | MSCI EM |
| BIG Capital Long/Short Equity Fund | USD | MSCI World | Cash + SOFR |

All funds start with 100,000 units of their base currency on inception.

## License

Proprietary — BIG Capital and contributors.
