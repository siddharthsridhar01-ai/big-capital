ALTER TABLE "funds" ADD COLUMN "trading_fees_bps" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "submitted_at" timestamp NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "fee_amount" numeric(20, 6) DEFAULT '0' NOT NULL;