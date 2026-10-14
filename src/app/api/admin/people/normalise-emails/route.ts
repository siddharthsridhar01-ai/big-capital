/**
 * Admin — put the institutional address first for everyone.
 *
 *   GET /api/admin/people/normalise-emails?secret=<CRON_SECRET>        (dry run)
 *   GET /api/admin/people/normalise-emails?secret=...&apply=1          (writes)
 *
 * Which address ended up primary was an accident of ordering: whoever signed in
 * first, or whichever record happened to be the merge target. This swaps them so
 * the LSE address leads and the personal one sits beneath it.
 *
 * Safe to re-run: pairs already in the right order are untouched, and a person
 * with only one address is never changed. Sign-in is unaffected either way,
 * since getOrCreateUser matches on both.
 */
import { NextRequest, NextResponse } from "next/server";
import { isNotNull, eq, and, isNull, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { users, fundMembers } from "@/db/schema";
import { orderedEmails } from "@/lib/email-order";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const url = new URL(req.url);
  const secret = url.searchParams.get("secret");
  if (auth !== `Bearer ${process.env.CRON_SECRET}` && secret !== process.env.CRON_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const apply = url.searchParams.get("apply") === "1";

  try {
    const rows = await db
      .select({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        secondaryEmail: users.secondaryEmail,
      })
      .from(users)
      .where(isNotNull(users.secondaryEmail));

    const changes: Array<Record<string, string>> = [];

    for (const r of rows) {
      const swapped = orderedEmails(r.email, r.secondaryEmail);
      if (!swapped) continue;
      changes.push({
        person: r.fullName,
        was: `${r.email} / ${r.secondaryEmail}`,
        now: `${swapped.email} / ${swapped.secondaryEmail}`,
      });
      if (apply) {
        // Clear first: both columns are unique, so a direct swap would collide.
        await db.update(users).set({ secondaryEmail: null }).where(eq(users.id, r.id));
        await db.update(users).set(swapped).where(eq(users.id, r.id));
      }
    }

    // Repair global roles that drifted out of step with fund membership: someone
    // moved from a PM seat to an analyst one kept `pm`, which is why the header
    // badge disagreed with the people list. Admins are never touched.
    const everyone = await db
      .select({ id: users.id, fullName: users.fullName, role: users.role })
      .from(users)
      .where(ne(users.role, "admin"));

    const roleChanges: Array<Record<string, string>> = [];
    for (const u of everyone) {
      const pmSeats = await db
        .select({ fundId: fundMembers.fundId })
        .from(fundMembers)
        .where(
          and(
            eq(fundMembers.userId, u.id),
            eq(fundMembers.roleInFund, "pm"),
            isNull(fundMembers.endDate)
          )
        );
      const derived = pmSeats.length > 0 ? "pm" : "analyst";
      if (derived !== u.role) {
        roleChanges.push({ person: u.fullName, from: u.role, to: derived });
        if (apply) {
          await db.update(users).set({ role: derived }).where(eq(users.id, u.id));
        }
      }
    }

    return NextResponse.json({
      ok: true,
      applied: apply,
      examined: rows.length,
      swapped: changes.length,
      changes,
      roleChanges,
      hint: apply ? undefined : "Dry run. Re-run with &apply=1 to write.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("normalise-emails failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
