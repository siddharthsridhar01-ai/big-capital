/**
 * Institutional address first, personal address second.
 *
 * A person's primary address should be their LSE one: it is the institutional
 * identity, it is what seed-team treats as canonical, and it is what should
 * appear on team pages and against trades. Which address ended up primary was
 * previously an accident of ordering — whoever signed in first, or whichever
 * record happened to be the merge target.
 */

/** True for an address that belongs to a university rather than a person. */
export function isInstitutional(email: string | null | undefined): boolean {
  if (!email) return false;
  return /\.ac\.uk$/i.test(email.trim()) || /\.edu$/i.test(email.trim());
}

/**
 * Returns the pair in the order they should be stored, or null when no change
 * is needed. Only swaps when the secondary is institutional and the primary is
 * not — never reorders two addresses of the same kind.
 */
export function orderedEmails(
  email: string,
  secondaryEmail: string | null
): { email: string; secondaryEmail: string | null } | null {
  if (!secondaryEmail) return null;
  if (isInstitutional(email)) return null;
  if (!isInstitutional(secondaryEmail)) return null;
  return { email: secondaryEmail, secondaryEmail: email };
}
