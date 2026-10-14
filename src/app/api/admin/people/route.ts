/**
 * Admin — people and fund access.
 *
 *   GET  /api/admin/people            list everyone, their funds and sign-in status
 *   POST /api/admin/people            { entries: [{ fullName, email, fund, role }] }
 *
 * Replaces provisioning people by hand through the seed-team route. Adding
 * someone here creates or matches their user row by EMAIL, sets their global
 * role from the fund role, and gives them membership of the fund — so the entry
 * grants real access rather than being a display-only profile.
 *
 * Matching is on either address, so a person who already signed in with a
 * personal email is recognised rather than duplicated.
 *
 * Admin is deliberately NOT grantable here. It is platform-wide rather than
 * fund-scoped, so it stays with ADMIN_EMAILS plus a sign-in; a form that can
 * mint admins is a form that can be misused.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, or, isNull, desc } from "drizzle-orm";
import { db } from "@/db/client";
import { users, funds, fundMembers } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROLES = ["pm", "senior_analyst", "analyst"] as const;
type Role = (typeof ROLES)[number];

async function requireAdmin() {
  const u = await getOrCreateUser();
  return u && u.role === "admin" ? u : null;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }
  try {
    const rows = await db
      .select({
        id: users.id,
        fullName: users.fullName,
        email: users.email,
        secondaryEmail: users.secondaryEmail,
        role: users.role,
        firstSignInAt: users.firstSignInAt,
        fundSlug: funds.slug,
        fundName: funds.name,
        roleInFund: fundMembers.roleInFund,
      })
      .from(users)
      .leftJoin(fundMembers, and(eq(fundMembers.userId, users.id), isNull(fundMembers.endDate)))
      .leftJoin(funds, eq(funds.id, fundMembers.fundId))
      .where(eq(users.isActive, true))
      .orderBy(desc(users.createdAt));

    // Collapse to one entry per person with their funds listed.
    const byId = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const cur = byId.get(r.id) ?? {
        id: r.id,
        fullName: r.fullName,
        email: r.email,
        secondaryEmail: r.secondaryEmail,
        role: r.role,
        signedIn: Boolean(r.firstSignInAt),
        firstSignInAt: r.firstSignInAt,
        funds: [] as Array<{ slug: string; name: string; roleInFund: string }>,
      };
      if (r.fundSlug) {
        (cur.funds as Array<{ slug: string; name: string; roleInFund: string }>).push({
          slug: r.fundSlug,
          name: r.fundName ?? r.fundSlug,
          roleInFund: r.roleInFund ?? "analyst",
        });
      }
      byId.set(r.id, cur);
    }

    const allFunds = await db
      .select({ slug: funds.slug, name: funds.name })
      .from(funds)
      .where(eq(funds.isActive, true))
      .orderBy(funds.slug);

    return NextResponse.json({ ok: true, people: [...byId.values()], funds: allFunds });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("people GET failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }

  let body: { entries?: Array<{ fullName?: string; email?: string; fund?: string; role?: string }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const entries = body.entries ?? [];
  if (entries.length === 0) {
    return NextResponse.json({ ok: false, error: "Nothing to add" }, { status: 400 });
  }

  try {
    const allFunds = await db
      .select({ id: funds.id, slug: funds.slug })
      .from(funds)
      .where(eq(funds.isActive, true));
    const fundBySlug = new Map(allFunds.map((f) => [f.slug, f.id]));

    const results: Array<Record<string, unknown>> = [];

    for (const e of entries) {
      const fullName = (e.fullName ?? "").trim();
      const email = (e.email ?? "").trim().toLowerCase();
      const slug = (e.fund ?? "").trim();
      const role = (e.role ?? "analyst").trim() as Role;

      if (!fullName || !email) {
        results.push({ email, status: "skipped", reason: "name and email required" });
        continue;
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        results.push({ email, status: "skipped", reason: "not a valid email" });
        continue;
      }
      if (!ROLES.includes(role)) {
        results.push({ email, status: "skipped", reason: `role must be one of ${ROLES.join(", ")}` });
        continue;
      }
      const fundId = fundBySlug.get(slug);
      if (!fundId) {
        results.push({ email, status: "skipped", reason: `unknown fund '${slug}'` });
        continue;
      }

      // Match on either address so an existing person is never duplicated.
      const [existing] = await db
        .select({ id: users.id, role: users.role, firstSignInAt: users.firstSignInAt })
        .from(users)
        .where(or(eq(users.email, email), eq(users.secondaryEmail, email)))
        .limit(1);

      let userId: string;
      let created = false;

      if (existing) {
        userId = existing.id;
        await db.update(users).set({ fullName, isActive: true }).where(eq(users.id, userId));
      } else {
        const [ins] = await db
          .insert(users)
          .values({
            email,
            fullName,
            role: role === "pm" ? "pm" : "analyst",
            isActive: true,
          })
          .returning({ id: users.id });
        userId = ins.id;
        created = true;
      }

      const [already] = await db
        .select({ userId: fundMembers.userId, roleInFund: fundMembers.roleInFund })
        .from(fundMembers)
        .where(and(eq(fundMembers.fundId, fundId), eq(fundMembers.userId, userId), isNull(fundMembers.endDate)))
        .limit(1);

      if (already) {
        if (already.roleInFund !== role) {
          await db
            .update(fundMembers)
            .set({ roleInFund: role })
            .where(and(eq(fundMembers.fundId, fundId), eq(fundMembers.userId, userId), isNull(fundMembers.endDate)));
          results.push({ email, status: "role updated", fund: slug, role });
        } else {
          results.push({ email, status: "already a member", fund: slug, role });
        }
      } else {
        await db.insert(fundMembers).values({
          fundId,
          userId,
          roleInFund: role,
          startDate: new Date().toISOString().slice(0, 10),
        });
        results.push({
          email,
          status: created ? "created and added" : "added to fund",
          fund: slug,
          role,
          signedIn: Boolean(existing?.firstSignInAt),
        });
      }
    }

    // Derive the global role from fund membership rather than setting it once
    // and letting it drift.
    //
    // Promoting on add but never recalculating meant someone added as a PM, then
    // moved to an analyst seat, kept `pm` for ever — so the header badge said
    // Portfolio Manager while their only membership was as an analyst. Admin is
    // deliberately excluded: it is platform-wide and granted separately, so a
    // membership change must never revoke it.
    for (const r of results) {
      const email = String(r.email ?? "");
      if (!email) continue;
      const [u] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(or(eq(users.email, email), eq(users.secondaryEmail, email)))
        .limit(1);
      if (!u || u.role === "admin") continue;

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
        await db.update(users).set({ role: derived }).where(eq(users.id, u.id));
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("people POST failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
