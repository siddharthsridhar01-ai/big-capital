CREATE TYPE "public"."briefing_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TYPE "public"."currency" AS ENUM('GBP', 'USD', 'EUR');--> statement-breakpoint
CREATE TYPE "public"."fund_member_role" AS ENUM('pm', 'analyst');--> statement-breakpoint
CREATE TYPE "public"."memo_recommendation" AS ENUM('buy', 'sell', 'short', 'hold');--> statement-breakpoint
CREATE TYPE "public"."memo_status" AS ENUM('draft', 'submitted', 'under_review', 'accepted', 'rejected', 'implemented');--> statement-breakpoint
CREATE TYPE "public"."post_mortem_outcome" AS ENUM('thesis_played_out', 'thesis_partially_played_out', 'thesis_failed', 'stopped_out', 'macro_driven');--> statement-breakpoint
CREATE TYPE "public"."security_type" AS ENUM('equity');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('buy', 'sell', 'short', 'cover', 'dividend', 'cash_deposit', 'fx_adjustment', 'corporate_action');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'pm', 'analyst');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"fund_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"details" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fund_constraints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" uuid NOT NULL,
	"constraint_type" text NOT NULL,
	"value" jsonb NOT NULL,
	"is_hard" boolean NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fund_members" (
	"fund_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_in_fund" "fund_member_role" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fund_members_fund_id_user_id_start_date_pk" PRIMARY KEY("fund_id","user_id","start_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "funds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"base_currency" "currency" NOT NULL,
	"benchmark_security_id" uuid,
	"strategy_description" text,
	"inception_date" date NOT NULL,
	"starting_nav" numeric(20, 4) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "funds_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "fx_rates" (
	"from_currency" "currency" NOT NULL,
	"to_currency" "currency" NOT NULL,
	"date" date NOT NULL,
	"rate" numeric(20, 8) NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_from_currency_to_currency_date_pk" PRIMARY KEY("from_currency","to_currency","date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investable_universes" (
	"fund_id" uuid NOT NULL,
	"security_id" uuid NOT NULL,
	"added_date" date NOT NULL,
	"removed_date" date,
	"added_by_user_id" uuid,
	"notes" text,
	CONSTRAINT "investable_universes_fund_id_security_id_added_date_pk" PRIMARY KEY("fund_id","security_id","added_date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "investment_memos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"security_id" uuid,
	"title" text NOT NULL,
	"recommendation" "memo_recommendation" NOT NULL,
	"target_price" numeric(20, 6),
	"target_currency" "currency",
	"time_horizon_months" integer,
	"summary" text NOT NULL,
	"body_markdown" text NOT NULL,
	"attachment_url" text,
	"status" "memo_status" DEFAULT 'draft' NOT NULL,
	"pm_notes" text,
	"submitted_at" timestamp,
	"decided_at" timestamp,
	"decided_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monthly_briefings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"title" text NOT NULL,
	"macro_section" text NOT NULL,
	"portfolio_activity_section" text NOT NULL,
	"performance_commentary_section" text NOT NULL,
	"outlook_section" text,
	"status" "briefing_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nav_snapshots" (
	"fund_id" uuid NOT NULL,
	"date" date NOT NULL,
	"nav" numeric(24, 6) NOT NULL,
	"cash_balance" numeric(24, 6) NOT NULL,
	"position_value" numeric(24, 6) NOT NULL,
	"gross_exposure" numeric(24, 6) NOT NULL,
	"net_exposure" numeric(24, 6) NOT NULL,
	"daily_return" numeric(12, 8),
	"benchmark_value" numeric(24, 6),
	"benchmark_daily_return" numeric(12, 8),
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "nav_snapshots_fund_id_date_pk" PRIMARY KEY("fund_id","date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" uuid NOT NULL,
	"security_id" uuid NOT NULL,
	"opened_at" timestamp NOT NULL,
	"closed_at" timestamp,
	"opening_memo_id" uuid,
	"side" text NOT NULL,
	"realised_pnl_base" numeric(24, 6)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "post_mortems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"original_thesis" text NOT NULL,
	"what_played_out" text NOT NULL,
	"what_didnt" text NOT NULL,
	"lessons_learned" text NOT NULL,
	"outcome" "post_mortem_outcome" NOT NULL,
	"realised_pnl_base" numeric(24, 6) NOT NULL,
	"holding_period_days" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "post_mortems_position_id_unique" UNIQUE("position_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prices" (
	"security_id" uuid NOT NULL,
	"date" date NOT NULL,
	"close_price" numeric(20, 6) NOT NULL,
	"currency" "currency" NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "prices_security_id_date_pk" PRIMARY KEY("security_id","date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public_holdings_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"disclosure_type" text NOT NULL,
	"holdings" jsonb NOT NULL,
	"published_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "risk_free_rates" (
	"currency" "currency" NOT NULL,
	"date" date NOT NULL,
	"annual_rate" numeric(10, 6) NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "risk_free_rates_currency_date_pk" PRIMARY KEY("currency","date")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "securities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticker" text NOT NULL,
	"exchange" text NOT NULL,
	"name" text NOT NULL,
	"currency" "currency" NOT NULL,
	"security_type" "security_type" DEFAULT 'equity' NOT NULL,
	"isin" text,
	"figi" text,
	"gics_sector" text,
	"gics_industry_group" text,
	"gics_industry" text,
	"gics_sub_industry" text,
	"is_benchmark" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" uuid NOT NULL,
	"security_id" uuid,
	"transaction_type" "transaction_type" NOT NULL,
	"quantity" numeric(24, 8) NOT NULL,
	"price" numeric(20, 6) NOT NULL,
	"currency" "currency" NOT NULL,
	"cash_impact" numeric(24, 6) NOT NULL,
	"fx_rate_to_base" numeric(20, 8) NOT NULL,
	"executed_at" timestamp NOT NULL,
	"executed_by_user_id" uuid NOT NULL,
	"rationale" text NOT NULL,
	"memo_id" uuid,
	"notes" text,
	"overridden_constraints" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"bio" text,
	"headshot_url" text,
	"linkedin_url" text,
	"graduation_year" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fund_constraints" ADD CONSTRAINT "fund_constraints_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fund_constraints" ADD CONSTRAINT "fund_constraints_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fund_members" ADD CONSTRAINT "fund_members_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "fund_members" ADD CONSTRAINT "fund_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investable_universes" ADD CONSTRAINT "investable_universes_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investable_universes" ADD CONSTRAINT "investable_universes_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investable_universes" ADD CONSTRAINT "investable_universes_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investment_memos" ADD CONSTRAINT "investment_memos_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investment_memos" ADD CONSTRAINT "investment_memos_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investment_memos" ADD CONSTRAINT "investment_memos_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "investment_memos" ADD CONSTRAINT "investment_memos_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monthly_briefings" ADD CONSTRAINT "monthly_briefings_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "monthly_briefings" ADD CONSTRAINT "monthly_briefings_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "nav_snapshots" ADD CONSTRAINT "nav_snapshots_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "positions" ADD CONSTRAINT "positions_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "positions" ADD CONSTRAINT "positions_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "positions" ADD CONSTRAINT "positions_opening_memo_id_investment_memos_id_fk" FOREIGN KEY ("opening_memo_id") REFERENCES "public"."investment_memos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post_mortems" ADD CONSTRAINT "post_mortems_position_id_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "post_mortems" ADD CONSTRAINT "post_mortems_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "prices" ADD CONSTRAINT "prices_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "public_holdings_snapshots" ADD CONSTRAINT "public_holdings_snapshots_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_executed_by_user_id_users_id_fk" FOREIGN KEY ("executed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_memo_id_investment_memos_id_fk" FOREIGN KEY ("memo_id") REFERENCES "public"."investment_memos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fund_constraints_fund_idx" ON "fund_constraints" USING btree ("fund_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fund_members_fund_idx" ON "fund_members" USING btree ("fund_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fund_members_user_idx" ON "fund_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "investable_universe_fund_active_idx" ON "investable_universes" USING btree ("fund_id","removed_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memos_fund_idx" ON "investment_memos" USING btree ("fund_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memos_status_idx" ON "investment_memos" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memos_security_idx" ON "investment_memos" USING btree ("security_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "briefings_fund_period_idx" ON "monthly_briefings" USING btree ("fund_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nav_snapshots_date_idx" ON "nav_snapshots" USING btree ("date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_fund_open_idx" ON "positions" USING btree ("fund_id","closed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_fund_security_idx" ON "positions" USING btree ("fund_id","security_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prices_date_idx" ON "prices" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "public_holdings_fund_date_type_idx" ON "public_holdings_snapshots" USING btree ("fund_id","as_of_date","disclosure_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "securities_ticker_exchange_idx" ON "securities" USING btree ("ticker","exchange");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "securities_isin_idx" ON "securities" USING btree ("isin");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_fund_executed_idx" ON "transactions" USING btree ("fund_id","executed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_fund_security_idx" ON "transactions" USING btree ("fund_id","security_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_memo_idx" ON "transactions" USING btree ("memo_id");