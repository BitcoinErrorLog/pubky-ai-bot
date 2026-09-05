import { describe, expect, it } from "vitest";
import { appBaseUrl, rewritePubkyCitations } from "./links.js";

const PK = "a".repeat(52);
const PK2 = "b".repeat(52);

describe("appBaseUrl", () => {
  it("defaults to pubky.app and strips a trailing slash", () => {
    expect(appBaseUrl("")).toBe("https://pubky.app");
    expect(appBaseUrl("https://staging.pubky.app/")).toBe("https://staging.pubky.app");
  });
});

describe("rewritePubkyCitations", () => {
  it("rewrites mixed posts, profiles, bare ids, and leaves https alone", () => {
    const text = [
      `See pubky://${PK}/pub/pubky.app/posts/0000000000001`,
      `and pubky://${PK2}`,
      `plus ${PK}`,
      `and https://github.com/pubky/pubky-core`,
    ].join(" ");
    const out = rewritePubkyCitations(text, "https://pubky.app");
    expect(out).toContain(`https://pubky.app/post/${PK}/0000000000001`);
    expect(out).toContain(`https://pubky.app/profile/${PK2}`);
    expect(out).toContain(`https://pubky.app/profile/${PK}`);
    expect(out).toContain("https://github.com/pubky/pubky-core");
    expect(out).not.toMatch(/pubky:\/\//);
  });

  it("does not rewrite a pubky id already inside an https URL", () => {
    const url = `https://pubky.app/post/${PK}/abc`;
    expect(rewritePubkyCitations(`cite ${url}`)).toBe(`cite ${url}`);
  });

  it("does not rewrite a loose or punctuation-laden post id into a post URL", () => {
    const loose = `pubky://${PK}/pub/pubky.app/posts/not.a.valid-id`;
    expect(rewritePubkyCitations(loose)).not.toContain(`/post/${PK}/`);
    expect(rewritePubkyCitations(loose)).not.toMatch(/\/post\/[a-z0-9]{52}\/not/i);
  });

  it("uses JEB_APP_URL override", () => {
    const out = rewritePubkyCitations(`pubky://${PK}`, "https://example.test");
    expect(out).toBe(`https://example.test/profile/${PK}`);
  });
});
