/**
 * Sync a Clerk user to a row in the BIG Capital `users` table.
 *
 * This function is called from BOTH the dashboard layout and the dashboard
 * page server components, which Next.js may render in parallel. To handle
 * the race condition we use INSERT ... ON CONFLICT DO NOTHING, then re-fetch.
 *
 * Special case: if the Clerk user's email matches ADMIN_EMAILS env var
 * (comma-separated list), they get role 'admin' on first creation.
 * Existing users keep their role; ADMIN_EMAILS doesn't retroactively promote.
 */

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { currentUser } from "@clerk/nextjs/server";

export interface BigCapUser {
  id: string;
  email: string;
  fullName: string;
  role: "admin" | "pm" | "analyst";
  bio: string | null;
  headshotUrl: string | null;
}

export async function getOrCreateUser(): Promise<BigCapUser | null> {
  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  const email = clerkUser.emailAddresses[0]?.emailAddress;
  if (!email) return null;

  // Check if user exists first (the happy path on every page load after first sign-in)
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing.length > 0) {
    return toApiShape(existing[0]);
  }

  // User doesn't exist yet — try to create them, but handle the race condition
  // where another concurrent request created the row first.
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);

  const isAdmin = adminEmails.includes(email.toLowerCase());
  const role: "admin" | "analyst" = isAdmin ? "admin" : "analyst";

  const fullName =
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
    email.split("@")[0];

  // Idempotent insert: if email already exists (race condition), do nothing
  await db
    .insert(users)
    .values({
      email,
      fullName,
      role,
      headshotUrl: clerkUser.imageUrl || null,
    })
    .onConflictDoNothing({ target: users.email });

  // Re-fetch — guaranteed to exist now, either we inserted it or the parallel call did
  const final = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (final.length === 0) {
    return null;
  }

  return toApiShape(final[0]);
}

function toApiShape(u: typeof users.$inferSelect): BigCapUser {
  return {
    id: u.id,
    email: u.email,
    fullName: u.fullName,
    role: u.role,
    bio: u.bio,
    headshotUrl: u.headshotUrl,
  };
}
