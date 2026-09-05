import { describe, expect, it } from "vitest";
import { filterEvidenceUris, httpsHostsFromSources, isAllowedEvidenceUri } from "./evidence-uri.js";
import { evidenceHref } from "./finish.js";
import { parseManifest } from "../knowledge/manifest.js";

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

  it("merges enabled manifest location and cite_base hosts", () => {
    const manifest = parseManifest(`
sources:
  - id: synonym-to-site
    product: synonym
    component: site
    kind: http-site
    location: https://synonym.to
    cite_base: https://synonym.to/articles
    include: []
    exclude: []
    status: canonical
    audience: public
    confidentiality: public
    owner: synonym
  - id: bitkit-to
    product: bitkit
    component: site
    kind: http-site
    location: https://bitkit.to
    include: []
    exclude: []
    status: canonical
    audience: public
    confidentiality: public
    owner: synonym
  - id: disabled-evil
    product: other
    component: site
    kind: http-site
    location: https://evil.example
    include: []
    exclude: []
    status: canonical
    audience: public
    confidentiality: public
    owner: other
    enabled: false
`);
    const hosts = httpsHostsFromSources(manifest.sources);
    expect(hosts).toEqual(expect.arrayContaining(["synonym.to", "bitkit.to"]));
    expect(hosts).not.toContain("evil.example");
    expect(isAllowedEvidenceUri("https://synonym.to/articles/x", "https://pubky.app", hosts)).toBe(true);
    expect(isAllowedEvidenceUri("https://bitkit.to/docs", "https://pubky.app", hosts)).toBe(true);
    expect(isAllowedEvidenceUri("https://evil.example/phish", "https://pubky.app", hosts)).toBe(false);
  });

  it("treats quoted enabled false as disabled", () => {
    const manifest = parseManifest(`
sources:
  - id: quoted-off
    product: other
    component: site
    kind: http-site
    location: https://quoted-off.example
    include: []
    exclude: []
    status: canonical
    audience: public
    confidentiality: public
    owner: other
    enabled: "false"
  - id: quoted-on
    product: other
    component: site
    kind: http-site
    location: https://quoted-on.example
    include: []
    exclude: []
    status: canonical
    audience: public
    confidentiality: public
    owner: other
    enabled: "true"
`);
    expect(manifest.sources.find((s) => s.id === "quoted-off")?.enabled).toBe(false);
    expect(manifest.sources.find((s) => s.id === "quoted-on")?.enabled).toBe(true);
    const hosts = httpsHostsFromSources(manifest.sources);
    expect(hosts).toContain("quoted-on.example");
    expect(hosts).not.toContain("quoted-off.example");
  });

  it("drops one malformed source without losing the others", () => {
    const hosts = httpsHostsFromSources([
      { location: "https://synonym.to" },
      null as unknown as { location: string },
      { location: "https://bitkit.to" },
    ]);
    expect(hosts).toEqual(expect.arrayContaining(["synonym.to", "bitkit.to"]));
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
