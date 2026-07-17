/**
 * BIG Capital — Database Schema
 *
 * Transaction-sourced ledger. Positions, cash balances, and NAV are
 * COMPUTED from transactions, not stored as primary state.
 *
 * See docs/phase-0-spec.md for the full design document.
 */

import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  date,
  numeric,
  integer,
  boolean,
  jsonb,
  pgEnum,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum("user_role", ["admin", "pm", "analyst"]);

export const fundMemberRoleEnum = pgEnum("fund_member_role", ["pm", "senior_analyst", "analyst"]);

export const currencyEnum = pgEnum("currency", ["GBP", "USD", "EUR", "JPY", "HKD", "CNY", "KRW", "SGD", "INR", "TWD"]);

export const securityTypeEnum = pgEnum("security_type", [
  "equity",
  // future: etf, adr, etc.
]);

export const transactionTypeEnum = pgEnum("transaction_type", [
  "buy",
  "sell",
  "short",
  "cover",
  "dividend",
  "cash_deposit",
  "fx_adjustment",
  "corporate_action",
]);

export const memoStatusEnum = pgEnum("memo_status", [
  "draft",
  "submitted",
  "under_review",
  "accepted",
  "rejected",
  "implemented",
]);

export const memoRecommendationEnum = pgEnum("memo_recommendation", [
  "buy",
  "sell",
  "short",
  "hold",
]);

export const postMortemOutcomeEnum = pgEnum("post_mortem_outcome", [
  "thesis_played_out",
  "thesis_partially_played_out",
  "thesis_failed",
  "stopped_out",
  "macro_driven",
]);

export const briefingStatusEnum = pgEnum("briefing_status", [
  "draft",
  "published",
]);

// ---------------------------------------------------------------------------
// Users and access
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  fullName: text("full_name").notNull(),
  role: userRoleEnum("role").notNull(),
  bio: text("bio"),
  headshotUrl: text("headshot_url"),
  linkedinUrl: text("linkedin_url"),
  graduationYear: integer("graduation_year"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Funds
// ---------------------------------------------------------------------------

export const funds = pgTable("funds", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  baseCurrency: currencyEnum("base_currency").notNull(),
  benchmarkSecurityId: uuid("benchmark_security_id"), // FK added after securities table
  strategyDescription: text("strategy_description"),
  inceptionDate: date("inception_date").notNull(),
  startingNav: numeric("starting_nav", { precision: 20, scale: 4 }).notNull(),

  // Per-trade fee modelling, in basis points. 5 bps = 0.05% of notional value
  // deducted from cash on every trade. Lets us model trading costs realistically.
  tradingFeesBps: integer("trading_fees_bps").notNull().default(5),

  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Many-to-many: users ↔ funds
export const fundMembers = pgTable(
  "fund_members",
  {
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleInFund: fundMemberRoleEnum("role_in_fund").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"), // null = currently active
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fundId, t.userId, t.startDate] }),
    fundIdx: index("fund_members_fund_idx").on(t.fundId),
    userIdx: index("fund_members_user_idx").on(t.userId),
  })
);

// ---------------------------------------------------------------------------
// Securities, prices, FX
// ---------------------------------------------------------------------------

export const securities = pgTable(
  "securities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticker: text("ticker").notNull(),
    exchange: text("exchange").notNull(),
    name: text("name").notNull(),
    currency: currencyEnum("currency").notNull(),
    securityType: securityTypeEnum("security_type").notNull().default("equity"),
    isin: text("isin"),
    figi: text("figi"),
    gicsSector: text("gics_sector"),
    gicsIndustryGroup: text("gics_industry_group"),
    gicsIndustry: text("gics_industry"),
    gicsSubIndustry: text("gics_sub_industry"),
    isBenchmark: boolean("is_benchmark").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    tickerExchangeIdx: uniqueIndex("securities_ticker_exchange_idx").on(
      t.ticker,
      t.exchange
    ),
    isinIdx: index("securities_isin_idx").on(t.isin),
  })
);

