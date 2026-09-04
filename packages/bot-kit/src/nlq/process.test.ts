import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../../../../src/db.js";
import { configFromProcessEnv } from "../../../../src/config.js";
import { INTENT_REGEX_TABLES } from "../../../../src/intent.js";
import { listenNlq, nlqBind } from "./http.js";
import { runNlqProcess } from "./process.js";
import { startNlqScoutStub } from "./stub.js";
import { resetScoutSchemaCacheForTests } from "../scout/schema-cache.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const store = new Store(DB);

beforeAll(async () => {
  process.env.DATABASE_URL ??= DB;
  await store.migrate();
});

afterEach(() => {
  resetScoutSchemaCacheForTests();
  delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
  delete process.env.PUBKY_BOT_SECRET_KEY_FILE;
  delete process.env.PUBKY_BOT_MNEMONIC;
});

describe("nlq process posture", () => {
  it("defaults the HTTP bind to loopback", async () => {
    expect(nlqBind(undefined)).toBe("127.0.0.1");
    expect(nlqBind("")).toBe("127.0.0.1");
    const stub = await startNlqScoutStub();
    const cfg = { ...configFromProcessEnv({ requireSecret: false }), scoutUrl: stub.url, scoutEnabled: true };
    const listening = await listenNlq({
      cfg,
      pool: store.pool,
      tables: INTENT_REGEX_TABLES,
      port: 0,
    });
    const addr = listening.server.address();
    expect(addr && typeof addr === "object" ? addr.address : "").toBe("127.0.0.1");
    await new Promise<void>((resolve) => listening.server.close(() => resolve()));
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });

  it("refuses to start when PUBKY_BOT_* key material is present", async () => {
    process.env.PUBKY_BOT_SECRET_KEY_HEX = "ab".repeat(32);
    const stub = await startNlqScoutStub();
    const cfg = {
      ...configFromProcessEnv({ requireSecret: false }),
      scoutUrl: stub.url,
      scoutEnabled: true,
      nlqPort: 0,
    };
    await expect(runNlqProcess({ cfg, pool: store.pool, tables: INTENT_REGEX_TABLES })).rejects.toThrow(
      /key material must not be present/,
    );
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });
});
