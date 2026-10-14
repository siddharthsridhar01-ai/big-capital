/**
 * The institutional address leads; the personal one follows.
 *
 * This runs on every sign-in and every merge, so a wrong swap would rewrite
 * someone's primary address silently.
 */
import { describe, it, expect } from "vitest";
import { isInstitutional, orderedEmails } from "../src/lib/email-order";

describe("isInstitutional", () => {
  it("recognises university addresses", () => {
    expect(isInstitutional("s.sridhar8@lse.ac.uk")).toBe(true);
    expect(isInstitutional("someone@ox.ac.uk")).toBe(true);
    expect(isInstitutional("someone@mit.edu")).toBe(true);
  });
  it("does not treat personal addresses as institutional", () => {
    expect(isInstitutional("siddharthsridhar01@gmail.com")).toBe(false);
    expect(isInstitutional("sampannaraut@outlook.com")).toBe(false);
  });
});

describe("orderedEmails", () => {
  it("swaps when the LSE address is in second place", () => {
    expect(orderedEmails("siddharthsridhar01@gmail.com", "s.sridhar8@lse.ac.uk")).toEqual({
      email: "s.sridhar8@lse.ac.uk",
      secondaryEmail: "siddharthsridhar01@gmail.com",
    });
  });
  it("leaves an already-correct pair alone", () => {
    expect(orderedEmails("s.sridhar8@lse.ac.uk", "siddharthsridhar01@gmail.com")).toBeNull();
  });
  it("never reorders two personal addresses", () => {
    expect(orderedEmails("a@gmail.com", "b@outlook.com")).toBeNull();
  });
  it("never reorders two institutional addresses", () => {
    expect(orderedEmails("a@lse.ac.uk", "b@ox.ac.uk")).toBeNull();
  });
  it("does nothing when there is no second address", () => {
    expect(orderedEmails("siddharthsridhar01@gmail.com", null)).toBeNull();
  });
});