// Per-fund whitelist of tradeable securities
export const investableUniverses = pgTable(
  "investable_universes",
  {
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "cascade" }),
    securityId: uuid("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "cascade" }),
    addedDate: date("added_date").notNull(),
    removedDate: date("removed_date"), // null = currently in universe
    addedByUserId: uuid("added_by_user_id").references(() => users.id),
    notes: text("notes"),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fundId, t.securityId, t.addedDate] }),
    fundActiveIdx: index("investable_universe_fund_active_idx").on(
      t.fundId,
      t.removedDate
    ),
  })
);

// Daily EOD prices for every held security and benchmark
export const prices = pgTable(
  "prices",
  {
    securityId: uuid("security_id")
      .notNull()
      .references(() => securities.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    closePrice: numeric("close_price", { precision: 20, scale: 6 }).notNull(),
    currency: currencyEnum("currency").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.securityId, t.date] }),
    dateIdx: index("prices_date_idx").on(t.date),
  })
);

// Daily EOD FX rates (ECB reference rates)
export const fxRates = pgTable(
  "fx_rates",
  {
    fromCurrency: currencyEnum("from_currency").notNull(),
    toCurrency: currencyEnum("to_currency").notNull(),
    date: date("date").notNull(),
    rate: numeric("rate", { precision: 20, scale: 8 }).notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fromCurrency, t.toCurrency, t.date] }),
  })
);

// Risk-free rates per currency (for Sharpe etc.)
export const riskFreeRates = pgTable(
  "risk_free_rates",
  {
    currency: currencyEnum("currency").notNull(),
    date: date("date").notNull(),
    annualRate: numeric("annual_rate", { precision: 10, scale: 6 }).notNull(),
    source: text("source").notNull(), // 'SONIA' | 'SOFR' | 'ESTR'
  },
  (t) => ({
    pk: primaryKey({ columns: [t.currency, t.date] }),
  })
);

// ---------------------------------------------------------------------------
// Fund constraints (per-fund risk rules)
// ---------------------------------------------------------------------------

export const fundConstraints = pgTable(
  "fund_constraints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "cascade" }),
    constraintType: text("constraint_type").notNull(),
    // Examples: universe_only, max_position_pct, min_cash_pct, max_cash_pct,
    // long_only, max_gross_exposure, max_net_exposure, max_single_sector_pct,
    // max_position_count
    value: jsonb("value").notNull(), // flexible: number, boolean, or struct
    isHard: boolean("is_hard").notNull(), // hard = block trade, soft = warn
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
  },
  (t) => ({
    fundIdx: index("fund_constraints_fund_idx").on(t.fundId),
  })
);

// ---------------------------------------------------------------------------
// Investment memos (analyst pitches)
// ---------------------------------------------------------------------------

export const investmentMemos = pgTable(
  "investment_memos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id),
    securityId: uuid("security_id").references(() => securities.id),
    title: text("title").notNull(),
    recommendation: memoRecommendationEnum("recommendation").notNull(),
    targetPrice: numeric("target_price", { precision: 20, scale: 6 }),
    targetCurrency: currencyEnum("target_currency"),
    timeHorizonMonths: integer("time_horizon_months"),
    summary: text("summary").notNull(),
    bodyMarkdown: text("body_markdown").notNull(),
    attachmentUrl: text("attachment_url"), // PDF deck
    status: memoStatusEnum("status").notNull().default("draft"),
    pmNotes: text("pm_notes"),
    submittedAt: timestamp("submitted_at"),
    decidedAt: timestamp("decided_at"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    fundIdx: index("memos_fund_idx").on(t.fundId),
    statusIdx: index("memos_status_idx").on(t.status),
    securityIdx: index("memos_security_idx").on(t.securityId),
  })
);

