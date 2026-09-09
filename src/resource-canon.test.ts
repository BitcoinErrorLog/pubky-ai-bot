import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import { discoverResources } from "./external-resources.js";
import { tagResource } from "./resource-tagger.js";
import type { Config } from "./config.js";
import {
  BITCOIN_CANON_SOURCE_ID,
  candidateIdentity,
  capCanonCandidates,
  canonicalizeDelvingUrl,
  discoverBitcoinCanon,
  isCanonMetadataUrl,
  paperCandidates,
  parseBips,
  parseBolts,
  parseMailingLists,
  parseOptechNewsletters,
  parseOptechTopics,
  timeAnchorCandidates,
  toResourceInputs,
  type CanonCandidate,
} from "./resource-canon.js";

const bips = `
| [[bip-0001.mediawiki|1]]
| BIP Purpose and Guidelines
| Amir Taaki
| Process
| Final
|-
| [[bip-0002.mediawiki|2]]
| BIP Descriptive Metadata Format
| Amir Taaki
| Process
| Withdrawn
|-
| [[bip-0341.mediawiki|341]]
| Taproot: SegWit version 1 spending rules
| Pieter Wuille
| Standards Track
| Final
|-
`;
const bolts = `<a href="01-protocol.md">BOLT #1</a><a href="11-payment-encoding.md">BOLT #11</a>`;
const topics = `<a href="/en/topics/taproot/">Taproot</a><a href="/en/topics/segwit/">SegWit</a>`;
const newsletters = `<a href="/en/newsletters/2026/09/06/">latest</a><a href="/en/newsletters/2026/08/30/">prior</a>`;
const lists = `
<a href="https://gnusha.org/pi/bitcoindev/2024-January/000001.html">message</a>
<a href="https://delvingbitcoin.org/t/assumeutxo/123/4">thread</a>`;

function item(subSource: CanonCandidate["subSource"], index: number): CanonCandidate {
  const url = `https://example.org/${subSource}/${index}`;
  return {
    url,
    title: `${subSource} ${index}`,
    metadata: {},
    sourceId: BITCOIN_CANON_SOURCE_ID,
    subSource,
    authority: 5,
    durability: 5,
    score: { pubky_signal: 0, authority: 5, durability: 5, origin_engagement: 0, freshness: 0, cost_penalty: 0 },
  };
}

