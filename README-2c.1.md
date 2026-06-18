# Phase 2c.1 — Investment Theses

Adds the data layer and UI for investment theses (the rationale layer above trades).

## What's new

**Schema:**
- `theses` table — stores investment ideas (security, conviction, target weight, holding period, summary, optional PDF memo)
- `post_mortems` table — for closing out theses (future, 2c.3)
- `transactions.thesis_id` column — links trades to theses (used in 2c.2)
- Enums: `conviction`, `holding_period`, `thesis_status`, `post_mortem_outcome`

**UI:**
- `/dashboard/funds/[slug]/theses` — list of all theses for a fund
- `/dashboard/funds/[slug]/theses/new` — new thesis form
- "Theses →" button added to fund detail page header

**API:**
- `GET  /api/funds/[slug]/theses` — list (optional ?securityId= filter)
- `POST /api/funds/[slug]/theses` — create (multipart, supports PDF upload)
- `GET  /api/admin/migrate-2c?secret=...` — run schema migration

## After applying

1. Restart `npm run dev` (Next.js will pick up the new routes)
2. Hit `http://localhost:3000/api/admin/migrate-2c?secret=<your-CRON_SECRET>` ONCE
   to create the new tables. Returns JSON with the migration steps it took.
3. Visit any fund page → click "Theses →" in the header → "+ New thesis"
4. Create a test thesis. Should appear in the list.

## Not yet wired (coming in 2c.2 / 2c.3)

- Trade ticket integration (link trades to a thesis on submission)
- Thesis detail page (single thesis view with PDF embed + trade history)
- Post-mortem workflow (write on position close)
- Thesis review surface (show prior theses when trading a name)
