import { describe, expect, it } from "vitest";
import { hasUnsupportedGraphClaim } from "./claim-patterns.js";

describe("unsupported graph claim patterns", () => {
  it.each([
    "Pubky has 12,345 users.",
    "I checked the most recent posts.",
    "I searched and found 12 followers.",
    "I verified 12 tags.",
    "The most recent posts are unavailable.",
    "I looked at 12 replies.",
  ])("rejects %s", (text) => {
    expect(hasUnsupportedGraphClaim(text)).toBe(true);
  });

  it("allows a non-assertive feed explanation", () => {
    expect(hasUnsupportedGraphClaim("I can explain how to build a feed with filters.")).toBe(false);
  });
});
