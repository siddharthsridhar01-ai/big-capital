/**
 * Phase 2c — Theses and post-mortems schema.
 *
 * Kept in a separate file so we don't touch the main src/db/schema.ts.
 * Import these into your schema.ts re-export by adding:
 *
 *   export * from "./schema-theses";
 *
 * at the bottom of src/db/schema.ts.
 *
 * Conceptually:
 *  - A Thesis represents an INVESTMENT IDEA. It owns the PDF memo and the
 *    structured metadata (conviction, target weight, holding period).
 *  - A Trade EXECUTES on a thesis. Multiple trades can share a thesis
 *    (e.g. initial buy + later add-on). transactions.thesis_id links them.
 *  - When the position fully closes, a PostMortem documents what happened.
 *    Each thesis has at most one post-mortem.
 */

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
} from "drizzle-orm/pg-core";
import { funds, securities, users } from "./schema";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const convictionEnum = pgEnum("conviction", ["high", "medium", "low"]);

export const holdingPeriodEnum = pgEnum("holding_period", [
  "short", // < 3 months
  "medium", // 3-12 months
  "long", // 1-3 years
  "indefinite",
]);

export const thesisStatusEnum = pgEnum("thesis_status", [
  "active", // position open OR not yet traded — thesis still live
  "closed", // position fully closed, no post-mortem written yet
  "post_mortem", // position closed AND post-mortem written
  "abandoned", // thesis cancelled without ever placing a trade
]);

export const postMortemOutcomeEnum = pgEnum("post_mortem_outcome", [
  "win",
  "loss",
  "break_even",
]);

// ---------------------------------------------------------------------------
// theses table
// ---------------------------------------------------------------------------

export const theses = pgTable("theses", {
  id: uuid("id").primaryKey().defaultRandom(),
  fundId: uuid("fund_id")
    .notNull()
    .references(() => funds.id, { onDelete: "cascade" }),
  securityId: uuid("security_id")
    .notNull()
    .references(() => securities.id),
  authorUserId: uuid("author_user_id")
    .notNull()
    .references(() => users.id),

  // Lifecycle
  openedAt: timestamp("opened_at").notNull().defaultNow(),
  closedAt: timestamp("closed_at"),
  status: thesisStatusEnum("status").notNull().default("active"),

  // Direction (long or short) — null until the first trade links to this
  // thesis. Determined by the side of that first trade.
  direction: text("direction"), // "long" | "short" | null

  // Structured metadata captured at creation
  conviction: convictionEnum("conviction").notNull(),
  targetWeightPct: numeric("target_weight_pct", { precision: 6, scale: 4 }),
  targetPriceNative: numeric("target_price_native", {
    precision: 24,
    scale: 6,
  }),
  holdingPeriod: holdingPeriodEnum("holding_period").notNull(),

  // Short text summary — required, surfaced in lists and thesis review panels
  // Min 50 chars, max 500 chars (enforced at API layer)
  summary: text("summary").notNull(),

  // Optional PDF memo — full investment write-up
  memoBlobUrl: text("memo_blob_url"),
  memoBlobFilename: text("memo_blob_filename"),
  memoSizeBytes: integer("memo_size_bytes"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// post_mortems table
// ---------------------------------------------------------------------------

export const postMortems = pgTable("post_mortems", {
  id: uuid("id").primaryKey().defaultRandom(),
  thesisId: uuid("thesis_id")
    .notNull()
    .references(() => theses.id, { onDelete: "cascade" }),
  authorUserId: uuid("author_user_id")
    .notNull()
    .references(() => users.id),

  writtenAt: timestamp("written_at").notNull().defaultNow(),

  // Outcome assessment
  realisedReturnPct: numeric("realised_return_pct", {
    precision: 8,
    scale: 4,
  }),
  outcome: postMortemOutcomeEnum("outcome").notNull(),

  // Structured reflection — at least one of these must be filled
  whatWorked: text("what_worked"),
  whatDidntWork: text("what_didnt_work"),
  lessonsLearned: text("lessons_learned").notNull(),

  // Optional attached PDF
  attachmentBlobUrl: text("attachment_blob_url"),
  attachmentBlobFilename: text("attachment_blob_filename"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Type exports for use elsewhere
// ---------------------------------------------------------------------------

export type Thesis = typeof theses.$inferSelect;
export type NewThesis = typeof theses.$inferInsert;
export type PostMortem = typeof postMortems.$inferSelect;
export type NewPostMortem = typeof postMortems.$inferInsert;
