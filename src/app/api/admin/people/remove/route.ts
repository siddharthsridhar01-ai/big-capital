/**
 * Admin — revoke someone's access.
 *
 *   POST /api/admin/people/remove   { userId, fund?: string }
 *
 * With `fund`, ends their membership of that one fund. Without it, ends every
 * membership and deactivates the account, so they can no longer reach the
 * dashboard at all.
 *
 * Membership is ENDED rather than deleted: an end date is set and the row stays.
 * A PM who leaves still authored the trades and theses they made while on the
 * fund, and deleting the membership would make that history read as though a
 * stranger did it. The ledger and research keep their authorship intact.
 *
 * Admins cannot remove themselves, and the last admin cannot be deactivated.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { users, funds, fundMembers } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const me = await getOrCreateUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }

  let body: { userId?: string; fund?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const { userId, fund } = body;
  if (!userId) {
    return NextResponse.json({ ok: false, error: "userId required" }, { status: 400 });
  }
  if (userId === me.id && !fund) {
    return NextResponse.json({ ok: false, error: "You cannot remove your own access." }, { status: 400 });
  }

  try {
    const [target] = await db
      .select({ id: users.id, fullName: users.fullName, role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!target) {
      return NextResponse.json({ ok: false, error: "Person not found" }, { status: 404 });
    }

    const today = new Date().toISOString().slice(0, 10);

    if (fund) {
      const [f] = await db.select({ id: funds.id }).from(funds).where(eq(funds.slug, fund)).limit(1);
      if (!f) return NextResponse.json({ ok: false, error: `Unknown fund '${fund}'` }, { status: 404 });

      await db
        .update(fundMembers)
        .set({ endDate: today })
        .where(and(eq(fundMembers.fundId, f.id), eq(fundMembers.userId, userId), isNull(fundMembers.endDate)));
    } else {
      if (target.role === "admin") {
        const others = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.role, "admin"), ne(users.id, userId), eq(users.isActive, true)));
        if (others.length === 0) {
          return NextResponse.json({ ok: false, error: "This is the only admin." }, { status: 400 });
        }
      }
      await db
        .update(fundMembers)
        .set({ endDate: today })
        .where(and(eq(fundMembers.userId, userId), isNull(fundMembers.endDate)));
      await db.update(users).set({ isActive: false, role: "analyst" }).where(eq(users.id, userId));
    }

    // Re-derive the global role from whatever memberships remain.
    if (fund && target.role !== "admin") {
      const pmSeats = await db
        .select({ fundId: fundMembers.fundId })
        .from(fundMembers)
        .where(and(eq(fundMembers.userId, userId), eq(fundMembers.roleInFund, "pm"), isNull(fundMembers.endDate)));
      await db
        .update(users)
        .set({ role: pmSeats.length > 0 ? "pm" : "analyst" })
        .where(eq(users.id, userId));
    }

    return NextResponse.json({
      ok: true,
      person: target.fullName,
      removed: fund ? `from ${fund}` : "all access",
      note: "Trades and research they authored keep their authorship.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("remove person failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
