import { describe, expect, it } from "vitest";
import { AUTO_ARTIFACT_APPROVER, filterOpenTags, isAutoArtifactApprover, isValidOpenTagLabel, preferExistingTags, rejectOpenTagReason, TAG_STYLE_MAX_CHARS } from "./policy.js";
import { isDeniedPersonTag, isDeniedSlurTag } from "./denylist.js";

describe("open tag style rules", () => {
  it("accepts lowercase hyphenated labels within the spec cap", () => {
    expect(isValidOpenTagLabel("pubky")).toBe(true);
    expect(isValidOpenTagLabel("pubky-weekly")).toBe(true);
    expect(isValidOpenTagLabel("nexus-scout")).toBe(true);
    expect(isValidOpenTagLabel("a".repeat(20))).toBe(true);
  });

  it("rejects uppercase, spaces, extra words, and overlong labels", () => {
    expect(isValidOpenTagLabel("Pubky")).toBe(false);
    expect(isValidOpenTagLabel("pubky weekly")).toBe(false);
    expect(isValidOpenTagLabel("a_b")).toBe(false);
    expect(isValidOpenTagLabel("one-two-three-four")).toBe(false);
    expect(isValidOpenTagLabel("a--b")).toBe(false);
    expect(isValidOpenTagLabel("")).toBe(false);
    expect(isValidOpenTagLabel("x".repeat(21))).toBe(false);
    expect(TAG_STYLE_MAX_CHARS).toBe(32);
  });
});

describe("tag denylist", () => {
  it("rejects slurs and slur compounds", () => {
    expect(isDeniedSlurTag("nigger")).toBe(true);
    expect(isDeniedSlurTag("faggot")).toBe(true);
    expect(rejectOpenTagReason("nigger")).toBe("denylist-slur");
    expect(filterOpenTags(["nigger", "pubky"])).toEqual(["pubky"]);
  });

  it("rejects person names, handles, and pubky ids", () => {
    expect(isDeniedPersonTag("john-carvalho")).toBe(true);
    expect(isDeniedPersonTag("bitcoinerrorlog")).toBe(true);
    expect(isDeniedPersonTag("@alice", ["Alice"])).toBe(true);
    expect(isDeniedPersonTag("alice", ["Alice"])).toBe(true);
    const pk = "a".repeat(52);
    expect(isDeniedPersonTag(pk)).toBe(true);
    expect(rejectOpenTagReason(pk)).toBe("style");
  });

  it("caps at 5 and remaps to an existing Nexus tag", () => {
    const got = filterOpenTags(["pubky", "bitkit", "paykit", "graph", "locks", "loopky"]);
    expect(got).toEqual(["pubky", "bitkit", "paykit", "graph", "locks"]);
    expect(preferExistingTags(["pubky_weekly", "homeserver"], ["pubky-weekly", "homeserver"])).toEqual([
      "pubky-weekly",
      "homeserver",
    ]);
  });

  it("names the auto artifact approver", () => {
    expect(isAutoArtifactApprover(AUTO_ARTIFACT_APPROVER)).toBe(true);
    expect(isAutoArtifactApprover("op")).toBe(false);
  });
});
