import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DiscoveryRequestBudget,
  discoverPubkyEcosystem,
  parsePubkySitemap,
} from "./resource-ecosystem.js";

const configVersion = "test-n3";
const fixture = (name: string): string => readFileSync(new URL(`./test-fixtures/n3/${name}`, import.meta.url), "utf8");

describe("pubky ecosystem resource adapter", () => {
  it("parses bounded same-host sitemap pages and rejects index/off-host URLs", () => {
    const pages = parsePubkySitemap(fixture("n3-pubky-sitemap.xml") + [
      "<url><loc>https://evil.example/outbound</loc></url>",
      "<url><loc>https://pubky.org/page?tracking=1</loc></url>",
    ].join(""));
    expect(pages.length).toBeGreaterThan(1);
    expect(pages).not.toContain("https://pubky.org/sitemap-0.xml");
    expect(pages).not.toContain("https://evil.example/outbound");
    expect(pages).not.toContain("https://pubky.org/page?tracking=1");
  });

  it("rejects sitemap indexes as discovery-only with a bounded reason", async () => {
    const run = await discoverPubkyEcosystem({
      configVersion,
      fixtures: {
        vibesRegistry: [],
        sitemap: "<sitemapindex><sitemap><loc>https://pubky.org/sitemap-0.xml</loc></sitemap></sitemapindex>",
        pubkyGithub: [],
        synonymGithub: [],
        privacyguides: [],
      },
      fetchText: async () => "",
    });
    expect(run.accepted).toHaveLength(0);
    expect(run.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "sitemap index is discovery-only" }),
    ]));
  });

  it("skips archived and fork GitHub repositories", async () => {
    const run = await discoverPubkyEcosystem({
      configVersion,
      limit: 10,
      fixtures: {
        vibesRegistry: [],
        sitemap: "",
        pubkyGithub: [
          { html_url: "https://github.com/pubky/good", description: "A Pubky app", archived: false, fork: false, stargazers_count: 4 },
          { html_url: "https://github.com/pubky/archived", description: "A Pubky app", archived: true, fork: false },
          { html_url: "https://github.com/pubky/fork", description: "A Pubky app", archived: false, fork: true },
        ],
        synonymGithub: [],
        privacyguides: [],
      },
    });
    expect(run.accepted.map((resource) => resource.canonicalValue)).toContain("https://github.com/pubky/good");
    expect(run.accepted.find((resource) => resource.canonicalValue === "https://github.com/pubky/good")?.taxonomy.domain)
      .toContain("pubky");
    expect(run.accepted.map((resource) => resource.canonicalValue)).not.toEqual(expect.arrayContaining([
      "https://github.com/pubky/archived",
      "https://github.com/pubky/fork",
    ]));
  });

  it("rejects malformed, javascript, and empty GitHub homepages without crashing", async () => {
    const run = await discoverPubkyEcosystem({
      configVersion,
      fixtures: {
        vibesRegistry: [],
        sitemap: "",
        pubkyGithub: [
          { html_url: "https://github.com/pubky/bad", description: "Bad homepage", homepage: "not a url <<<" },
          { html_url: "https://github.com/pubky/js", description: "JS homepage", homepage: "javascript:alert(1)" },
          { html_url: "https://github.com/pubky/empty", description: "Empty homepage", homepage: "" },
        ],
        synonymGithub: [],
        privacyguides: [],
      },
    });
    expect(run.rejected.map((item) => item.reason)).toContain("invalid-homepage");
    expect(run.accepted.map((item) => item.canonicalValue)).not.toContain("javascript:alert(1)");
    expect(run.accepted.map((item) => item.canonicalValue)).toContain("https://github.com/pubky/empty");
  });

  it("pins GitHub organization and rejects a mismatched html_url owner", async () => {
    const run = await discoverPubkyEcosystem({
      configVersion,
      fixtures: {
        vibesRegistry: [],
        sitemap: "",
        pubkyGithub: [],
        synonymGithub: [{ html_url: "https://github.com/pubky/wrong-owner", description: "Synonym project" }],
        privacyguides: [],
      },
    });
    expect(run.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: "github-owner-mismatch" }),
    ]));
    expect(run.accepted).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ taxonomy: expect.objectContaining({ domain: expect.arrayContaining(["pubky"]) }) }),
    ]));
  });

  it("records a GitHub 403 as a source halt", async () => {
    const run = await discoverPubkyEcosystem({
      configVersion,
      fixtures: { vibesRegistry: [], sitemap: "", privacyguides: [] },
      fetchText: async (url) => {
        if (url.includes("/orgs/pubky/repos")) throw new Error("ecosystem fetch failed HTTP 403");
        return "[]";
      },
    });
    expect(run.shadowReport.halt).toEqual({ reason: "source-unavailable" });
    expect(run.shadowReport.byRejectionReason["github-unavailable HTTP 403"]).toBe(1);
    expect(run.shadowReport.bySubSource?.github).toBe(0);
  });

  it("adds CC BY-SA attribution to Privacy Guides resources", async () => {
    const run = await discoverPubkyEcosystem({
      configVersion,
      fixtures: {
        vibesRegistry: [],
        sitemap: "",
        pubkyGithub: [],
        synonymGithub: [],
        privacyguides: [{ path: "docs/tools/example.md", type: "file" }],
        privacyMarkdown: { "docs/tools/example.md": "website: https://example.org/tool\n" },
      },
    });
    const resource = run.accepted.find((item) => item.canonicalValue === "https://example.org/tool");
    expect(resource?.labels).toEqual(expect.arrayContaining(["privacy", "tools"]));
    expect(resource?.labels).not.toContain("pubky");
    expect(resource?.taxonomy.domain).toEqual(["privacy"]);
    expect(resource?.provenance.attribution).toBe("CC BY-SA 4.0 — Privacy Guides");
  });

  it("skips resources already carrying a Jeb tag", async () => {
    const run = await discoverPubkyEcosystem({
      configVersion,
      fixtures: {
        vibesRegistry: [{ name: "one", type: "dir" }],
        vibeManifests: {
          one: { name: "One", description: "Pubky app", hosted: { url: "https://example.org" } },
        },
        sitemap: "",
        pubkyGithub: [],
        synonymGithub: [],
        privacyguides: [],
      },
      existingTags: async () => ["pubky"],
    });
    expect(run.accepted).toHaveLength(0);
  });

  it("fails closed when the request budget is exceeded", async () => {
    await expect(discoverPubkyEcosystem({
      configVersion,
      maxRequests: 3,
      fetchText: async () => "[]",
    })).rejects.toBeInstanceOf(DiscoveryRequestBudget);
  });

  it("propagates a manifest request budget failure", async () => {
    await expect(discoverPubkyEcosystem({
      configVersion,
      maxRequests: 1,
      fixtures: { vibesRegistry: [{ name: "one", type: "dir" }] },
      fetchText: async () => "[]",
    })).rejects.toBeInstanceOf(DiscoveryRequestBudget);
  });

  it("fails closed above the hard record limit", async () => {
    await expect(discoverPubkyEcosystem({ configVersion, limit: 101 })).rejects.toThrow(
      "resource limit must be an integer from 1 to 100",
    );
  });
});

