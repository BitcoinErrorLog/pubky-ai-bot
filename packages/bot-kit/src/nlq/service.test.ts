import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Store, switchOnSql } from "../../../../src/db.js";
import { configFromProcessEnv } from "../../../../src/config.js";
import { INTENT_REGEX_TABLES } from "../../../../src/intent.js";
import { ScoutClient } from "../scout/client.js";
import { createScoutTools } from "../scout/tools.js";
import { noteScoutOutcome, resetScoutBreakerForTests } from "../scout/circuit.js";
import {
  ensureScoutSchemaCache,
  refreshScoutSchema,
  resetScoutSchemaCacheForTests,
  setActiveScoutSchemaForTests,
} from "../scout/schema-cache.js";
import { loadGoldenScoutGraph } from "../scout/schema-model.js";
import { queryNlq, nlqPublicReason } from "./service.js";
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
    const client = new ScoutClient(c, store.pool);
    await refreshScoutSchema(client);
    const out = await queryNlq(
      { question: `who does ${USER} follow` },
      {
        cfg: c,
        pool: store.pool,
        tables: INTENT_REGEX_TABLES,
        client,
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
    const client = new ScoutClient(c, store.pool);
    await refreshScoutSchema(client);
    const out = await queryNlq(
      { question: "MATCH (n:User) RETURN n.id LIMIT 5" },
      {
        cfg: c,
        pool: store.pool,
        tables: INTENT_REGEX_TABLES,
        client,
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
    const client = new ScoutClient(c, store.pool);
    await refreshScoutSchema(client);
    const out = await queryNlq(
      { question: `who does ${USER} follow` },
      {
        cfg: c,
        pool: store.pool,
        tables: INTENT_REGEX_TABLES,
        client,
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
    await refreshScoutSchema(client);
    const tools = createScoutTools({
      cfg: c,
      pool: store.pool,
      storeSwitchOn: async () => false,
      client,
    });
    const direct = await tools.get_identity_summary.execute({ pubky: USER, time_range });
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

describe("nlq schema cache and breaker (F-2)", () => {
  it("fetches schema at most once within TTL across N requests", async () => {
    const stub = await startNlqScoutStub({ rules: identitySummaryRules(USER, USERB) });
    const c = cfg({ scoutUrl: stub.url, scoutSchemaRefreshMs: 3_600_000, scoutMaxQps: 20 });
    const client = new ScoutClient(c, store.pool);
    await refreshScoutSchema(client);
    expect(stub.schemaGets).toBe(1);
    ensureScoutSchemaCache(
      { scoutUrl: c.scoutUrl, scoutTimeoutMs: c.scoutTimeoutMs, scoutSchemaRefreshMs: 3_600_000 },
      client,
    );
    for (let i = 0; i < 5; i++) {
      const out = await queryNlq(
        { question: `who does ${USER} follow` },
        { cfg: c, pool: store.pool, tables: INTENT_REGEX_TABLES, client },
      );
      expect(out.outcome).toBe("ok");
    }
    expect(stub.schemaGets).toBe(1);
    await closeStub(stub.server);
  });

  it("returns circuit_open with zero schema or query calls when the breaker is open", async () => {
    const stub = await startNlqScoutStub({ rules: identitySummaryRules(USER, USERB) });
    const c = cfg({ scoutUrl: stub.url });
    for (let i = 0; i < 5; i++) noteScoutOutcome(false);
    const out = await queryNlq(
      { question: `who does ${USER} follow` },
      { cfg: c, pool: store.pool, tables: INTENT_REGEX_TABLES, client: new ScoutClient(c, store.pool) },
    );
    expect(out.outcome).toBe("circuit_open");
    expect(out.reason).toBe("graph lookup unavailable right now");
    expect(stub.schemaGets).toBe(0);
    expect(stub.calls).toEqual([]);
    await closeStub(stub.server);
  });
});

describe("nlq kill switch (F-3)", () => {
  it("returns switch_off with zero Scout calls when the scout switch row is on", async () => {
    const stub = await startNlqScoutStub({ rules: identitySummaryRules(USER, USERB) });
    const c = cfg({ scoutUrl: stub.url });
    setActiveScoutSchemaForTests(loadGoldenScoutGraph(), "live");
    await store.setSwitch("scout", true);
    try {
      const out = await queryNlq(
        { question: `who does ${USER} follow` },
        {
          cfg: c,
          pool: store.pool,
          tables: INTENT_REGEX_TABLES,
          client: new ScoutClient(c, store.pool),
          storeSwitchOn: () => switchOnSql(store.pool, "scout"),
        },
      );
      expect(out.outcome).toBe("switch_off");
      expect(out.reason).toBe("graph lookup unavailable right now");
      expect(stub.schemaGets).toBe(0);
      expect(stub.calls).toEqual([]);
    } finally {
      await store.setSwitch("scout", false);
      await closeStub(stub.server);
    }
  });
});

describe("nlq caller budgets (F-4)", () => {
  it("applies the per-mention cap when mention_key is nlq-prefixed", async () => {
    const stub = await startNlqScoutStub({ rules: identitySummaryRules(USER, USERB) });
    const c = cfg({ scoutUrl: stub.url, scoutPerMentionCap: 2 });
    const client = new ScoutClient(c, store.pool);
    await refreshScoutSchema(client);
    await store.pool.query("DELETE FROM scout_queries");
    await store.pool.query(
      `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, mention_key)
       VALUES
         ('search_posts', 'a', 'b', 0, false, 1, TRUE, 'nlq:127.0.0.1'),
         ('search_posts', 'c', 'd', 0, false, 1, TRUE, 'nlq:127.0.0.1')`,
    );
    const out = await queryNlq(
      { question: `who does ${USER} follow` },
      {
        cfg: c,
        pool: store.pool,
        tables: INTENT_REGEX_TABLES,
        client,
        mentionKey: "nlq:127.0.0.1",
      },
    );
    expect(out.outcome).toBe("budget_exhausted");
    expect(stub.calls).toEqual([]);
    await store.pool.query("DELETE FROM scout_queries");
    await closeStub(stub.server);
  });

  it("applies JEB_NLQ_DAILY_QUERIES over mention_key LIKE nlq:%", async () => {
    const stub = await startNlqScoutStub({ rules: identitySummaryRules(USER, USERB) });
    const c = cfg({ scoutUrl: stub.url });
    const client = new ScoutClient(c, store.pool);
    await refreshScoutSchema(client);
    await store.pool.query("DELETE FROM scout_queries");
    await store.pool.query(
      `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, mention_key)
       VALUES
         ('search_posts', 'a', 'b', 0, false, 1, TRUE, 'nlq:other'),
         ('search_posts', 'c', 'd', 0, false, 1, FALSE, 'nlq:127.0.0.1'),
         ('search_posts', 'e', 'f', 0, false, 1, TRUE, 'reason-key')`,
    );
    const out = await queryNlq(
      { question: `who does ${USER} follow` },
      {
        cfg: c,
        pool: store.pool,
        tables: INTENT_REGEX_TABLES,
        client,
        mentionKey: "nlq:fresh",
        nlqDailyQueries: 2,
      },
    );
    expect(out.outcome).toBe("budget_exhausted");
    expect(stub.calls).toEqual([]);
    await store.pool.query("DELETE FROM scout_queries");
    await closeStub(stub.server);
  });
});

describe("nlq error mapping (F-5)", () => {
  it("does not reflect internal addresses from thrown errors", async () => {
    expect(nlqPublicReason(new Error("connect ECONNREFUSED 10.0.0.5:5432"))).toBe("internal error");
    expect(nlqPublicReason(new Error("connect ECONNREFUSED 10.0.0.5:5432"))).not.toContain("10.0.0.5");
    const stub = await startNlqScoutStub({ rules: identitySummaryRules(USER, USERB) });
    const c = cfg({ scoutUrl: stub.url });
    const client = new ScoutClient(c, store.pool);
    await refreshScoutSchema(client);
    client.query = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
    };
    const out = await queryNlq(
      { question: `who does ${USER} follow` },
      { cfg: c, pool: store.pool, tables: INTENT_REGEX_TABLES, client },
    );
    expect(out.outcome).toBe("tool_error");
    expect(out.reason).toBe("internal error");
    expect(out.reason).not.toContain("10.0.0.5");
    await closeStub(stub.server);
  });
});

describe("nlq tool arg validation (F-6)", () => {
  it("returns unsupported for out-of-range graph_scope.hops", async () => {
    const stub = await startNlqScoutStub();
    const c = cfg({ scoutUrl: stub.url });
    const client = new ScoutClient(c, store.pool);
    await refreshScoutSchema(client);
    const out = await queryNlq(
      { question: "emerging topics", scope: { graph_scope: { hops: 99 } } },
      { cfg: c, pool: store.pool, tables: INTENT_REGEX_TABLES, client },
    );
    expect(out.outcome).toBe("unsupported");
    expect(out.reason).toBe("tool arguments are invalid");
    expect(stub.calls).toEqual([]);
    await closeStub(stub.server);
  });

  it("returns unsupported for a malformed asker", async () => {
    const stub = await startNlqScoutStub();
    const c = cfg({ scoutUrl: stub.url });
    const client = new ScoutClient(c, store.pool);
    await refreshScoutSchema(client);
    const out = await queryNlq(
      { question: `profile card ${USER}`, asker: "not-a-pubky" },
      { cfg: c, pool: store.pool, tables: INTENT_REGEX_TABLES, client },
    );
    expect(out.outcome).toBe("unsupported");
    expect(out.reason).toBe("tool arguments are invalid");
    expect(stub.calls).toEqual([]);
    await closeStub(stub.server);
  });
});
