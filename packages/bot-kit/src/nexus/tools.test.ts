import { describe, expect, it } from "vitest";
import { assertNexusUrl, clampLimit, parseUserPk } from "./tools.js";
import { parsePostUri } from "../types.js";

describe("tool URI / SSRF guards", () => {
  it("rejects non-z32 pubky", () => {
    expect(() => parseUserPk("abc")).toThrow(/invalid pubky/);
  });
  it("rejects non-canonical post URI", () => {
    expect(() => parsePostUri("https://evil.example/post")).toThrow();
  });
  it("rejects uppercase scheme and returns a lowercased author", () => {
    const author = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const postId = "00000000000TG";
    expect(() => parsePostUri(`PUBKY://${author}/pub/pubky.app/posts/${postId}`)).toThrow(
      /Not a canonical post URI/,
    );
    const parsed = parsePostUri(`pubky://${author}/pub/pubky.app/posts/${postId}`);
    expect(parsed.author).toBe(author);
    expect(parsed.postId).toBe(postId);
  });
  it("rejects other hosts", () => {
    expect(() => assertNexusUrl(new URL("https://evil.test/v0/post"), "nexus.staging.pubky.app")).toThrow(/ssrf/);
  });
  it("clamps limits", () => {
    expect(clampLimit(999)).toBe(30);
    expect(clampLimit(0)).toBe(1);
  });
});
