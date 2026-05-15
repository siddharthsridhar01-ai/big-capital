/**
 * Sync a Clerk user to a row in the BIG Capital `users` table.
 *
 * On first sign-in we create a record. Subsequent sign-ins just look it up.
 *
 * Special case: if the Clerk user's email matches ADMIN_EMAILS env var
 * (comma-separated list), they get role 'admin'. Everyone else defaults
 * to 'analyst' and an admin can promote them via the database directly
 * for now. (A proper user management UI comes in Phase 2c.)
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

  // Look up by email
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing.length > 0) {
    return {
      id: existing[0].id,
      email: existing[0].email,
      fullName: existing[0].fullName,
      role: existing[0].role,
      bio: existing[0].bio,
      headshotUrl: existing[0].headshotUrl,
    };
  }

  // Not found — create
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);

  const isAdmin = adminEmails.includes(email.toLowerCase());
  const role: "admin" | "analyst" = isAdmin ? "admin" : "analyst";

  const fullName =
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") ||
    email.split("@")[0];

  const [created] = await db
    .insert(users)
    .values({
      email,
      fullName,
      role,
      headshotUrl: clerkUser.imageUrl || null,
    })
    .returning();

  return {
    id: created.id,
    email: created.email,
    fullName: created.fullName,
    role: created.role,
    bio: created.bio,
    headshotUrl: created.headshotUrl,
  };
}