describe("bitcoin canon source adapter", () => {
  it("parses BIPs, excludes withdrawn status, and pins the extension", () => {
    const result = parseBips(bips);
    expect(result.map((entry) => entry.url)).toEqual([
      "https://github.com/bitcoin/bips/blob/master/bip-0001.mediawiki",
      "https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki",
    ]);
    expect(result.every((entry) => candidateIdentity(entry) === resourceIdentity(normalizeUri(entry.url)))).toBe(true);
  });

  it("parses BOLTs, Optech, and mailing-list canonical forms", () => {
    expect(parseBolts(bolts).map((entry) => entry.url)).toEqual([
      "https://github.com/lightning/bolts/blob/master/01-protocol.md",
      "https://github.com/lightning/bolts/blob/master/11-payment-encoding.md",
    ]);
    expect(parseOptechTopics(topics).map((entry) => entry.url).sort()).toEqual([
      "https://bitcoinops.org/en/topics/segwit/",
      "https://bitcoinops.org/en/topics/taproot/",
    ]);
    expect(parseOptechNewsletters(newsletters).map((entry) => entry.url).sort()).toEqual([
      "https://bitcoinops.org/en/newsletters/2026/08/30/",
      "https://bitcoinops.org/en/newsletters/2026/09/06/",
    ]);
    expect(parseMailingLists(lists).map((entry) => entry.url).sort()).toEqual([
      "https://delvingbitcoin.org/t/assumeutxo/123",
      "https://gnusha.org/pi/bitcoindev/2024-January/000001.html",
    ]);
  });

  it("pins parsed links to the source host and HTTPS", () => {
    const hostile = `
      <a href="https://evil.example/en/topics/evil/">evil</a>
      <a href="http://bitcoinops.org/en/topics/http/">downgrade</a>
      <a href="//evil.example/en/newsletters/2026/01/01/">protocol relative</a>
      <a href="/en/topics/real/">real</a>
      <a href="/en/newsletters/2026/01/01/?x=1">query</a>`;
    expect(parseOptechTopics(hostile).map((entry) => entry.url)).toEqual(["https://bitcoinops.org/en/topics/real/"]);
    expect(parseOptechNewsletters(hostile, new Date("2026-02-01")).map((entry) => entry.url)).toEqual([]);
    expect(parseMailingLists(`<a href="https://evil.example/t/x/1"></a><a href="http://delvingbitcoin.org/t/x/2"></a><a href="//evil.example/pi/bitcoindev/x"></a>`)).toEqual([]);
  });

  it("canonicalizes a Delving post-number suffix", () => {
    expect(canonicalizeDelvingUrl("https://delvingbitcoin.org/t/assumeutxo/123/4")).toBe("https://delvingbitcoin.org/t/assumeutxo/123");
  });

  it("rejects an HTTP candidate through the existing URL safety gate", () => {
    const run = discoverResources([{
      family: "url",
      value: "http://github.com/bitcoin/bips",
      source: BITCOIN_CANON_SOURCE_ID,
      labels: ["bitcoin"],
      taxonomy: { domain: ["bitcoin"], type: ["reference"] },
    }], { limit: 1, configVersion: "bitcoin-canon-test" });
    expect(run.accepted).toHaveLength(0);
    expect(run.rejected[0]?.reason).toBe("unsafe URL protocol");
  });

  it("lowercases DOI identity and retains the DOI canonical URL", () => {
    const [doi] = paperCandidates([{ doi: "10.1257/JEP.29.2.213", finalUrl: "https://www.jstor.org/stable/43684160", title: "Bitcoin" }]).filter((entry) => entry.metadata.doi === "10.1257/jep.29.2.213");
    expect(doi?.url).toBe("https://doi.org/10.1257/jep.29.2.213");
    expect(candidateIdentity(doi!)).toBe(resourceIdentity(normalizeUri("https://doi.org/10.1257/jep.29.2.213")));
  });

  it("pins time anchors to mempool block and transaction paths", () => {
    const result = timeAnchorCandidates([
      { name: "halving-210000", kind: "block", value: "0000000000000000000000000000000000000000000000000000000000000001", height: 210000 },
    ]);
    expect(result.some((entry) => entry.url === "https://mempool.space/block/0000000000000000000000000000000000000000000000000000000000000001")).toBe(true);
    expect(result.every((entry) => candidateIdentity(entry) === resourceIdentity(normalizeUri(entry.url)))).toBe(true);
  });

  it.each([
    ["63-char", "0".repeat(63)],
    ["uppercase", "A".repeat(64)],
    ["non-hex", `${"0".repeat(63)}g`],
  ])("rejects invalid anchor hash: %s", (_, value) => {
    expect(() => timeAnchorCandidates([{ name: "halving-210000", kind: "block", value, height: 210000 }])).toThrow(/invalid time anchor hash/);
  });

  it("resolves halving anchors through the guarded block-height fetch", async () => {
    const calls: string[] = [];
    const result = await discoverBitcoinCanon({
      enabled: ["time-anchors"],
      fetchText: async (url) => {
        calls.push(url);
        return "0000000000000000000000000000000000000000000000000000000000000001";
      },
    });
    expect(calls).toHaveLength(4);
    expect(result.some((entry) => entry.metadata.name === "halving-210000" &&
      entry.url === "https://mempool.space/block/0000000000000000000000000000000000000000000000000000000000000001")).toBe(true);
  });

  it("records and drops an invalid halving response", async () => {
    const logs: Record<string, unknown>[] = [];
    const result = await discoverBitcoinCanon({
      enabled: ["time-anchors"],
      fetchText: async () => "not-a-hash",
      log: (line) => logs.push(line),
    });
    expect(result.some((entry) => entry.metadata.name?.toString().startsWith("halving-"))).toBe(false);
    expect(logs).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "invalid_anchor_hash" })]));
  });

  it("keeps each time anchor context tied to its own name", () => {
    const anchors = timeAnchorCandidates([
      ...[210000, 420000, 630000, 840000].map((height) => ({
        name: `halving-${height}`,
        kind: "block" as const,
        value: `${height}`.padStart(64, "0"),
        height,
      })),
    ]);
    expect(anchors).toHaveLength(8);
    for (const anchor of anchors) {
      expect(anchor.bodyText).toContain(`${anchor.metadata.name}:`);
      if (anchor.metadata.kind === "block") {
        expect(anchor.bodyText?.toLowerCase()).not.toContain("pizza");
        expect(anchor.bodyText?.toLowerCase()).not.toContain("hanyecz");
      }
    }
    expect(anchors.find((anchor) => anchor.metadata.name === "segwit-activation")?.metadata.height).toBe(481824);
    expect(anchors.find((anchor) => anchor.metadata.name === "taproot-activation")?.metadata.height).toBe(709632);
    const pizza = anchors.find((anchor) => anchor.metadata.name === "pizza-transaction")!;
    expect(pizza.bodyText?.toLowerCase()).not.toContain("activation");
    expect(pizza.bodyText?.toLowerCase()).not.toContain("genesis");
  });

  it("passes transaction-anchor context to the model when no page body exists", async () => {
    const anchor = timeAnchorCandidates().find((entry) => entry.metadata.name === "pizza-transaction")!;
    expect(anchor.bodyText).toContain("10,000 BTC");
    const run = discoverResources([{
      ...toResourceInputs([anchor])[0]!,
      labels: [],
    }], { limit: 1, configVersion: "bitcoin-canon-test" });
    expect(run.accepted).toHaveLength(1);
    const cacheDir = await mkdtemp(join(tmpdir(), "jeb-canon-anchor-"));
    try {
      let prompt = "";
      const tagged = await tagResource({ model: "test-model" } as Config, run.accepted[0]!, {
        cacheDir,
        generate: async (value) => {
          prompt = value;
          return '["pizza-transaction","laszlo-hanyecz","first-commercial-transaction"]';
        },
      });
      expect(prompt).toContain("10,000 BTC");
      expect(tagged.labels.filter((label) => label !== "bitcoin").length).toBeGreaterThan(1);
    } finally {
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it("enforces a 100-record cap, source diversity quota, and five-record floor", () => {
    const sources = ["bips", "bolts", "optech-topics", "optech-newsletters", "mailing-lists", "papers", "time-anchors"] as const;
    const result = capCanonCandidates(Array.from({ length: 150 }, (_, index) => item(sources[index % sources.length]!, index)));
    expect(result).toHaveLength(100);
    for (const source of sources) {
      expect(result.filter((entry) => entry.subSource === source).length).toBeGreaterThanOrEqual(5);
      expect(result.filter((entry) => entry.subSource === source).length).toBeLessThanOrEqual(40);
    }
  });

  it("discovers fixture-backed candidates deterministically", async () => {
    const result = await discoverBitcoinCanon({
      limit: 40,
      fixtures: {
        bips: readFileSync(new URL("./test-fixtures/canon/bips-readme.mediawiki", import.meta.url), "utf8"),
        bolts: readFileSync(new URL("./test-fixtures/canon/bolts-readme.md", import.meta.url), "utf8"),
        optechTopics: readFileSync(new URL("./test-fixtures/canon/optech-topics.html", import.meta.url), "utf8"),
        optechNewsletters: readFileSync(new URL("./test-fixtures/canon/optech-newsletters.html", import.meta.url), "utf8"),
        mailingLists: `${readFileSync(new URL("./test-fixtures/canon/gnusha.html", import.meta.url), "utf8")}\n${readFileSync(new URL("./test-fixtures/canon/delving.html", import.meta.url), "utf8")}`,
        papers: JSON.parse(readFileSync(new URL("./test-fixtures/canon/papers.json", import.meta.url), "utf8")) as { doi: string; finalUrl: string; title: string }[],
        anchors: [210000, 420000, 630000, 840000].map((height) => ({
          name: `halving-${height}`, kind: "block" as const, value: `${height}`.padStart(64, "0"), height,
        })),
      },
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result).toEqual([...result].sort((a, b) => a.url.localeCompare(b.url)));
  });

  it("allows only Crossref work metadata through the canon metadata gate", () => {
    expect(isCanonMetadataUrl("https://api.crossref.org/works/10.1109%2FSP.2015.35")).toBe(true);
    expect(isCanonMetadataUrl("https://doi.org/10.1109/SP.2015.35")).toBe(false);
    expect(isCanonMetadataUrl("https://api.crossref.org/works/10.1109%2FSP.2015.35?token=secret")).toBe(false);
  });

  it("caps and sanitizes Crossref titles at parse time", async () => {
    const result = await discoverBitcoinCanon({
      enabled: ["papers"],
      fetchText: async () => JSON.stringify({ message: { title: [`safe\u202E\u0000${"x".repeat(600)}`] } }),
    });
    const paper = result.find((entry) => entry.subSource === "papers" && entry.metadata.doi === "10.1257/jep.29.2.213");
    expect(paper?.title).toHaveLength(512);
    expect(paper?.title).not.toContain("\u202E");
    expect(paper?.title).not.toContain("\u0000");
  });
});
