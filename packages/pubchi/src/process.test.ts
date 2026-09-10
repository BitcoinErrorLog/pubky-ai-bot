import { afterEach, describe, expect, it, vi } from "vitest";
import { runPubchiProcess, sweepExpiredNoncesSafe } from "./process.js";
import { dummyNlqOpts } from "./test-helpers.js";
import { countingBrain } from "./test-helpers.js";

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
    const brain = countingBrain(() => "");
    const { pool, tables } = dummyNlqOpts();
    await expect(
      runPubchiProcess({
        mode: "runtime",
        cfg: {
          ...baseCfg,
          webProvider: "moonshot",
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

  it("boots Moonshot web search without an explicit base URL", async () => {
    process.env.PUBCHI_WEB_ENABLED = "1";
    const brain = countingBrain(() => "");
    const { pool, tables } = dummyNlqOpts();
    const stop = await runPubchiProcess({
      mode: "runtime",
      cfg: {
        ...baseCfg,
        webProvider: "moonshot",
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
