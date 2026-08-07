import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // BOTH schema files. The thesis tables (theses, thesis_updates,
  // thesis_post_mortems) live in schema-theses.ts, so listing only schema.ts
  // meant `drizzle-kit push` built 20 of the 23 tables and a fresh database
  // failed at runtime with: relation "theses" does not exist. Production only
  // has them because /api/admin/migrate-2c created them with raw SQL.
  schema: ["./src/db/schema.ts", "./src/db/schema-theses.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
