import { describe, expect, it } from "vitest";
import { discoverResources, resourceIdentity } from "./external-resources.js";

const input = (value: string, title?: string) => ({ family: "url" as const, value, source: "web-index-direct", labels: [], title });

describe("configuration-driven resource classification", () => {
  it.each([
    ["https://bitcoin.org/", ["bitcoin", "documentation"]],
    ["https://bitcoin.org/en/developer-guide", ["bitcoin", "developer"]],
    ["https://en.bitcoin.it/wiki/Bitcoin", ["bitcoin", "wiki"]],
    ["https://github.com/bitcoin/bips/blob/master/bip-0054.md", ["bitcoin", "bip", "spec"]],
    ["https://github.com/bitcoin/bitcoin/pull/1", ["bitcoin", "pull-request"]],
    ["https://github.com/bitcoin/bitcoin/issues/1", ["bitcoin", "issue"]],
    ["https://github.com/bitcoin/bitcoin/releases/tag/v1", ["bitcoin", "release"]],
    ["https://github.com/lightning/bolts/blob/master/ ರಾಜ.md", ["lightning", "bolt", "spec"]],
    ["https://github.com/lightningnetwork/lnd", ["lightning", "software"]],
    ["https://github.com/ElementsProject/lightning", ["lightning", "software"]],
    ["https://github.com/ACINQ/eclair", ["lightning", "software"]],
    ["https://github.com/lightningdevkit/ldk", ["lightning", "software"]],
    ["https://bitcoinops.org/en/newsletters/1", ["bitcoin", "newsletter"]],
    ["https://bitcoinops.org/en/topics/fees", ["bitcoin", "topic"]],
    ["https://mempool.space/", ["bitcoin", "explorer", "tool"]],
    ["https://blockstream.info/", ["bitcoin", "explorer"]],
    ["https://store.blockstream.com/products/jade", ["bitcoin", "merchant", "hardware"]],
    ["https://blog.blockstream.com/article", ["article"]],
    ["https://docs.example.org/docs/guide", ["documentation"]],
    ["https://open.spotify.com/track/1", ["music", "music-track"]],
    ["https://open.spotify.com/album/1", ["music", "music-album"]],
    ["https://open.spotify.com/artist/1", ["music", "music-artist"]],
    ["https://open.spotify.com/playlist/1", ["music", "music-playlist"]],
    ["https://artist.bandcamp.com/", ["music", "music-artist"]],
    ["https://bandcamp.com/track/1", ["music", "music-track"]],
    ["https://soundcloud.com/artist/track", ["music", "music-track"]],
    ["https://soundcloud.com/sets/1", ["music", "music-playlist"]],
    ["https://discogs.com/release/1", ["music", "music-album"]],
    ["https://discogs.com/label/1", ["music", "music-label"]],
    ["https://musicbrainz.org/recording/1", ["music", "music-track"]],
    ["https://music.apple.com/us/album/1", ["music", "music-album"]],
    ["https://bbc.com/", ["news", "homepage"]],
    ["https://python.org/", ["software", "programming", "homepage"]],
    ["https://rust-lang.org/", ["software", "programming", "homepage"]],
    ["https://nostr.com/", ["nostr", "homepage"]],
    ["https://www.coindesk.com/", ["news", "homepage"]],
    ["https://www.python.org/", ["software", "programming", "homepage"]],
    ["https://www.rust-lang.org/", ["software", "programming", "homepage"]],
    ["https://www.theverge.com/", ["news", "homepage"]],
    ["https://www.wired.com/", ["news", "homepage"]],
    ["https://www.bbc.com/news", ["news", "homepage"]],
    ["https://blockstream.com/", ["bitcoin", "homepage", "company"]],
    ["https://blog.blockstream.com/article", ["bitcoin", "article"]],
    ["https://delvingbitcoin.org/t/example", ["bitcoin", "research", "discussion"]],
    ["https://bitcoincore.org/en/releases/", ["bitcoin", "bitcoin-core", "release"]],
    ["https://github.com/bitcoin-core/bitcoin/wiki/Build", ["bitcoin", "bitcoin-core", "wiki"]],
    ["https://btcpayserver.org/", ["bitcoin", "software", "payments"]],
    ["https://github.com/btcpayserver/btcpayserver", ["bitcoin", "software", "payments"]],
    ["https://github.com/utreexo/utreexod", ["bitcoin", "software", "research"]],
    ["https://github.com/jlopp/physical-bitcoin-attacks", ["bitcoin", "security", "research"]],
    ["https://en.wikipedia.org/wiki/Bitcoin", ["reference", "wikipedia", "bitcoin"]],
    ["https://en.wikipedia.org/wiki/Cryptography", ["reference", "wikipedia", "cryptography"]],
    ["https://developer.mozilla.org/en-US/", ["documentation", "web"]],
    ["https://stackoverflow.com/questions", ["programming", "qa"]],
    ["https://github.com/", ["software", "homepage"]],
  ])("classifies %s", (url, tags) => {
    const run = discoverResources([input(url)], { limit: 100, configVersion: "test-v2" });
    expect(run.rejected).toHaveLength(0);
    expect(run.accepted[0]?.labels).toEqual(expect.arrayContaining(tags));
  });

  it("rejects unknown and untyped music URLs without manual review", () => {
    const run = discoverResources(
      [input("https://unknown.example/"), input("https://open.spotify.com/")],
      { limit: 100, configVersion: "test-v2" },
    );
    expect(run.rejected.map((item) => item.reason)).toEqual(["music host has no recognisable type", "no taxonomy match"]);
  });

  it("does not call a store page documentation", () => {
    const run = discoverResources([input("https://store.blockstream.com/products/jade")], { limit: 100, configVersion: "test-v2" });
    expect(run.accepted[0]?.labels).not.toContain("documentation");
  });

  it("matches www aliases without changing canonical identity", () => {
    const run = discoverResources([input("https://bitcoin.org/"), input("https://www.bitcoin.org/")], { limit: 100, configVersion: "test-v2" });
    expect(run.accepted[0]?.labels).toEqual(run.accepted[1]?.labels);
    expect(run.accepted[0]?.identity).not.toBe(run.accepted[1]?.identity);
  });

  it("strips repeated www labels without changing canonical identity", () => {
    const run = discoverResources([input("https://www.www.bitcoin.org/")], { limit: 100, configVersion: "test-v2" });
    expect(run.rejected).toHaveLength(0);
    expect(run.accepted[0]?.labels).toEqual(expect.arrayContaining(["bitcoin", "documentation"]));
    expect(run.accepted[0]?.identity).not.toBe(resourceIdentity("https://bitcoin.org/"));
  });

  it("matches host suffixes only at domain boundaries", () => {
    const run = discoverResources([input("https://blog.blockstream.com/"), input("https://notblockstream.com/")], { limit: 100, configVersion: "test-v2" });
    expect(run.accepted[0]?.labels).toEqual(expect.arrayContaining(["bitcoin", "article"]));
    expect(run.rejected[0]?.reason).toBe("no taxonomy match");
  });

  it("reports explicit rule exclusions", () => {
    const run = discoverResources(
      [
        input("https://rewards.blockstream.com/froggy"),
        input("https://www.www.rewards.blockstream.com/froggy"),
        input("https://xn--rwards-3of.blockstream.com/froggy"),
        input("https://bitcoincore.org/bin/bitcoin-core"),
      ],
      { limit: 100, configVersion: "test-v2" },
    );
    expect(run.rejected).toHaveLength(4);
    expect(run.rejected.every((item) => item.reason === "excluded by rule")).toBe(true);
    expect(run.shadowReport.byRule["blockstream.rewards-excluded"]).toBe(3);
    expect(run.shadowReport.byRule["bitcoincore.bin-excluded"]).toBe(1);
  });

  it("does not apply the IDN policy to unmatched IDN apexes", () => {
    const run = discoverResources([input("https://xn--80ak6aa92e.com/")], { limit: 100, configVersion: "test-v2" });
    expect(run.rejected[0]?.reason).toBe("no taxonomy match");
  });

  it("rejects IDN subdomains under curated host suffixes", () => {
    const run = discoverResources([input("https://xn--shop.blockstream.com/")], { limit: 100, configVersion: "test-v2" });
    expect(run.rejected[0]?.reason).toBe("idn host under curated domain");
  });

  it("is deterministic and reports tags and rules", () => {
    const values = [input("https://github.com/bitcoin/bips/pull/1"), input("https://open.spotify.com/track/1")];
    const first = discoverResources(values, { limit: 100, configVersion: "test-v2" });
    const second = discoverResources(values, { limit: 100, configVersion: "test-v2" });
    expect(second.accepted.map(({ provenance: _provenance, ...resource }) => resource)).toEqual(
      first.accepted.map(({ provenance: _provenance, ...resource }) => resource),
    );
    expect(first.shadowReport.byTag.bip).toBe(1);
    expect(first.shadowReport.byRule["bitcoin.bips"]).toBe(1);
    expect(first.accepted[0]?.rules.length).toBeGreaterThan(0);
  });

  it("orders spec pages above Bitcoin homepages and news homepages", () => {
    const run = discoverResources(
      [input("https://github.com/bitcoin/bips/blob/master/bip-0054.md"), input("https://bitcoin.org/"), input("https://bbc.com/")],
      { limit: 100, configVersion: "test-v2" },
    );
    const score = (url: string) => run.accepted.find((resource) => resource.canonicalValue === url)?.score ?? 0;
    expect(score("https://github.com/bitcoin/bips/blob/master/bip-0054.md")).toBeGreaterThan(score("https://bitcoin.org/"));
    expect(score("https://bitcoin.org/")).toBeGreaterThan(score("https://bbc.com/"));
  });

  it("caps output labels using the shared label policy", () => {
    const run = discoverResources([{
      ...input("https://github.com/bitcoin/bitcoin/releases/"),
      taxonomy: { subject: ["one", "two", "three", "four", "five", "six"] },
    }], { limit: 100, configVersion: "test-v2" });
    expect(run.accepted[0]?.labels.length).toBeLessThanOrEqual(5);
    expect(run.accepted.every((resource) => resource.labels.length >= 1)).toBe(true);
    expect(run.accepted[0]?.labels.every((tag) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag))).toBe(true);
  });
});
