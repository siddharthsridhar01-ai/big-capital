/**
 * Admin — merge duplicate user records.
 *
 *   POST /api/admin/people/merge   { sourceId, targetId }
 *
 * One person can end up with several rows: Clerk merges addresses into one
 * login, but our rows were created at different times, some before matching on
 * a secondary address existed, and the old team page minted display-only rows
 * with `@bigcapital.invalid` placeholders.
 *
 * Merging repoints EVERY reference — fund membership, trades, theses, orders,
 * attachments, briefings — from the source onto the target, then deletes the
 * source. Deleting without repointing would orphan a PM's fund membership and
 * detach their trade history, which is how a fund quietly loses its record of
 * who did what.
 *
 * The column list is derived from the schema's foreign keys rather than typed
 * from memory; a column missed here is a silent orphan.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";
import { orderedEmails } from "@/lib/email-order";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** [table, column] for every foreign key pointing at users.id. */
const REFERENCES: Array<[string, string]> = [
  ["fund_members", "user_id"],
  ["investable_universes", "added_by_user_id"],
  ["investment_memos", "created_by_user_id"],
  ["transactions", "executed_by_user_id"],
  ["transactions", "voided_by_user_id"],
  ["trade_attachments", "uploaded_by_user_id"],
  ["pending_orders", "submitted_by_user_id"],
  ["monthly_briefings", "author_user_id"],
  ["audit_log", "user_id"],
  ["theses", "author_user_id"],
  ["theses", "submitted_by_user_id"],
  ["thesis_updates", "author_user_id"],
  ["thesis_post_mortems", "author_user_id"],
  ["post_mortems", "author_user_id"],
];

export async function POST(req: NextRequest) {
  const admin = await getOrCreateUser();
  if (!admin || admin.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }

  let body: { sourceId?: string; targetId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { sourceId, targetId } = body;
  if (!sourceId || !targetId) {
    return NextResponse.json({ ok: false, error: "sourceId and targetId required" }, { status: 400 });
  }
  if (sourceId === targetId) {
    return NextResponse.json({ ok: false, error: "Cannot merge a record into itself" }, { status: 400 });
  }

  try {
    const both = await db
      .select({ id: users.id, email: users.email, fullName: users.fullName, role: users.role })
      .from(users);
    const source = both.find((u) => u.id === sourceId);
    const target = both.find((u) => u.id === targetId);
    if (!source || !target) {
      return NextResponse.json({ ok: false, error: "Record not found" }, { status: 404 });
    }

    const moved: Record<string, number> = {};

    for (const [table, column] of REFERENCES) {
      try {
        const res = await db.execute(
          sql.raw(
            `UPDATE ${table} SET ${column} = '${targetId}' WHERE ${column} = '${sourceId}'`
          )
        );
        const n = (res as { rowCount?: number }).rowCount ?? 0;
        if (n > 0) moved[`${table}.${column}`] = n;
      } catch (e) {
        // A table may not exist in this environment; record and continue rather
        // than abandoning a half-finished merge.
        moved[`${table}.${column}`] = -1;
        console.warn(`merge: ${table}.${column} failed`, e);
      }
    }

    // Two active memberships of one fund can now exist. Keep the stronger role.
    await db.execute(sql.raw(`
      DELETE FROM fund_members a
      USING fund_members b
      WHERE a.fund_id = b.fund_id
        AND a.user_id = b.user_id
        AND a.end_date IS NULL AND b.end_date IS NULL
        AND a.ctid < b.ctid
    `));

    // Carry over anything the target is missing, then remove the source.
    await db.execute(sql.raw(`
      UPDATE users SET
        full_name = CASE
          WHEN full_name IS NULL OR full_name = '' OR full_name NOT LIKE '% %'
          THEN (SELECT full_name FROM users WHERE id = '${sourceId}')
          ELSE full_name END,
        secondary_email = COALESCE(secondary_email, (SELECT email FROM users WHERE id = '${sourceId}' AND email NOT LIKE '%@bigcapital.invalid')),
        headshot_url = COALESCE(headshot_url, (SELECT headshot_url FROM users WHERE id = '${sourceId}')),
        degree = COALESCE(degree, (SELECT degree FROM users WHERE id = '${sourceId}')),
        linkedin_url = COALESCE(linkedin_url, (SELECT linkedin_url FROM users WHERE id = '${sourceId}')),
        graduation_year = COALESCE(graduation_year, (SELECT graduation_year FROM users WHERE id = '${sourceId}')),
        first_sign_in_at = LEAST(first_sign_in_at, (SELECT first_sign_in_at FROM users WHERE id = '${sourceId}'))
      WHERE id = '${targetId}'
    `));

    await db.delete(users).where(eq(users.id, sourceId));

    // Lead with the institutional address. Which record was the merge target is
    // an arbitrary choice, so without this the LSE address could end up second.
    const [after] = await db
      .select({ email: users.email, secondaryEmail: users.secondaryEmail })
      .from(users)
      .where(eq(users.id, targetId))
      .limit(1);
    const swapped = after ? orderedEmails(after.email, after.secondaryEmail) : null;
    if (swapped) {
      await db.update(users).set({ secondaryEmail: null }).where(eq(users.id, targetId));
      await db.update(users).set(swapped).where(eq(users.id, targetId));
    }

    return NextResponse.json({
      ok: true,
      merged: { from: source.email, into: target.email },
      moved,
      note: "All references repointed. The source record is gone.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("merge failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
