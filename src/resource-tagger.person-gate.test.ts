import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { discoverResources, type ExternalResource } from "./external-resources.js";
import { tagResource } from "./resource-tagger.js";

// Integration coverage that imports only `tagResource` and `discoverResources`, so the same file runs
// against the pre-gate base commit and fails there (failing-then-passing evidence for Phase 1).

const cfg = { model: "test-model" } as Config;
const cacheDirs: string[] = [];
async function freshCacheDir(): Promise<string> {
  const cacheDir = await mkdtemp(join(tmpdir(), "jeb-person-gate-"));
  cacheDirs.push(cacheDir);
  return cacheDir;
}
afterEach(async () => {
  await Promise.all(cacheDirs.splice(0).map((cacheDir) => rm(cacheDir, { recursive: true, force: true })));
});

// Body captured 2026-09-21 11:02 UTC from https://bitcoinops.org/en/podcast/2026/09/08.
const optechPodcast = {
  canonicalValue: "https://bitcoinops.org/en/podcast/2026/09/08",
  labels: ["news", "optech"],
  taxonomy: { domain: ["news"], type: [], subject: [], geography: [] },
  title: "Bitcoin Optech Newsletter #421 Recap Podcast",
  authors: ["Bitcoin Optech"],
  bodyText: "Mark “Murch” Erhardt, Gustavo Flores Echaiz, and Mike Schmidt are joined by average_gary, Erick Cestari, Conduition, and Greg Sanders to discuss Newsletter #421. Using silent payments for miner payouts in coinbase transaction.",
  provenance: { source: "news", configVersion: "test", decision: "accepted", timestamp: new Date(0).toISOString() },
} as ExternalResource;

describe("person gate inside the tagger", () => {
  it("drops model-proposed people, keeps the resource, and codes every drop for the manifest", async () => {
    const result = await tagResource(cfg, optechPodcast, {
      cacheDir: await freshCacheDir(),
      generate: async (prompt) => {
        expect(prompt).toContain("Never label people");
        return '["silent-payments","greg-sanders","erick-cestari","murch","mike-schmidt","podcast","conduition"]';
      },
      existingTags: async () => [],
    });
    expect(result.labels).toEqual(["news", "optech", "silent-payments", "podcast"]);
    expect(result.personGate?.dropped.map((drop) => `${drop.label}:${drop.reason}`)).toEqual([
      "greg-sanders:person-mention",
      "erick-cestari:person-mention",
      "murch:known-person",
      "mike-schmidt:known-person",
      "conduition:person-token",
    ]);
    expect(result.denials["person-gate:person-mention"]).toBe(2);
    expect(result.denials["person-gate:known-person"]).toBe(2);
    expect(result.denials["person-gate:person-token"]).toBe(1);
    expect(result.provenance["greg-sanders"]).toBe("person-gate:person-mention");
    expect(result.provenance["silent-payments"]).toBe("model");
  });

  it("fails closed on a given-name label when the fetch produced no body", async () => {
    const result = await tagResource(cfg, { ...optechPodcast, bodyText: undefined, title: "Recap", authors: [] }, {
      cacheDir: await freshCacheDir(),
      generate: async () => '["greg-sanders","silent-payments"]',
      existingTags: async () => [],
    });
    expect(result.labels).toEqual(["news", "optech", "silent-payments"]);
    expect(result.personGate?.dropped).toEqual([{ label: "greg-sanders", reason: "given-name", evidence: "no-body" }]);
  });

  it("gates rule labels too: a person entity match is no longer a label, a gazetteer name needs the title", () => {
    const lopp = discoverResources(
      [{ family: "url", category: "pubky", source: "staging-catalog", sourcePriority: 10, labels: ["release"], value: "https://github.com/jlopp", title: "Jameson Lopp on GitHub", description: "Jameson Lopp (lopp) — Casa co-founder" }],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(lopp.accepted[0]?.labels).not.toContain("jameson-lopp");
    expect(lopp.accepted[0]?.provenance.personGate).toBeUndefined();
    const satoshi = discoverResources(
      [{ family: "url", category: "pubky", source: "staging-catalog", sourcePriority: 10, labels: ["release"], value: "https://example.com/satoshi", title: "Who was Satoshi Nakamoto?", description: "Satoshi Nakamoto wrote the whitepaper." }],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(satoshi.accepted[0]?.labels).toContain("satoshi-nakamoto");
    const mention = discoverResources(
      [{ family: "url", category: "pubky", source: "staging-catalog", sourcePriority: 10, labels: ["release"], value: "https://example.com/gold", title: "Digital gold narrative", description: "Satoshi Nakamoto is quoted once." }],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(mention.accepted[0]?.labels).not.toContain("satoshi-nakamoto");
    expect(mention.accepted[0]?.provenance.personGate?.dropped).toEqual([{ label: "satoshi-nakamoto", reason: "gazetteer-not-about" }]);
  });

  it("drops operator labels that are directory verdict codes or category headers", () => {
    const run = discoverResources(
      [{ family: "url", category: "pubky", source: "staging-catalog", sourcePriority: 10, labels: ["release", "nosendreceive", "nosource", "people"], value: "https://example.com/wallet", title: "Some wallet" }],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted[0]?.labels).toEqual(["release"]);
  });
});
