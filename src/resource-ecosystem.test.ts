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
    expect(run.accepted.map((resource) => resource.canonicalValue)).not.toEqual(expect.arrayContaining([
      "https://github.com/pubky/archived",
      "https://github.com/pubky/fork",
    ]));
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

  it("fails closed above the hard record limit", async () => {
    await expect(discoverPubkyEcosystem({ configVersion, limit: 101 })).rejects.toThrow(
      "resource limit must be an integer from 1 to 100",
    );
  });
});

