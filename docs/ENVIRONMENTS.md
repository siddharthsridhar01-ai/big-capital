# Environments

## The problem this solves

For the first months of the project, local development and production shared a
single Supabase database. Anything run locally — `drizzle-kit push`, `db:seed`,
or a worker script — wrote directly to live student data. A stray push can drop
columns holding the funds' entire track record, and there is no second copy to
restore from.

## Target setup

| | Database | Set where |
|---|---|---|
| Production | `big-capital` (existing) | Vercel env vars |
| Development | `big-capital-dev` (new) | `.env.local` on your machine |

Vercel keeps its own `DATABASE_URL`; nothing about the deployed app changes.
Only your laptop is repointed.

## One-time setup

1. **Create the dev database.** Supabase dashboard → New project, e.g.
   `big-capital-dev`, free tier. Any region. Save the database password.

2. **Copy its connection string.** Project Settings → Database → Connection
   string → URI. Use the **pooled** connection (port 6543) to match production.

3. **Point `.env.local` at it.** Replace `DATABASE_URL` with the dev URL, and add:

   ```
   DB_ENV=dev
   ```

   Keep the production URL somewhere safe — you will occasionally need it for
   one-off admin work, though prefer the admin HTTP routes for that.

4. **Create the schema.**

   ```
   npm run db:push
   ```

   Use `push`, not `migrate`. The files in `drizzle/` stop at `0002`; every
   schema change since then was applied through the ad-hoc `/api/admin/migrate-*`
   routes, so the migration history no longer describes the real schema.
   `drizzle-kit push` syncs the database directly from `src/db/schema.ts`, which
   is authoritative.

5. **Seed the funds and benchmarks.**

   ```
   npm run db:seed
   ```

   Then populate the investable universe by calling the seed routes against a
   locally running app (`npm run dev`), e.g. `/api/admin/seed-uk-universe`.

## The guard

`scripts/db-guard.mjs` runs before `db:push`, `db:migrate` and `db:seed`. It
refuses unless `DB_ENV=dev`, so a mistyped command cannot reach production.

To deliberately target production (rare — prefer the admin HTTP routes):

```powershell
$env:ALLOW_PROD_DB=1; npm run db:push
```

Vercel never runs these scripts, so production deploys are unaffected.

## Still shared

- **Clerk** — one instance covers both. Clerk supports separate dev/prod
  instances; worth splitting if local auth testing starts affecting real users.
- **Yahoo Finance** — read-only, no isolation needed.

## Keeping migrations honest

The `drizzle/` folder is stale. Going forward, prefer `npm run db:generate` to
produce a migration file for each schema change, rather than adding another
`/api/admin/migrate-*` route. That keeps a fresh database reproducible from the
repository alone.
