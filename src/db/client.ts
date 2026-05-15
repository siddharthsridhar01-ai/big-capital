/**
 * Shared Drizzle DB client. Pools connections appropriately for
 * serverless (Vercel) vs long-running worker contexts.
 *
 * Vercel functions are short-lived but reused across invocations within a
 * warm container, so we reuse a single postgres client per process.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  pgClient?: ReturnType<typeof postgres>;
};

function makeClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  return postgres(url, {
    max: process.env.NODE_ENV === "production" ? 5 : 1,
    idle_timeout: 30,
    connect_timeout: 10,
  });
}

const client = globalForDb.pgClient ?? makeClient();
if (process.env.NODE_ENV !== "production") {
  globalForDb.pgClient = client;
}

export const db = drizzle(client, { schema });
export { schema };
export type Db = typeof db;
