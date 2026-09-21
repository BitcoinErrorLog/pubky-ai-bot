import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverWalletDirectory,
  parseLoppRecommendedWallets,
  parseWalletScrutinyIndex,
  parseWalletScrutinyMarkdown,
  WALLET_DIRECTORY_MARKDOWN_MAX,
  type WalletDirectoryFixtures,
} from "./resource-wallets.js";
import { resetFetchState } from "./resource-fetch.js";

const publicDns = async () => [{ address: "93.184.216.34", family: 4 as const }];
const cacheDirs: string[] = [];

async function freshCacheDir(): Promise<string> {
  const cacheDir = await mkdtemp(`${tmpdir()}/jeb-resource-wallets-`);
  cacheDirs.push(cacheDir);
  return cacheDir;
}

afterEach(async () => {
  resetFetchState();
  await Promise.all(cacheDirs.splice(0).map((cacheDir) => rm(cacheDir, { recursive: true, force: true })));
});

const sample = `---
wsId: sample.wallet
title: Sample Wallet
website: https://sample.wallet
verdict: reproducible
android:
  appId: sample.wallet
  users: 100000
  updated: 2026-08-01
  verdict: reproducible
---`;

function fixtures(overrides: Partial<WalletDirectoryFixtures> = {}): WalletDirectoryFixtures {
  return {
    trees: {
      _mobile: [{ type: "blob", path: "_mobile/sample.md" }],
      _hardware: [],
      _desktop: [],
      _bearer: [],
    },
    markdown: { "_mobile/sample.md": sample },
    lopp: '<a href="https://example.com/wallet">Wallet</a>'.repeat(25),
    ...overrides,
  };
}

