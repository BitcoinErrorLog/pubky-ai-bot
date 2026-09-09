import { describe, expect, it } from "vitest";
import { isDeniedPersonTag } from "./denylist.js";

describe("person tag denylist", () => {
  it("denies separator and suffix variants of listed people", () => {
    const denied = [
      "peter-todd",
      "peter.todd",
      "the-blue-matt",
      "blue-matt",
      "johncarvalho",
      "paoloardoino",
      "bitcoin-error-log",
      "petertodd1",
    ];
    expect(denied.filter((label) => isDeniedPersonTag(label))).toHaveLength(8);
    expect(denied.every((label) => isDeniedPersonTag(label))).toBe(true);
  });

  it("allows unrelated names and topic-like labels", () => {
    const allowed = ["johnny", "matt-corallo", "bitcoin", "blueprint", "paolo-ideas"];
    expect(allowed.filter((label) => !isDeniedPersonTag(label))).toHaveLength(5);
    expect(allowed.every((label) => !isDeniedPersonTag(label))).toBe(true);
  });
});
