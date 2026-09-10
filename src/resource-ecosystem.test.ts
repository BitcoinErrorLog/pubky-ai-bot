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
  it("parses sitemap page URLs and keeps root paths", () => {
    expect(parsePubkySitemap(fixture("n3-pubky-sitemap.xml"))).toEqual(["https://pubky.org/sitemap-0.xml"]);
  });

  it("skips archived and fork GitHub repositories", async () => {
    const run = await discoverPubkyEcosystem({
      configVersion,
      limit: 10,
      fixtures: {
        vibes: [],
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
        vibes: [],
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
        vibes: [{ id: "one", name: "One", description: "Pubky app", website: "https://example.org" }],
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