describe("wallet directory adapter", () => {
  it("parses front-matter and emits structured fields", () => {
    const result = parseWalletScrutinyMarkdown(sample);
    expect(result).toMatchObject({
      website: "https://sample.wallet/",
      title: "Sample Wallet",
      platforms: ["android"],
      verdict: "reproducible",
      users: 100000,
    });
  });

  it("rejects front-matter without a website", () => {
    expect(parseWalletScrutinyMarkdown("---\ntitle: Missing\n---")).toEqual({ reason: "missing website" });
  });

  it("merges Android and iOS entries by website", async () => {
    const ios = sample.replace("android:", "ios:").replace("appId: sample.wallet", "appId: sample.ios");
    const result = await discoverWalletDirectory({
      limit: 100,
      fixtures: fixtures({
        trees: {
          _mobile: [
            { type: "blob", path: "_mobile/android.md" },
            { type: "blob", path: "_mobile/ios.md" },
          ],
          _hardware: [],
          _desktop: [],
          _bearer: [],
        },
        markdown: { "_mobile/android.md": sample, "_mobile/ios.md": ios },
        lopp: "",
      }),
      websiteCheck: async () => true,
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.metadata?.platforms).toEqual(["android", "ios"]);
    expect(result.shadowReport.byPlatform).toEqual({ android: 1, ios: 1 });
  });

  it("maps known verdicts and leaves unknown verdicts unlabeled", async () => {
    const unknown = sample.replace("  verdict: reproducible", "  verdict: emerging");
    const result = await discoverWalletDirectory({
      limit: 1,
      fixtures: fixtures({ markdown: { "_mobile/sample.md": unknown } }),
      websiteCheck: async () => true,
    });
    expect(result.accepted[0]?.labels).not.toContain("reproducible-build");
    expect(result.shadowReport.byVerdict).toEqual({ emerging: 1 });
  });

  it("reads live per-platform verdicts and emits Coinbase custodial", async () => {
    const markdown = await readFile(new URL("./test-fixtures/wallets/n2-ws-com.coinbase.android.md", import.meta.url), "utf8");
    const parsed = parseWalletScrutinyMarkdown(markdown);
    expect(parsed).toMatchObject({ verdict: "custodial", metadata: { verdicts: ["custodial"] } });
    const result = await discoverWalletDirectory({
      limit: 1,
      fixtures: fixtures({
        trees: { _mobile: [{ type: "blob", path: "_mobile/coinbase.md" }], _hardware: [], _desktop: [], _bearer: [] },
        markdown: { "_mobile/coinbase.md": markdown },
        lopp: "",
      }),
      websiteCheck: async () => true,
    });
    expect(result.accepted[0]?.labels).toContain("custodial");
  });

  it("reads Muun iPhone and Android verdicts and Lightning feature", async () => {
    const markdown = await readFile(new URL("./test-fixtures/wallets/n2-ws-io.muun.apollo.md", import.meta.url), "utf8");
    const parsed = parseWalletScrutinyMarkdown(markdown);
    expect(parsed).toMatchObject({ verdict: "sourceavailable", platforms: ["android", "ios"] });
    const result = await discoverWalletDirectory({
      limit: 1,
      fixtures: fixtures({
        trees: { _mobile: [{ type: "blob", path: "_mobile/muun.md" }], _hardware: [], _desktop: [], _bearer: [] },
        markdown: { "_mobile/muun.md": markdown },
        lopp: "",
      }),
      websiteCheck: async () => true,
    });
    expect(result.accepted[0]?.labels).toEqual(expect.arrayContaining(["sourceavailable", "lightning"]));
  });

  it("rejects a removed platform with a bounded reason", async () => {
    const markdown = await readFile(new URL("./test-fixtures/wallets/n2-ws-a3.pay.app.md", import.meta.url), "utf8");
    expect(parseWalletScrutinyMarkdown(markdown)).toEqual({ reason: "no surviving platform" });
  });

  it("orders useful wallets by users before applying the limit", async () => {
    const low = sample.replace("https://sample.wallet", "https://low.wallet").replace("100000", "1000");
    const high = sample.replace("https://sample.wallet", "https://high.wallet").replace("100000", "50000000");
    const result = await discoverWalletDirectory({
      limit: 1,
      fixtures: fixtures({
        trees: {
          _mobile: [{ type: "blob", path: "_mobile/low.md" }, { type: "blob", path: "_mobile/high.md" }],
          _hardware: [],
          _desktop: [],
          _bearer: [],
        },
        markdown: { "_mobile/low.md": low, "_mobile/high.md": high },
        lopp: "",
      }),
      websiteCheck: async () => true,
    });
    expect(result.accepted[0]?.canonicalValue).toBe("https://high.wallet/");
  });

  it("fails closed when Lopp has fewer than twenty links", () => {
    expect(parseLoppRecommendedWallets("<a href=\"https://example.com\">one</a>")).toEqual({
      urls: ["https://example.com/"],
      parseFailed: true,
    });
  });

  it("skips existing resources and unreachable websites", async () => {
    const result = await discoverWalletDirectory({
      limit: 100,
      fixtures: fixtures({
        existingWebsites: ["https://sample.wallet"],
        lopp: "",
      }),
      websiteCheck: async () => false,
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected.some((item) => item.reason === "parse-failed")).toBe(true);
  });

  it("enforces the 100-record limit and fails closed without crashing when the request budget is exhausted", async () => {
    await expect(discoverWalletDirectory({ limit: 101 })).rejects.toThrow("1 to 100");
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    const run = await discoverWalletDirectory({
      limit: 1,
      maxRequests: 0,
      fetchImpl,
      dnsLookup: publicDns,
      cacheDir: await freshCacheDir(),
      hostDelayMs: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(run.shadowReport.byRejectionReason["request-budget-exhausted"]).toBeGreaterThanOrEqual(1);
    expect(run.shadowReport.requests).toBe(0);
  });

  it("keeps a full run with 4000 index entries and 60 Lopp links within the 100-request budget", async () => {
    const apps = Array.from({ length: 4000 }, (_, index) => `{appId:"app${index}",users:${4000 - index},verdict:"sourceavailable"}`).join(",");
    const index = `const data={mobile:{apps:[${apps}]},hardware:{apps:[]},desktop:{apps:[]}};`;
    const markdown: Record<string, string> = {};
    for (let index = 0; index < WALLET_DIRECTORY_MARKDOWN_MAX; index += 1) {
      markdown[`_mobile/app${index}.md`] = sample.replace(/sample\.wallet/g, `w${index}.example`);
    }
    const loppHtml = Array.from({ length: 60 }, (_, index) => `<a href="https://lopp-${index}.example/wallet">w</a>`).join("");
    let calls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls += 1;
      const url = String(input);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /", { status: 200 });
      if (url === "https://www.lopp.net/bitcoin-information/recommended-wallets.html") {
        return new Response(loppHtml, { headers: { "content-type": "text/html" } });
      }
      return new Response("<html>ok</html>", { headers: { "content-type": "text/html" } });
    });
    const run = await discoverWalletDirectory({
      limit: 100,
      fixtures: { index, markdown },
      fetchImpl,
      dnsLookup: publicDns,
      cacheDir: await freshCacheDir(),
      hostDelayMs: 0,
    });
    expect(calls).toBeLessThanOrEqual(100);
    expect(run.shadowReport.requests).toBeLessThanOrEqual(100);
    expect(run.shadowReport.byRejectionReason["request-budget-exhausted"]).toBeGreaterThanOrEqual(1);
    expect(run.accepted.length).toBeGreaterThan(0);
  });

  it("fails closed with a counted reason and halt when the Lopp fetch returns HTTP 500", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/robots.txt")
      ? new Response("User-agent: *\nAllow: /", { status: 200 })
      : new Response("server error", { status: 500 }));
    const run = await discoverWalletDirectory({
      limit: 10,
      fixtures: fixtures({ lopp: undefined }),
      fetchImpl,
      dnsLookup: publicDns,
      cacheDir: await freshCacheDir(),
      hostDelayMs: 0,
      websiteCheck: async () => true,
    });
    expect(run.shadowReport.halt).toEqual({ reason: "source-unavailable" });
    expect(run.shadowReport.byRejectionReason["lopp-unavailable HTTP 500"]).toBe(1);
    expect(run.accepted.length).toBeGreaterThan(0);
    expect(run.accepted.every((item) => item.metadata?.sourceSubSource !== "lopp")).toBe(true);
  });

  it("fails closed when the WalletScrutiny index fetch returns HTTP 500", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/robots.txt")
      ? new Response("User-agent: *\nAllow: /", { status: 200 })
      : new Response("server error", { status: 500 }));
    const run = await discoverWalletDirectory({
      limit: 10,
      fixtures: { lopp: "" },
      fetchImpl,
      dnsLookup: publicDns,
      cacheDir: await freshCacheDir(),
      hostDelayMs: 0,
      websiteCheck: async () => true,
    });
    expect(run.shadowReport.halt).toEqual({ reason: "source-unavailable" });
    expect(run.shadowReport.byRejectionReason["index-unavailable HTTP 500"]).toBe(1);
    expect(run.accepted).toHaveLength(0);
  });

  it("fails closed when a GitLab markdown fetch returns HTTP 500", async () => {
    const index = 'const data={mobile:{apps:[{appId:"ok",users:1e6,verdict:"sourceavailable"}]},hardware:{apps:[]},desktop:{apps:[]}};';
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/robots.txt")
      ? new Response("User-agent: *\nAllow: /", { status: 200 })
      : new Response("server error", { status: 500 }));
    const run = await discoverWalletDirectory({
      limit: 10,
      fixtures: { index, lopp: "" },
      fetchImpl,
      dnsLookup: publicDns,
      cacheDir: await freshCacheDir(),
      hostDelayMs: 0,
      websiteCheck: async () => true,
    });
    expect(run.shadowReport.halt).toEqual({ reason: "source-unavailable" });
    expect(run.shadowReport.byRejectionReason["markdown-unavailable HTTP 500"]).toBe(1);
    expect(run.accepted).toHaveLength(0);
  });

  it("applies the verdict denylist to the merged index and markdown verdict set", async () => {
    const index = 'const data={mobile:{apps:[{appId:"nb",users:1e6}]},hardware:{apps:[]},desktop:{apps:[]}};';
    const markdown = sample.replace(/verdict: reproducible/g, "verdict: nobtc");
    const run = await discoverWalletDirectory({
      limit: 10,
      fixtures: { index, markdown: { "_mobile/nb.md": markdown }, lopp: "" },
      websiteCheck: async () => true,
    });
    expect(run.accepted).toHaveLength(0);
    expect(run.shadowReport.byRejectionReason["verdict-denylisted"]).toBe(1);
  });

  it("rejects a truncated index body with a counted reason and halt, never parsing it", async () => {
    const oversized = 'const data={mobile:{apps:[{appId:"ok",users:1e6,verdict:"sourceavailable"}]}};' + " ".repeat(4 * 1024 * 1024);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/robots.txt")
      ? new Response("User-agent: *\nAllow: /", { status: 200 })
      : new Response(oversized, { headers: { "content-type": "application/javascript" } }));
    const run = await discoverWalletDirectory({
      limit: 10,
      fixtures: { markdown: { "_mobile/ok.md": sample.replace(/sample\.wallet/g, "ok.example") }, lopp: "" },
      fetchImpl,
      dnsLookup: publicDns,
      cacheDir: await freshCacheDir(),
      hostDelayMs: 0,
      websiteCheck: async () => true,
    });
    expect(run.shadowReport.byRejectionReason["index-truncated"]).toBe(1);
    expect(run.shadowReport.halt).toEqual({ reason: "source-unavailable" });
    expect(run.accepted).toHaveLength(0);
  });

  it("honours the index 4 MB bound instead of truncating at the generic 2 MB cap", async () => {
    const padded = 'const data={mobile:{apps:[{appId:"ok",users:1e6,verdict:"sourceavailable"}]}};' + " ".repeat(3 * 1024 * 1024);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/robots.txt")
      ? new Response("User-agent: *\nAllow: /", { status: 200 })
      : new Response(padded, { headers: { "content-type": "application/javascript" } }));
    const run = await discoverWalletDirectory({
      limit: 10,
      fixtures: { markdown: { "_mobile/ok.md": sample.replace(/sample\.wallet/g, "ok.example") }, lopp: "" },
      fetchImpl,
      dnsLookup: publicDns,
      cacheDir: await freshCacheDir(),
      hostDelayMs: 0,
      websiteCheck: async () => true,
    });
    expect(run.shadowReport.halt).toBeNull();
    expect(run.shadowReport.byRejectionReason["index-truncated"]).toBeUndefined();
    expect(run.accepted.map((item) => item.canonicalValue)).toContain("https://ok.example/");
  });

  it("pins the Lopp fetch through the outbound read gate", async () => {
    await expect(discoverWalletDirectory({
      limit: 1,
      fixtures: fixtures({ lopp: undefined }),
      loppUrl: "https://evil.example/wallets.html",
      fetchImpl: async () => new Response("ok"),
      websiteCheck: async () => true,
    })).rejects.toThrow("resource read egress refused");
  });

  it("checks Lopp URLs against already-tagged Nexus resources", async () => {
    const links = Array.from({ length: 21 }, (_, index) => `<a href="https://l${index}.example/">L${index}</a>`).join("");
    const checked: string[] = [];
    const run = await discoverWalletDirectory({
      limit: 30,
      fixtures: { index: "const data={mobile:{apps:[]},hardware:{apps:[]},desktop:{apps:[]}};", lopp: links },
      websiteCheck: async () => true,
      isAlreadyTagged: async (url) => {
        checked.push(url);
        return url === "https://l5.example/";
      },
    });
    expect(checked).toContain("https://l5.example/");
    expect(run.accepted.map((item) => item.canonicalValue)).not.toContain("https://l5.example/");
    expect(run.accepted).toHaveLength(20);
  });

  it("rejects index appIds that could traverse the GitLab raw path", async () => {
    const index = 'const data={mobile:{apps:[{appId:"_mobile/../../admin",users:9e9},{appId:"dot..dot",users:8e9},{appId:"ok",users:1e6,verdict:"sourceavailable"}]},hardware:{apps:[]},desktop:{apps:[]}};';
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response("unused", { status: 500 });
    });
    const run = await discoverWalletDirectory({
      limit: 10,
      fixtures: { index, markdown: { "_mobile/ok.md": sample.replace(/sample\.wallet/g, "ok.example") }, lopp: "" },
      fetchImpl,
      dnsLookup: publicDns,
      cacheDir: await freshCacheDir(),
      hostDelayMs: 0,
      websiteCheck: async () => true,
    });
    expect(run.shadowReport.byRejectionReason["invalid-app-id"]).toBe(2);
    expect(requested.every((url) => !url.includes("admin") && !url.includes(".."))).toBe(true);
    expect(run.accepted.map((item) => item.canonicalValue)).toContain("https://ok.example/");
  });

  it("accepts the captured Lopp fixture", async () => {
    const lopp = await readFile(new URL("./test-fixtures/wallets/n2-lopp.html", import.meta.url), "utf8");
    expect(parseLoppRecommendedWallets(lopp).parseFailed).toBe(false);
  });

  it("parses the bounded live index slice, exponent users, HTML titles, and nested arrays", async () => {
    const index = await readFile(new URL("./test-fixtures/wallets/n2-walletscrutiny-index-slice.js", import.meta.url), "utf8");
    const entries = parseWalletScrutinyIndex(index);
    expect(entries.length).toBeGreaterThan(20);
    expect(parseWalletScrutinyIndex('const data={mobile:{apps:[{appId:"x",title:"Coldlar - Crypto &amp; Web3 Wallet"}]}};')[0]?.title)
      .toBe("Coldlar - Crypto & Web3 Wallet");
    expect(parseWalletScrutinyIndex('const data={mobile:{apps:[{appId:"x",users:5e5,features:["ln",["nested"]],title:"A &amp; B"}]}};')[0]).toMatchObject({
      users: 500000,
      title: "A & B",
      features: ["ln"],
    });
  });

  it("rejects truncated and hostile aggregate index input", () => {
    const valid = 'const data={mobile:{apps:[{appId:"x",title:"};,x:",users:1e2}]}};';
    expect(parseWalletScrutinyIndex(valid)[0]?.users).toBe(100);
    expect(() => parseWalletScrutinyIndex(valid.slice(0, -3))).toThrow();
  });

  it("ranks the full index before fetching markdown and excludes nobtc", async () => {
    const index = 'const data={mobile:{apps:[{appId:"low",users:1e5,verdict:"sourceavailable"},{appId:"coinbase",users:5e7,verdict:"custodial"},{appId:"alt",users:9e7,verdict:"nobtc",features:["ln"]}]},hardware:{apps:[{appId:"hw",score:[9,10],verdict:"sourceavailable"}]},desktop:{apps:[]}};';
    const markdown = (url: string, platform = "android") => sample
      .replace("https://sample.wallet", url)
      .replace("sample.wallet", url.replace(/https?:\/\//, "").replace(/\//g, ""))
      .replace("reproducible", "sourceavailable")
      .replace("android:", `${platform}:`);
    const result = await discoverWalletDirectory({
      limit: 3,
      fixtures: {
        index,
        markdown: {
          "_mobile/coinbase.md": markdown("https://coinbase.example"),
          "_mobile/low.md": markdown("https://low.example"),
          "_hardware/hw.md": markdown("https://hardware.example", "hardware"),
        },
        lopp: "",
      },
      websiteCheck: async () => true,
    });
    expect(result.accepted[0]?.canonicalValue).toBe("https://coinbase.example/");
    expect(result.accepted.map((item) => item.canonicalValue)).toEqual(expect.arrayContaining([
      "https://low.example/",
      "https://hardware.example/",
    ]));
    expect(result.accepted.find((item) => item.canonicalValue.includes("hardware"))?.labels).toContain("hardware-wallet");
    expect(result.accepted.every((item) => !item.canonicalValue.includes("alt"))).toBe(true);
  });

  it("adds lightning and bitcoin domain only from index support", async () => {
    const index = 'const data={mobile:{apps:[{appId:"ln",users:1e6,verdict:"sourceavailable",features:["ln"]},{appId:"alt",users:2e6,verdict:"nobtc"}]},hardware:{apps:[]},desktop:{apps:[]}};';
    const ln = sample.replace("https://sample.wallet", "https://ln.example");
    const result = await discoverWalletDirectory({
      limit: 1,
      fixtures: { index, markdown: { "_mobile/ln.md": ln }, lopp: "" },
      websiteCheck: async () => true,
    });
    expect(result.accepted[0]?.labels).toEqual(expect.arrayContaining(["lightning", "android", "wallet"]));
    expect(result.accepted[0]?.taxonomy.domain).toEqual(["bitcoin"]);
  });
});