// ---------------------------------------------------------------------------
// Transactions — the heart of the ledger
// ---------------------------------------------------------------------------

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "restrict" }),
    securityId: uuid("security_id").references(() => securities.id), // null for cash-only txns
    transactionType: transactionTypeEnum("transaction_type").notNull(),

    // Quantity convention:
    //   buy:    positive (shares acquired)
    //   sell:   negative (shares disposed)
    //   short:  negative (shares short = negative position)
    //   cover:  positive (closing short)
    //   dividend: positive (cash credit)
    //   cash_deposit: positive
    //   fx_adjustment: signed
    quantity: numeric("quantity", { precision: 24, scale: 8 }).notNull(),

    // Per-share price for equity txns; for cash txns this is 1
    price: numeric("price", { precision: 20, scale: 6 }).notNull(),
    currency: currencyEnum("currency").notNull(),

    // Total cash impact in security's native currency (signed):
    //   buy:  -quantity * price
    //   sell: -quantity * price (quantity is negative, so this is +ve cash)
    //   dividend: +quantity (already signed correctly)
    // Stored explicitly so we don't recompute and risk drift.
    cashImpact: numeric("cash_impact", { precision: 24, scale: 6 }).notNull(),

    // FX rate to fund's base currency at execution time, for reporting
    fxRateToBase: numeric("fx_rate_to_base", { precision: 20, scale: 8 }).notNull(),

    executedAt: timestamp("executed_at").notNull(),
    // For now equal to executedAt; reserved for a future two-state order model
    // where orders are submitted and then execute at a later time (e.g. T+1 close).
    submittedAt: timestamp("submitted_at").notNull(),
    executedByUserId: uuid("executed_by_user_id")
      .notNull()
      .references(() => users.id),

    // Trading fee modelling (in fund's base currency). Default 0, set per-trade
    // from fund.tradingFeesBps * |notional|. Cash impact already accounts for this.
    feeAmount: numeric("fee_amount", { precision: 20, scale: 6 }).notNull().default("0"),

    rationale: text("rationale").notNull(), // required, min 20 chars enforced in app
    memoId: uuid("memo_id").references(() => investmentMemos.id), // link to investment thesis
    // Link to a Phase 2c thesis (theses.id). The DB column + FK
    // (ON DELETE SET NULL) and index are created by /api/admin/migrate-2c.
    // Deliberately NOT using .references(() => theses.id) here: theses lives
    // in schema-theses.ts which imports funds/securities/users from this file,
    // so a reference back would create a circular import. The FK is already
    // enforced at the database level by the migration.
    thesisId: uuid("thesis_id"),
    notes: text("notes"),

    // Soft-constraint overrides at trade time, if any
    overriddenConstraints: jsonb("overridden_constraints"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    fundExecutedIdx: index("transactions_fund_executed_idx").on(
      t.fundId,
      t.executedAt
    ),
    fundSecurityIdx: index("transactions_fund_security_idx").on(
      t.fundId,
      t.securityId
    ),
    memoIdx: index("transactions_memo_idx").on(t.memoId),
    thesisIdx: index("transactions_thesis_idx").on(t.thesisId),
  })
);

// ---------------------------------------------------------------------------
// Trade attachments — PDF memos uploaded with trades
// ---------------------------------------------------------------------------

/**
 * Files attached to a transaction at submit time. v1 supports PDF only.
 * Storage URL points to Vercel Blob; the URL is "public" only in the sense
 * that the Blob is accessible by URL — in practice the app gates downloads
 * by checking auth on /api/funds/[slug]/trades/[id]/memo.
 */
export const tradeAttachments = pgTable(
  "trade_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    storageUrl: text("storage_url").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => ({
    txnIdx: index("trade_attachments_txn_idx").on(t.transactionId),
  })
);

// ---------------------------------------------------------------------------
// Pending orders — queued trades awaiting the next close (next-close execution)
// ---------------------------------------------------------------------------

/**
 * An order a PM has submitted that has NOT yet executed. Under the next-close
 * execution model every order queues here first and is filled at the next
 * official close by the fill job — which books it into `transactions`. Kept
 * separate from the ledger because a pending order is an intention, not a fact.
 * Captures everything the fill job needs to execute later (side, size,
 * rationale, thesis link, any soft-breach justification).
 */
export const pendingOrders = pgTable(
  "pending_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "cascade" }),
    securityId: uuid("security_id")
      .notNull()
      .references(() => securities.id),
    side: transactionTypeEnum("side").notNull(), // buy | sell | short | cover
    quantity: numeric("quantity", { precision: 24, scale: 8 }).notNull(), // unsigned magnitude
    submittedByUserId: uuid("submitted_by_user_id")
      .notNull()
      .references(() => users.id),
    submittedAt: timestamp("submitted_at").notNull().defaultNow(),
    rationale: text("rationale").notNull(),
    thesisId: uuid("thesis_id"),
    updateNote: text("update_note"),
    softOverrideJustification: text("soft_override_justification"),
    // pending | filled | cancelled | rejected
    status: text("status").notNull().default("pending"),
    filledTransactionId: uuid("filled_transaction_id"),
    fillPrice: numeric("fill_price", { precision: 20, scale: 6 }),
    rejectionReason: text("rejection_reason"),
    resolvedAt: timestamp("resolved_at"), // filled/cancelled/rejected time
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    fundStatusIdx: index("pending_orders_fund_status_idx").on(t.fundId, t.status),
    statusIdx: index("pending_orders_status_idx").on(t.status),
  })
);

