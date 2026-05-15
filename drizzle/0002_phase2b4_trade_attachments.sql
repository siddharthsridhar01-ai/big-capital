-- Phase 2b.4: trade_attachments table for PDF memos linked to transactions

CREATE TABLE IF NOT EXISTS "trade_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "transaction_id" uuid NOT NULL REFERENCES "transactions"("id") ON DELETE CASCADE,
  "filename" text NOT NULL,
  "storage_url" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "uploaded_at" timestamp NOT NULL DEFAULT now(),
  "uploaded_by_user_id" uuid NOT NULL REFERENCES "users"("id")
);

CREATE INDEX IF NOT EXISTS "trade_attachments_txn_idx"
  ON "trade_attachments" ("transaction_id");
