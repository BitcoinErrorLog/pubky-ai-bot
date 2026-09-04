import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../../../src/db.js";
import { configFromProcessEnv } from "../../../../src/config.js";
import { INTENT_REGEX_TABLES } from "../../../../src/intent.js";
import { ScoutClient } from "../scout/client.js";
import { createScoutTools } from "../scout/tools.js";
import { resetScoutBreakerForTests } from "../scout/circuit.js";
import { resetScoutSchemaCacheForTests } from "../scout/schema-cache.js";
import { queryNlq } from "./service.js";
import { goldenWithoutRel, identitySummaryRules, startNlqScoutStub } from "./stub.js";
import type { Config } from "../../../../src/config.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const USER = "1111111111111111111111111111111111111111111111111111";
const USERB = "2222222222222222222222222222222222222222222222222222";

const store = new Store(DB);

beforeAll(async () => {
  process.env.DATABASE_URL ??= DB;
  await store.migrate();
});

beforeEach(() => {
  resetScoutSchemaCacheForTests();
  resetScoutBreakerForTests();
});

afterEach(() => {
  resetScoutSchemaCacheForTests();
  resetScoutBreakerForTests();
});

function cfg(over: Partial<Config> = {}): Config {
  process.env.DATABASE_URL ??= DB;
  return { ...configFromProcessEnv({ requireSecret: false }), scoutEnabled: true, scoutRawEnabled: false, ...over };
}

function closeStub(server: { close: (cb: () => void) => void }): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("nlq schema fail-closed and guards", () => {
  it("returns schema_unavailable when /v1/schema cannot be fetched", async () => {
    const stub = await startNlqScoutStub({ schema: "fail" });
    const c = cfg({ scoutUrl: stub.url });
    const out = await queryNlq(
      { question: `who does ${USER} follow` },
      {
        cfg: c,
        pool: store.pool,
        tables: INTENT_REGEX_TABLES,
        client: new ScoutClient(c, store.pool),
      },
    );
    expect(out.outcome).toBe("schema_unavailable");
    expect(out.reason).toMatch(/schema is unavailable/i);
    expect(stub.calls).toEqual([]);
    await closeStub(stub.server);
  });

  it("rejects a planned template whose schema dependency is missing before any Scout query", async () => {
    const stub = await startNlqScoutStub({
      schema: goldenWithoutRel("FOLLOWS"),
      rules: identitySummaryRules(USER, USERB),
    });
    const c = cfg({ scoutUrl: stub.url });
    const out = await queryNlq(
      { question: `who does ${USER} follow` },
      {
        cfg: c,
        pool: store.pool,
        tables: INTENT_REGEX_TABLES,
        client: new ScoutClient(c, store.pool),
      },
    );
    expect(out.outcome).toBe("schema_unsupported");
    expect(out.reason).toMatch(/FOLLOWS|rel:FOLLOWS/i);
    expect(stub.calls).toEqual([]);
    await closeStub(stub.server);
  });

  it("rejects raw Cypher when the operator switch is off", async () => {
    const stub = await startNlqScoutStub({ rules: [{ status: 200, body: { results: [], count: 0, truncated: false } }] });
    const c = cfg({ scoutUrl: stub.url, scoutRawEnabled: false });
    const out = await queryNlq(
      { question: "MATCH (n:User) RETURN n.id LIMIT 5" },
      {
        cfg: c,
        pool: store.pool,
        tables: INTENT_REGEX_TABLES,
        client: new ScoutClient(c, store.pool),
      },
    );
    expect(out.outcome).toBe("guard_rejected");
    expect(out.reason).toMatch(/raw cypher disabled/i);
    expect(stub.calls).toEqual([]);
    await closeStub(stub.server);
  });

  it("returns budget_exhausted as a typed outcome", async () => {
    const stub = await startNlqScoutStub({ rules: identitySummaryRules(USER, USERB) });
    await store.pool.query("DELETE FROM scout_queries");
    await store.pool.query(
      `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok)
       VALUES ('search_posts', 'x', 'y', 0, false, 1, TRUE)`,
    );
    const c = cfg({ scoutUrl: stub.url, scoutDailyCeiling: 1 });
    const out = await queryNlq(
      { question: `who does ${USER} follow` },
      {
        cfg: c,
        pool: store.pool,
        tables: INTENT_REGEX_TABLES,
        client: new ScoutClient(c, store.pool),
      },
    );
    expect(out.outcome).toBe("budget_exhausted");
    expect(out.reason).toMatch(/graph lookup unavailable|daily_scout_ceiling/i);
    expect(stub.calls).toEqual([]);
    await store.pool.query("DELETE FROM scout_queries");
    await closeStub(stub.server);
  });
});

describe("nlq provenance matches the answer-loop Scout tool", () => {
  it("returns the same get_identity_summary object the answer loop tool would", async () => {
    const stub = await startNlqScoutStub({ rules: identitySummaryRules(USER, USERB) });
    const time_range = { since: 1_700_000_000_000, until: 1_700_086_400_000 };
    const c = cfg({ scoutUrl: stub.url });
    const client = new ScoutClient(c, store.pool);
    const tools = createScoutTools({
      cfg: c,
      pool: store.pool,
      storeSwitchOn: async () => false,
      client,
    });
    const direct = await tools.get_identity_summary.execute({ pubky: USER, time_range });
    resetScoutSchemaCacheForTests();
    const nlq = await queryNlq(
      { question: `who does ${USER} follow`, scope: { time_range } },
      { cfg: c, pool: store.pool, tables: INTENT_REGEX_TABLES, client },
    );
    expect(nlq.outcome).toBe("ok");
    expect(nlq.results[0]).toEqual(direct);
    expect(nlq.results[0]).toMatchObject({ provenance: "scout", tool: "get_identity_summary" });
    expect(nlq.toolTrace.length).toBeGreaterThan(0);
    await closeStub(stub.server);
  });
});
