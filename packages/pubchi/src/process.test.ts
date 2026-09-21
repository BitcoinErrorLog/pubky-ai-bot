import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLoggedPubchiWebSearch,
  pubchiWebProviderTimeoutMs,
  runPubchiProcess,
  sweepExpiredNoncesSafe,
} from "./process.js";
import { memoryPubchiWebBudget } from "./web-search.js";
import { dummyNlqOpts } from "./test-helpers.js";
import { countingBrain } from "./test-helpers.js";
import { WebToolError } from "../bot-kit/web/error.js";
import { log } from "../bot-kit/log.js";

vi.mock("./http.js", () => ({
  listenPubchi: vi.fn(async () => ({
    server: {
      close(callback: () => void) {
        callback();
      },
    },
  })),
}));

afterEach(() => {
  delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
  delete process.env.PUBKY_BOT_SECRET_KEY_FILE;
  delete process.env.PUBKY_BOT_MNEMONIC;
  delete process.env.PUBCHI_BIND_DANGEROUS;
  delete process.env.PUBCHI_WEB_ENABLED;
  delete process.env.PUBCHI_WEB_PROVIDER;
  vi.restoreAllMocks();
});

describe("pubchi process posture", () => {
  const baseCfg = {
    databaseUrl: "postgres://127.0.0.1/unused",
    nexusUrl: "https://nexus.staging.pubky.app",
    scoutUrl: "https://nexus-scout.pubky.app",
    scoutEnabled: true,
    scoutTimeoutMs: 1000,
    scoutLimitMax: 10,
    scoutRawEnabled: false,
    scoutPerMentionCap: 12,
    scoutDailyCeiling: 400,
    scoutRawPerUserDaily: 8,
    scoutRawGlobalDaily: 40,
    scoutProfilePropMax: 3,
    scoutClaimantCap: 12,
    scoutMaxQps: 2,
    pubchiPort: 0,
    pubchiBind: "127.0.0.1",
    brain: "moonshot" as const,
    model: "kimi-k3",
    brainEgressDangerous: false,
  };

  it("keeps provider-specific web deadlines", () => {
    expect(pubchiWebProviderTimeoutMs("kimi")).toBe(7_500);
    expect(pubchiWebProviderTimeoutMs("brave")).toBe(2_500);
  });

  it("logs billed Kimi searches only, including capped and rejected results", async () => {
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const providerConfig = {
      webProvider: "kimi" as const,
      webEnabled: true,
      model: "kimi-k3",
      modelBaseUrl: "https://api.moonshot.ai/v1",
      modelApiKey: "test-key",
      webTimeoutMs: 7_500,
      webPerMentionCap: 1,
      webDailyCeiling: 500,
    };
    const run = async (
      owner: string,
      provider: () => Promise<{
        sources: Array<{ title: string; url: string; snippet: string }>;
        cost_usd?: number;
      }>,
    ) =>
      createLoggedPubchiWebSearch({
        providerConfig,
        owner,
        budget: memoryPubchiWebBudget(),
        logHashKey: "fixed-log-key",
        providers: { kimi: provider },
      }).search("private query text", 5);

    await run("owner-rejected", async () => ({
      sources: [{ title: "HTTP", url: "http://example.com", snippet: "rejected" }],
      cost_usd: 0.002,
    }));
    await run("owner-capped", async () => ({
      sources: Array.from({ length: 8 }, (_, index) => ({
        title: `Result ${index}`,
        url: `https://example.com/${index}`,
        snippet: "accepted",
      })),
      cost_usd: 0.002,
    }));
    for (const code of ["AUTH", "TIMEOUT", "EMPTY"]) {
      await run(`owner-${code}`, async () => {
        throw new WebToolError(code);
      });
    }
    await run("owner-billed-malformed", async () => {
      throw new WebToolError("PARSE", undefined, 0.002);
    });

    const records = info.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .filter((fields) => fields.event === "pubchi_web_cost");
    expect(records).toEqual([
      expect.objectContaining({
        provider: "kimi",
        usd: 0.002,
        owner_hash: expect.stringMatching(/^[a-f0-9]{8}$/),
        result_count: 0,
      }),
      expect.objectContaining({
        provider: "kimi",
        usd: 0.002,
        owner_hash: expect.stringMatching(/^[a-f0-9]{8}$/),
        result_count: 5,
      }),
      expect.objectContaining({
        provider: "kimi",
        usd: 0.002,
        owner_hash: expect.stringMatching(/^[a-f0-9]{8}$/),
        result_count: 0,
      }),
    ]);
    expect(records.every((record) => !/^[a-f0-9]{64}$/.test(String(record.owner_hash)))).toBe(true);
    expect(JSON.stringify(records)).not.toContain("private query text");
    expect(JSON.stringify(records)).not.toContain("test-key");
  });

  it("refuses to start when PUBKY_BOT_* key material is present", async () => {
    process.env.PUBKY_BOT_SECRET_KEY_HEX = "ab".repeat(32);
    const brain = countingBrain(() => "");
    await expect(
      runPubchiProcess({
        mode: "runtime",
        cfg: {
          databaseUrl: "postgres://127.0.0.1/unused",
          nexusUrl: "https://nexus.staging.pubky.app",
          scoutUrl: "https://nexus-scout.pubky.app",
          scoutEnabled: true,
          scoutTimeoutMs: 1000,
          scoutLimitMax: 10,
          scoutRawEnabled: false,
          scoutPerMentionCap: 12,
          scoutDailyCeiling: 400,
          scoutRawPerUserDaily: 8,
          scoutRawGlobalDaily: 40,
          scoutProfilePropMax: 3,
          scoutClaimantCap: 12,
          scoutMaxQps: 2,
          pubchiPort: 0,
          pubchiBind: "127.0.0.1",
          brain: "moonshot",
          model: "kimi-k3",
          brainEgressDangerous: false,
        },
        pool: dummyNlqOpts().pool,
        tables: dummyNlqOpts().tables,
        brain: brain.brain,
      }),
    ).rejects.toThrow(/key material must not be present/);
  });

  it("nonce sweeper swallows a rejected pool query", async () => {
    const pool = {
      query: async () => {
        throw new Error("db blip");
      },
    };
    await expect(sweepExpiredNoncesSafe(pool)).resolves.toBeUndefined();
  });

  it("rejects a bad web provider before the HTTP server is created", async () => {
    process.env.PUBCHI_WEB_ENABLED = "1";
    process.env.PUBCHI_WEB_PROVIDER = "kimi";
    const brain = countingBrain(() => "");
    const { pool, tables } = dummyNlqOpts();
    await expect(
      runPubchiProcess({
        mode: "runtime",
        cfg: {
          ...baseCfg,
          modelApiKey: "test-key",
          modelBaseUrl: "https://evil.example/v1",
        },
        pool,
        tables,
        storeSwitchOn: async () => true,
        brain: brain.brain,
      }),
    ).rejects.toThrow(/host is not allowed/);
  });

  it("selects Kimi from PUBCHI_WEB_PROVIDER without an explicit base URL", async () => {
    process.env.PUBCHI_WEB_ENABLED = "1";
    process.env.PUBCHI_WEB_PROVIDER = "kimi";
    const brain = countingBrain(() => "");
    const { pool, tables } = dummyNlqOpts();
    const stop = await runPubchiProcess({
      mode: "runtime",
      cfg: {
        ...baseCfg,
        webProvider: "kimi",
        modelApiKey: "test-key",
        modelBaseUrl: undefined,
      },
      pool,
      tables,
      storeSwitchOn: async () => true,
      brain: brain.brain,
    });
    await stop();
  });
});
