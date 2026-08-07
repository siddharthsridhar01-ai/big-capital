/**
 * Shared Drizzle DB client. Pools connections appropriately for
 * serverless (Vercel) vs long-running worker contexts.
 *
 * Vercel functions are short-lived but reused across invocations within a
 * warm container, so we reuse a single postgres client per process.
 *
 * IMPORTANT: client creation is lazy. The DATABASE_URL is read only when the
 * client is first used, not at module load time. This lets the project build
 * in environments where the env var isn't set (e.g. CI build steps).
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  pgClient?: ReturnType<typeof postgres>;
  drizzleDb?: ReturnType<typeof drizzle<typeof schema>>;
};

function getClient() {
  if (globalForDb.pgClient) return globalForDb.pgClient;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const client = postgres(url, {
    // Dev used to be capped at 1 connection, which serialised every query on a
    // page and could deadlock: any code path holding the single connection while
    // awaiting another query waits on itself forever. Invisible while the dev
    // database was empty. 5 matches production.
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  if (process.env.NODE_ENV !== "production") {
    globalForDb.pgClient = client;
  }
  return client;
}

// Proxy that lazily creates the Drizzle client on first use
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    if (!globalForDb.drizzleDb) {
      globalForDb.drizzleDb = drizzle(getClient(), { schema });
    }
    return Reflect.get(globalForDb.drizzleDb, prop);
  },
});

export { schema };
export type Db = ReturnType<typeof drizzle<typeof schema>>;
