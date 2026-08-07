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
import { eq, inArray, or } from "drizzle-orm";
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

  // A person may hold several verified addresses on their Clerk account — most
  // here have an LSE address and a personal one. Matching only the first meant
  // signing in with the "wrong" one silently created a SECOND row, as an
  // analyst, with no fund membership. Match on any of them so either address
  // resolves to the same person.
  const addresses = clerkUser.emailAddresses
    .map((e) => e.emailAddress)
    .filter((e): e is string => Boolean(e));
  if (addresses.length === 0) return null;

  // Primary address, used only when creating a row for someone genuinely new.
  const email =
    clerkUser.emailAddresses.find((e) => e.id === clerkUser.primaryEmailAddressId)?.emailAddress ??
    addresses[0];

  // Match on either column: members sign in with an LSE or a personal address
  // and both must land on the same person.
  const existing = await db
    .select()
    .from(users)
    .where(or(inArray(users.email, addresses), inArray(users.secondaryEmail, addresses)))
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
