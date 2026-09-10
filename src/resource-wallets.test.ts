import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  discoverWalletDirectory,
  parseLoppRecommendedWallets,
  parseWalletScrutinyMarkdown,
  type WalletDirectoryFixtures,
} from "./resource-wallets.js";

const sample = `---
wsId: sample.wallet
title: Sample Wallet
website: https://sample.wallet
verdict: reproducible
android:
  appId: sample.wallet
  users: 100000
  updated: 2026-08-01
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
    const unknown = sample.replace("verdict: reproducible", "verdict: emerging");
    const result = await discoverWalletDirectory({
      limit: 1,
      fixtures: fixtures({ markdown: { "_mobile/sample.md": unknown } }),
      websiteCheck: async () => true,
    });
    expect(result.accepted[0]?.labels).not.toContain("reproducible-build");
    expect(result.shadowReport.byVerdict).toEqual({ emerging: 1 });
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

  it("enforces the 100-record limit and request budget", async () => {
    await expect(discoverWalletDirectory({ limit: 101 })).rejects.toThrow("1 to 100");
    await expect(discoverWalletDirectory({
      limit: 1,
      maxRequests: 0,
      fetchImpl: async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
    })).rejects.toThrow(/request budget exceeded/);
  });

  it("accepts the captured Lopp fixture", async () => {
    const lopp = await readFile(new URL("./test-fixtures/wallets/n2-lopp.html", import.meta.url), "utf8");
    expect(parseLoppRecommendedWallets(lopp).parseFailed).toBe(false);
  });
});