// ---------------------------------------------------------------------------
// Positions and post-mortems (lifecycle: opened → ... → closed)
// ---------------------------------------------------------------------------

/**
 * A position represents the lifecycle of holding a security in a fund.
 * Opened when qty goes from 0 to non-zero; closed when qty returns to 0.
 * A new position is opened if the security is bought again later.
 *
 * This is computed/maintained from transactions but materialised here so
 * we can attach post-mortems and track position-level history cleanly.
 */
export const positions = pgTable(
  "positions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "cascade" }),
    securityId: uuid("security_id")
      .notNull()
      .references(() => securities.id),
    openedAt: timestamp("opened_at").notNull(),
    closedAt: timestamp("closed_at"), // null = currently open
    openingMemoId: uuid("opening_memo_id").references(() => investmentMemos.id),
    side: text("side").notNull(), // 'long' | 'short'
    realisedPnlBase: numeric("realised_pnl_base", { precision: 24, scale: 6 }), // populated on close
  },
  (t) => ({
    fundOpenIdx: index("positions_fund_open_idx").on(t.fundId, t.closedAt),
    fundSecurityIdx: index("positions_fund_security_idx").on(
      t.fundId,
      t.securityId
    ),
  })
);

export const postMortems = pgTable(
  "post_mortems",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    positionId: uuid("position_id")
      .notNull()
      .references(() => positions.id, { onDelete: "cascade" })
      .unique(),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id),
    originalThesis: text("original_thesis").notNull(),
    whatPlayedOut: text("what_played_out").notNull(),
    whatDidnt: text("what_didnt").notNull(),
    lessonsLearned: text("lessons_learned").notNull(),
    outcome: postMortemOutcomeEnum("outcome").notNull(),
    realisedPnlBase: numeric("realised_pnl_base", { precision: 24, scale: 6 }).notNull(),
    holdingPeriodDays: integer("holding_period_days").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  }
);

// ---------------------------------------------------------------------------
// NAV snapshots — computed daily
// ---------------------------------------------------------------------------

export const navSnapshots = pgTable(
  "nav_snapshots",
  {
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    nav: numeric("nav", { precision: 24, scale: 6 }).notNull(), // in fund base ccy
    cashBalance: numeric("cash_balance", { precision: 24, scale: 6 }).notNull(),
    positionValue: numeric("position_value", { precision: 24, scale: 6 }).notNull(),
    grossExposure: numeric("gross_exposure", { precision: 24, scale: 6 }).notNull(),
    netExposure: numeric("net_exposure", { precision: 24, scale: 6 }).notNull(),
    dailyReturn: numeric("daily_return", { precision: 12, scale: 8 }), // null on inception day
    benchmarkValue: numeric("benchmark_value", { precision: 24, scale: 6 }),
    benchmarkDailyReturn: numeric("benchmark_daily_return", { precision: 12, scale: 8 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.fundId, t.date] }),
    dateIdx: index("nav_snapshots_date_idx").on(t.date),
  })
);

// ---------------------------------------------------------------------------
// Public-facing content
// ---------------------------------------------------------------------------

/**
 * Monthly briefings — PM-written, public-facing fund letters.
 * Style reference: J O Hambro UK Equity Income monthly factsheet commentary.
 * Covers: macro view, new additions, performance commentary.
 */
export const monthlyBriefings = pgTable(
  "monthly_briefings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id),
    period: varchar("period", { length: 7 }).notNull(), // 'YYYY-MM'
    title: text("title").notNull(),
    macroSection: text("macro_section").notNull(),
    portfolioActivitySection: text("portfolio_activity_section").notNull(),
    performanceCommentarySection: text("performance_commentary_section").notNull(),
    outlookSection: text("outlook_section"),
    status: briefingStatusEnum("status").notNull().default("draft"),
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    fundPeriodIdx: uniqueIndex("briefings_fund_period_idx").on(t.fundId, t.period),
  })
);

