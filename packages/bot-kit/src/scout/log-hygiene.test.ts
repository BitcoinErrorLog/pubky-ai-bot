import { describe, expect, it } from "vitest";
import { redactPaths } from "../log.js";
import { hashMentionKeyForLog } from "./tools.js";

describe("Scout log mention keys", () => {
  it("hashes the owner-derived key without changing the budget key", () => {
    const key = "pubchi:fgp3fnesafwnp3eb9hq6xfb8p3i8cqnh5awyjsoe6uqas3pautzy";
    const logged = hashMentionKeyForLog(key);
    expect(logged).toMatch(/^[a-f0-9]{16}$/);
    expect(logged).not.toContain(key);
    expect(hashMentionKeyForLog(key)).toBe(logged);
    expect(hashMentionKeyForLog(key, "different-key")).not.toBe(logged);
    expect(hashMentionKeyForLog(undefined)).toBeUndefined();
  });

  it("redacts the Pubchi cohort salt from root and nested log objects", () => {
    expect(redactPaths).toContain("PUBCHI_COHORT_SALT");
    expect(redactPaths).toContain("*.PUBCHI_COHORT_SALT");
  });
});
