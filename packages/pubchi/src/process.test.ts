import { afterEach, describe, expect, it } from "vitest";
import { runPubchiProcess } from "./process.js";
import { dummyNlqOpts } from "./test-helpers.js";
import { countingBrain } from "./test-helpers.js";

afterEach(() => {
  delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
  delete process.env.PUBKY_BOT_SECRET_KEY_FILE;
  delete process.env.PUBKY_BOT_MNEMONIC;
  delete process.env.PUBCHI_BIND_DANGEROUS;
});

describe("pubchi process posture", () => {
  it("refuses to start when PUBKY_BOT_* key material is present", async () => {
    process.env.PUBKY_BOT_SECRET_KEY_HEX = "ab".repeat(32);
    const brain = countingBrain(() => "");
    await expect(
      runPubchiProcess({
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
});
