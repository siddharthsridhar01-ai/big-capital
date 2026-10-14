/**
 * Admin — set a person's GLOBAL role.
 *
 *   POST /api/admin/people/role   { userId, role: "admin" | "pm" | "analyst" }
 *
 * Distinct from roleInFund, which governs one fund. This is platform-wide:
 * `admin` reaches every fund and every admin tool.
 *
 * Needed because ADMIN_EMAILS only applies at FIRST sign-in — it does not
 * retroactively promote someone who already has an account, so a co-head added
 * to the variable after they had signed in stayed an analyst with no way to fix
 * it from the site.
 *
 * Two safeguards: only an existing admin may call it, and an admin cannot strip
 * their own admin rights, which would otherwise lock the last admin out.
 */
import { NextRequest, NextResponse } from "next/server";
import { eq, and, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getOrCreateUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const ROLES = ["admin", "pm", "analyst"] as const;
type Role = (typeof ROLES)[number];

export async function POST(req: NextRequest) {
  const me = await getOrCreateUser();
  if (!me || me.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Admin only" }, { status: 403 });
  }

  let body: { userId?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { userId } = body;
  const role = body.role as Role;
  if (!userId || !ROLES.includes(role)) {
    return NextResponse.json(
      { ok: false, error: `userId and role (${ROLES.join(", ")}) required` },
      { status: 400 }
    );
  }

  if (userId === me.id && role !== "admin") {
    return NextResponse.json(
      { ok: false, error: "You cannot remove your own admin rights." },
      { status: 400 }
    );
  }

  try {
    const [target] = await db
      .select({ id: users.id, email: users.email, fullName: users.fullName, role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!target) {
      return NextResponse.json({ ok: false, error: "Person not found" }, { status: 404 });
    }

    // Never leave the platform without an admin.
    if (target.role === "admin" && role !== "admin") {
      const others = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), ne(users.id, userId)));
      if (others.length === 0) {
        return NextResponse.json(
          { ok: false, error: "This is the only admin. Promote someone else first." },
          { status: 400 }
        );
      }
    }

    await db.update(users).set({ role }).where(eq(users.id, userId));

    return NextResponse.json({
      ok: true,
      person: target.fullName,
      email: target.email,
      from: target.role,
      to: role,
      note:
        role === "admin"
          ? "They have platform-wide access on their next page load."
          : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("set role failed:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
