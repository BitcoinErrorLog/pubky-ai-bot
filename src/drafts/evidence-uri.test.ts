import { describe, expect, it } from "vitest";
import { filterEvidenceUris, isAllowedEvidenceUri } from "./evidence-uri.js";
import { evidenceHref } from "./finish.js";

const PK = "a".repeat(52);
const POST = `pubky://${PK}/pub/pubky.app/posts/AAAAAAAAAAAAA`;

describe("evidence URI collection gate", () => {
  it("allows https on the generator host allowlist and 13-char pubky posts", () => {
    expect(isAllowedEvidenceUri("https://pubky.app/post/x")).toBe(true);
    expect(isAllowedEvidenceUri("https://github.com/pubky/pubky-core")).toBe(true);
    expect(isAllowedEvidenceUri("https://api.github.com/repos/pubky/pubky-core/commits")).toBe(true);
    expect(isAllowedEvidenceUri("https://pubky.org/Glossary.md")).toBe(true);
    expect(isAllowedEvidenceUri(POST)).toBe(true);
    expect(isAllowedEvidenceUri(`pubky://${PK}`)).toBe(true);
  });

  it("drops http, javascript, and off-allowlist https", () => {
    expect(isAllowedEvidenceUri("http://pubky.app/x")).toBe(false);
    expect(isAllowedEvidenceUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedEvidenceUri("https://evil.example/phish")).toBe(false);
    expect(isAllowedEvidenceUri(`pubky://${PK}/pub/pubky.app/posts/not-thirteen`)).toBe(false);
    expect(filterEvidenceUris(["https://evil.example/x", POST, "javascript:alert(1)"])).toEqual([POST]);
  });
});

describe("evidenceHref post-id shape", () => {
  it("rewrites only /^[A-Z0-9]{13}$/ post ids", () => {
    expect(evidenceHref(POST)).toBe(`https://pubky.app/post/${PK}/AAAAAAAAAAAAA`);
    expect(evidenceHref(`pubky://${PK}/pub/pubky.app/posts/not.a.valid`)).toBe("");
    expect(evidenceHref("javascript:alert(1)")).toBe("");
    expect(evidenceHref("https://evil.example/phish")).toBe("");
  });
});