// ---------------------------------------------------------------------------
// Public disclosure snapshots — what the website serves
// ---------------------------------------------------------------------------

/**
 * Lagged public-facing holdings snapshots.
 * - top10: refreshed monthly (1st of month, showing prior month-end)
 * - full:  refreshed quarterly (1st of quarter, showing prior quarter-end)
 *
 * Pre-computed so the public site is fast and never accidentally exposes live data.
 */
export const publicHoldingsSnapshots = pgTable(
  "public_holdings_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "cascade" }),
    asOfDate: date("as_of_date").notNull(),
    disclosureType: text("disclosure_type").notNull(), // 'top10' | 'full'
    holdings: jsonb("holdings").notNull(), // array of { securityId, ticker, name, weight, sector }
    publishedAt: timestamp("published_at").notNull().defaultNow(),
  },
  (t) => ({
    fundDateTypeIdx: uniqueIndex("public_holdings_fund_date_type_idx").on(
      t.fundId,
      t.asOfDate,
      t.disclosureType
    ),
  })
);

// ---------------------------------------------------------------------------
// Audit log (separately from app activity for compliance & teaching)
// ---------------------------------------------------------------------------

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  fundId: uuid("fund_id").references(() => funds.id),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  details: jsonb("details"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Relations (for query ergonomics with Drizzle)
// ---------------------------------------------------------------------------

export const fundsRelations = relations(funds, ({ many, one }) => ({
  members: many(fundMembers),
  constraints: many(fundConstraints),
  transactions: many(transactions),
  positions: many(positions),
  memos: many(investmentMemos),
  briefings: many(monthlyBriefings),
  navSnapshots: many(navSnapshots),
  benchmark: one(securities, {
    fields: [funds.benchmarkSecurityId],
    references: [securities.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  fundMemberships: many(fundMembers),
  memos: many(investmentMemos),
  transactions: many(transactions),
  briefings: many(monthlyBriefings),
}));

export const fundMembersRelations = relations(fundMembers, ({ one }) => ({
  fund: one(funds, { fields: [fundMembers.fundId], references: [funds.id] }),
  user: one(users, { fields: [fundMembers.userId], references: [users.id] }),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  fund: one(funds, { fields: [transactions.fundId], references: [funds.id] }),
  security: one(securities, {
    fields: [transactions.securityId],
    references: [securities.id],
  }),
  executedBy: one(users, {
    fields: [transactions.executedByUserId],
    references: [users.id],
  }),
  memo: one(investmentMemos, {
    fields: [transactions.memoId],
    references: [investmentMemos.id],
  }),
}));

export const positionsRelations = relations(positions, ({ one }) => ({
  fund: one(funds, { fields: [positions.fundId], references: [funds.id] }),
  security: one(securities, {
    fields: [positions.securityId],
    references: [securities.id],
  }),
  openingMemo: one(investmentMemos, {
    fields: [positions.openingMemoId],
    references: [investmentMemos.id],
  }),
  postMortem: one(postMortems, {
    fields: [positions.id],
    references: [postMortems.positionId],
  }),
}));

export const investmentMemosRelations = relations(
  investmentMemos,
  ({ one, many }) => ({
    fund: one(funds, {
      fields: [investmentMemos.fundId],
      references: [funds.id],
    }),
    author: one(users, {
      fields: [investmentMemos.authorUserId],
      references: [users.id],
    }),
    security: one(securities, {
      fields: [investmentMemos.securityId],
      references: [securities.id],
    }),
    transactions: many(transactions),
  })
);

// ---------------------------------------------------------------------------
// Job runs — telemetry for scheduled/manual jobs (crons, ingests).
// Recorded so failures surface on the admin health page instead of silently.
// ---------------------------------------------------------------------------
export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobName: text("job_name").notNull(), // e.g. "nightly", "prices", "fx"
    status: text("status").notNull(), // "ok" | "partial" | "error"
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at").notNull(),
    durationMs: integer("duration_ms").notNull(),
    summary: jsonb("summary"), // per-job result counts
    error: text("error"), // populated on partial/error
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    jobStartedIdx: index("job_runs_job_started_idx").on(t.jobName, t.startedAt),
  })
);
