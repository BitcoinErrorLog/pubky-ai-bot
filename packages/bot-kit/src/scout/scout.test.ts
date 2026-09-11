import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Store } from "../../../../src/db.js";
import { configFromProcessEnv } from "../../../../src/config.js";
import { toolsForIntent } from "../../../../src/intent.js";
import { ScoutClient, setScoutBackoff, ScoutToolError, sha256 } from "./client.js";
import { createScoutTools } from "./tools.js";
import {
  allTemplateCyphers,
  followPathCountTemplate,
  followPathTemplate,
  GOLDEN_LABELS,
  GOLDEN_RELS,
  profileSnapshotTemplate,
  mentionsOfTemplate,
  trustViewTopicTemplate,
  trustViewUserTemplate,
  whatDidIMissTemplates,
} from "./templates.js";
import { guardRawCypher } from "./guard.js";
import { formatScoutEvidenceBlock, scoutEvidenceBundle, SCOUT_SYSTEM_ADDENDUM } from "../../../../src/scout/evidence.js";
import { startScoutStub } from "../../../../src/scout/stub.js";
import { checkNlqDailyBudget, checkScoutBudgets, isPersistentCallerKey, resetScoutBreakerForTests } from "./budget.js";
import type { Config } from "../../../../src/config.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_vitest";
const USER = "1111111111111111111111111111111111111111111111111111";
const USERB = "2222222222222222222222222222222222222222222222222222";
const POST = "AAAAAAAAAAAAA";
const URI = `pubky://${USER}/pub/pubky.app/posts/${POST}`;

afterEach(() => {
  resetScoutBreakerForTests();
});

function cfg(over: Partial<Config> = {}): Config {
  process.env.DATABASE_URL ??= DB;
  return { ...configFromProcessEnv({ requireSecret: false }), scoutEnabled: true, scoutRawEnabled: true, ...over };
}

describe("templates vs golden schema", () => {
  const schema = JSON.parse(
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.golden.json"), "utf8"),
  ) as {
    nodes: { label: string }[];
    relationships: { type: string }[];
  };
  it("golden labels and rels match live cache", () => {
    expect(schema.nodes.map((n) => n.label).sort()).toEqual([...GOLDEN_LABELS].sort());
    expect([...new Set(schema.relationships.map((r) => r.type))].sort()).toEqual([...GOLDEN_RELS].sort());
  });
  it("every template uses only golden labels/rels and $params", () => {
    for (const q of allTemplateCyphers()) {
      expect(q.cypher).toMatch(/\$[a-z_]+/);
      for (const label of q.cypher.match(/:([A-Z][A-Za-z]+)/g) ?? []) {
        const name = label.slice(1);
        if (["CASE", "WHEN", "THEN", "ELSE", "AS", "NULL", "TRUE", "FALSE"].includes(name)) continue;
        expect([...GOLDEN_LABELS, ...GOLDEN_RELS]).toContain(name);
      }
    }
  });
});

describe("raw cypher guard corpus", () => {
  const opts = { limitMax: 50, profilePropMax: 3, rawEnabled: true };
  const cases: Array<{ cypher: string; params?: Record<string, unknown>; ok: boolean; note: string }> = [
    { cypher: "MATCH (n:User) RETURN n.id LIMIT 5", ok: true, note: "simple match" },
    { cypher: "OPTIONAL MATCH (n:User) RETURN n.id LIMIT 5", ok: true, note: "optional match start" },
    { cypher: "WITH 1 AS x MATCH (n:User) RETURN n.id LIMIT 5", ok: true, note: "with start" },
    { cypher: "UNWIND $ids AS id MATCH (u:User {id: id}) RETURN u.id LIMIT 5", params: { ids: [USER] }, ok: true, note: "unwind" },
    { cypher: "RETURN 1 LIMIT 1", ok: true, note: "return start" },
    { cypher: "MATCH (n) RETURN n", ok: false, note: "no limit" },
    { cypher: "MATCH (n) RETURN n LIMIT 500", ok: true, note: "limit clamped" },
    { cypher: "'; MATCH (n) DETACH DELETE n //", ok: false, note: "injection semi delete comment" },
    { cypher: "MATCH (n) DETACH DELETE n LIMIT 1", ok: false, note: "detach delete" },
    { cypher: "MATCH (n) DELETE n LIMIT 1", ok: false, note: "delete" },
    { cypher: "CREATE (n:User) RETURN n LIMIT 1", ok: false, note: "create" },
    { cypher: "MERGE (n:User {id:'x'}) RETURN n LIMIT 1", ok: false, note: "merge" },
    { cypher: "MATCH (n) SET n.x = 1 RETURN n LIMIT 1", ok: false, note: "set" },
    { cypher: "LOAD CSV FROM 'file:///tmp/x' AS row RETURN row LIMIT 1", ok: false, note: "load csv" },
    { cypher: "CALL apoc.load.json('http://evil') YIELD value RETURN value LIMIT 1", ok: false, note: "apoc" },
    { cypher: "CALL db.labels() YIELD label RETURN label LIMIT 1", ok: false, note: "db.labels" },
    { cypher: "CALL gds.graph.list() YIELD graphName RETURN graphName LIMIT 1", ok: false, note: "gds" },
    {
      cypher: "CALL { MATCH (n:User) RETURN n.id AS id } RETURN id LIMIT 5",
      ok: false,
      note: "call subquery start",
    },
    {
      cypher: "MATCH (n:User) CALL { WITH n RETURN n.id AS id } RETURN id LIMIT 5",
      ok: false,
      note: "call subquery mid",
    },
    { cypher: "MATCH (n) RETURN n LIMIT 1; MATCH (m) RETURN m LIMIT 1", ok: false, note: "multi statement" },
    { cypher: "MATCH (n) RETURN n LIMIT 1 // comment", ok: false, note: "comment" },
    { cypher: "EXPLAIN MATCH (n) RETURN n LIMIT 1", ok: false, note: "explain" },
    { cypher: "PROFILE MATCH (n) RETURN n LIMIT 1", ok: false, note: "profile" },
    { cypher: "SHOW DATABASES", ok: false, note: "show" },
    { cypher: "USE neo4j MATCH (n) RETURN n LIMIT 1", ok: false, note: "use" },
    { cypher: "MATCH (n) USING INDEX n:User(id) RETURN n LIMIT 1", ok: false, note: "using" },
    { cypher: "DROP INDEX foo", ok: false, note: "drop" },
    { cypher: "FOREACH (n IN [] | CREATE (x))", ok: false, note: "foreach" },
    { cypher: "MATCH (n) RETURN n LIMIT 1 /* block */", ok: false, note: "block comment" },
    {
      cypher: "MATCH (u:User {id: $id}) RETURN u.name, u.bio, u.status, u.image, u.links LIMIT 50",
      params: { id: USER },
      ok: true,
      note: "many props but no post history",
    },
    {
      cypher: `MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN u.name, u.bio, u.status, u.image, p.content LIMIT 50`,
      params: { id: USER },
      ok: false,
      note: "profiling denylist",
    },
    {
      cypher: `MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN u.id, p.id LIMIT 10`,
      params: { id: USER },
      ok: true,
      note: "id plus posts ok",
    },
    {
      cypher: "MATCH (p:Post) WHERE p.content CONTAINS 'secret dump of user text' RETURN p.id LIMIT 5",
      ok: false,
      note: "user text literal",
    },
    {
      cypher: "MATCH (p:Post) WHERE p.content CONTAINS $q RETURN p.id LIMIT 5",
      params: { q: "bitcoin" },
      ok: true,
      note: "parametrised text",
    },
    // --- Kimi stage-1 audit Q4 bypass corpus (F-02 / F-16) ---
    {
      cypher:
        "MATCH (u:User) WHERE u.id = $id MATCH (u)-[:AUTHORED]->(p:Post) RETURN u.name, u.bio, u.status, u.links, collect(p.content) AS posts LIMIT 50",
      params: { id: USER },
      ok: false,
      note: "Q4 F-02a: WHERE-bind evades map-pattern boundUser",
    },
    {
      cypher: "MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN collect(p.content) AS posts LIMIT 5",
      params: { id: USER },
      ok: false,
      note: "Q4 F-02b: post-content collect with zero user props",
    },
    {
      cypher: "MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN collect(p) AS posts LIMIT 1",
      params: { id: USER },
      ok: false,
      note: "Q4 F-02c: node collect (old rule 2 was dead code)",
    },
    {
      cypher:
        "MATCH (u:User) WHERE u.id IN [$id] MATCH (u)-[:AUTHORED]->(p:Post) RETURN collect(p.content) AS posts LIMIT 5",
      params: { id: USER },
      ok: false,
      note: "Q4 F-02: IN-list user binding",
    },
    {
      cypher:
        "MATCH (u:User) WHERE u.id = $id MATCH (u)-[:AUTHORED]->(p:Post) RETURN u.name, u.bio, collect(p.content) AS posts LIMIT 50",
      params: { id: USER },
      ok: false,
      note: "Q4 F-02: few props still profiling when content collected",
    },
    {
      cypher: `MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN u.id, size(collect(p)) AS n LIMIT 5`,
      params: { id: USER },
      ok: true,
      note: "aggregate count without content is allowed",
    },
    {
      cypher: "MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN u.id, p.id LIMIT 10",
      params: { id: USER },
      ok: true,
      note: "ids only still allowed after denylist rewrite",
    },
    // --- Kimi 2026-09-04b audit (F-B): MUTED counterparty enumeration ---
    {
      cypher: "MATCH (u:User {id: $id})<-[m:MUTED]-(w:User) RETURN w.id LIMIT 10",
      params: { id: USER },
      ok: false,
      note: "F-B: enumerate an id-bound user's muters",
    },
    {
      cypher: "MATCH (u:User {id: $id})-[m:MUTED]->(w:User) RETURN w.id LIMIT 10",
      params: { id: USER },
      ok: false,
      note: "F-B: reverse direction — enumerate who the user muted",
    },
    {
      cypher: "MATCH (u:User {id: $id})<-[m:MUTED]-(w:User) RETURN m.indexed_at LIMIT 10",
      params: { id: USER },
      ok: false,
      note: "F-B: edge rows outside an aggregate are per-muter rows",
    },
    {
      cypher: "MATCH (u:User {id: $id})<-[m:MUTED]-(w:User) RETURN count(DISTINCT m) AS muted_count LIMIT 10",
      params: { id: USER },
      ok: true,
      note: "F-B: aggregate count only is allowed",
    },
    {
      cypher: "MATCH (a:User)-[m:MUTED]->(b:User) RETURN a.id, b.id LIMIT 10",
      ok: true,
      note: "F-B: no id-bound user — global edge scan unchanged",
    },
    {
      cypher: "MATCH (p:Post)-[:REPLIED*]->(x:Post) RETURN x.id LIMIT 100",
      ok: false,
      note: "Q4 F-16: unbounded variable-length path",
    },
    {
      cypher: "MATCH (p:Post)-[:REPLIED*2..]->(x:Post) RETURN x.id LIMIT 10",
      ok: false,
      note: "F-16: open upper bound varlen",
    },
    {
      cypher: "MATCH (p:Post)-[:REPLIED*1..3]->(x:Post) RETURN x.id LIMIT 10",
      ok: true,
      note: "bounded varlen allowed",
    },
    {
      cypher: "MATCH (p:Post)-[:REPLIED*..3]->(x:Post) RETURN x.id LIMIT 10",
      ok: true,
      note: "open lower bound varlen allowed",
    },
    // F-20 residual, accepted for staging: tiny-concat and ALL-CAPS literal
    // evasions of the params rule (raw mode is default-off; documented).
    {
      cypher: "MATCH (p:Post) WHERE p.content CONTAINS ('b'+'i'+'t'+'c'+'o'+'i'+'n') RETURN p.id LIMIT 5",
      ok: true,
      note: "Q4 F-20 ACCEPTED: <=2-char concat evades params rule",
    },
    {
      cypher: "MATCH (p:Post) WHERE p.content CONTAINS 'BITCOIN' RETURN p.id LIMIT 5",
      ok: true,
      note: "Q4 F-20 ACCEPTED: ALL-CAPS <=20 evades params rule",
    },
  ];
  it("has at least 25 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });
  it("accepts and rejects as specified", () => {
    for (const c of cases) {
      const r = guardRawCypher(c.cypher, c.params ?? {}, opts);
      expect(r.ok, c.note).toBe(c.ok);
    }
  });
  it("clamps LIMIT 500 to max", () => {
    const r = guardRawCypher("MATCH (n) RETURN n LIMIT 500", {}, opts);
    expect(r.ok).toBe(true);
    expect(r.limit).toBe(50);
    expect(r.cypher).toMatch(/LIMIT 50$/);
  });
  it("disabled raw", () => {
    expect(guardRawCypher("MATCH (n) RETURN n LIMIT 1", {}, { ...opts, rawEnabled: false }).ok).toBe(false);
  });
  it("rejects CALL including CALL { subquery }", () => {
    const r = guardRawCypher("CALL { MATCH (n:User) RETURN n.id AS id } RETURN id LIMIT 5", {}, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Scout does not permit CALL");
  });
  it("profile_snapshot's aggregate-only MUTED count still passes the guard (F-B)", () => {
    const q = profileSnapshotTemplate(USER);
    const r = guardRawCypher(q.cypher, q.params, opts);
    expect(r.ok, r.reason).toBe(true);
  });

  it("allows mentions_of content for posts authored by another user", () => {
    const q = mentionsOfTemplate(USER, { since: 1, until: 2 }, 10);
    const r = guardRawCypher(q.cypher.replace(/\bLIMIT\s+\$limit\s*$/i, `LIMIT ${q.limit}`), q.params, opts);
    expect(r.ok, r.reason).toBe(true);
  });

  it("rejects content from posts authored by the id-bound user", () => {
    const r = guardRawCypher(
      "MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN p.content LIMIT 5",
      { id: USER },
      opts,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/post content of an id-bound user/);
  });

  it.each([
    "MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN p.content LIMIT 5",
    "MATCH (p:Post)<-[:AUTHORED]-(u:User {id: $id}) RETURN p.content LIMIT 5",
    "MATCH (u:User {id: $id})-[:AUTHORED]-(p:Post) RETURN p.content LIMIT 5",
  ])("rejects authored content in every edge direction: %s", (cypher) => {
    const r = guardRawCypher(cypher, { id: USER }, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/post content/);
  });

  it.each([
    "MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN p LIMIT 5",
    "MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN properties(p) LIMIT 5",
    "MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN p{.*} LIMIT 5",
    "MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN p AS post LIMIT 5",
    "MATCH (u:User {id: $id})-[:AUTHORED]->(p:Post) RETURN [x IN [p] | x] LIMIT 5",
  ])("rejects whole authored post output: %s", (cypher) => {
    const r = guardRawCypher(cypher, { id: USER }, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/whole post node/);
  });

  it.each([
    "MATCH (u {id: $id})-[:AUTHORED]->(p:Post) RETURN p.content LIMIT 5",
    "MATCH (u)-[:AUTHORED]->(p:Post) WHERE u.id = $id RETURN p.content LIMIT 5",
    "MATCH (u)-[:AUTHORED]->(p:Post) WHERE u.id IN $ids RETURN p.content LIMIT 5",
  ])("rejects authored content without a User label: %s", (cypher) => {
    const r = guardRawCypher(cypher, { id: USER, ids: [USER] }, opts);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/post content/);
  });

  it("rejects UNION queries", () => {
    const r = guardRawCypher(
      "MATCH (n:User) RETURN n.id UNION ALL MATCH (p:Post) RETURN p.id LIMIT 5",
      {},
      opts,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/UNION/);
  });

  it("rejects an author dump hidden behind a WITH alias", () => {
    const r = guardRawCypher(
      "MATCH (u:User {id: $id}) WITH u AS author MATCH (author)-[:AUTHORED]->(p:Post) RETURN p.content LIMIT 5",
      { id: USER },
      opts,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/post content of an id-bound user/);
  });

  it.each([
    "MATCH (u {id:$id})-[:AUTHORED]->(p:Post) WITH p AS q RETURN q.content LIMIT 5",
    "MATCH (u {id:$id})-[:AUTHORED]->(p:Post) WITH p AS q RETURN q{.id, .content} LIMIT 5",
    "MATCH (u {id:$id})-[:AUTHORED]->(p:Post) WITH p AS q RETURN collect(q) LIMIT 5",
    "MATCH (u {id:$id})-[:AUTHORED]->(p:Post) WITH p AS q RETURN q LIMIT 5",
    "MATCH (u {id:$id})-[:AUTHORED]->(p:Post) WITH p AS q WITH q AS r RETURN r.content LIMIT 5",
    "MATCH (u {id:$id})-[:AUTHORED]->(p:Post) WITH p.content AS c RETURN c LIMIT 5",
    "MATCH (u {id:$id})-[:AUTHORED]->(p:Post) WITH collect(p) AS ps RETURN ps LIMIT 5",
  ])("rejects post profiling through every alias form: %s", (cypher) => {
    const r = guardRawCypher(cypher, { id: USER }, opts);
    expect(r.ok).toBe(false);
  });

  it.each([
    "MATCH (u {id:$id})-[:AUTHORED]->(p:Post) RETURN p.id, p.indexed_at LIMIT 5",
    "MATCH (a:User)-[:AUTHORED]->(p:Post) WHERE a.id <> $id RETURN p.content LIMIT 5",
    "MATCH (u {id:$id})-[:AUTHORED]->(p:Post) RETURN size(collect(p)) LIMIT 5",
    "MATCH (u {id:$id})-[:AUTHORED]->(p:Post) RETURN count(p) LIMIT 5",
    "MATCH (u {id:$id})-[:AUTHORED]->(p:Post) WITH p AS q RETURN q.id, q.indexed_at LIMIT 5",
  ])("keeps safe post projections accepted: %s", (cypher) => {
    const r = guardRawCypher(cypher, { id: USER }, opts);
    expect(r.ok, r.reason).toBe(true);
  });
});

describe("client errors and tools against stub", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
  });
  afterAll(async () => {
    await store.close();
  });

  it("maps 400/429/504", async () => {
    const stub = await startScoutStub([
      {
        match: (c) => c.includes("RATE"),
        status: 429,
        body: { error: "RATE_LIMITED", message: "slow" },
      },
      {
        match: (c) => c.includes("TIME"),
        status: 504,
        body: { error: "QUERY_TIMEOUT", message: "t" },
      },
      {
        match: () => true,
        status: 400,
        body: { error: "QUERY_REJECTED", message: "no", hint: "rewrite" },
      },
    ]);
    const client = new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool);
    setScoutBackoff(0);
    await expect(client.query({ cypher: "MATCH RATE RETURN 1 LIMIT 1", tool: "t" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    setScoutBackoff(0);
    await expect(client.query({ cypher: "MATCH TIME RETURN 1 LIMIT 1", tool: "t" })).rejects.toMatchObject({
      code: "QUERY_TIMEOUT",
    });
    setScoutBackoff(0);
    await expect(client.query({ cypher: "MATCH X RETURN 1 LIMIT 1", tool: "t" })).rejects.toMatchObject({
      code: "QUERY_REJECTED",
    });
    await new Promise<void>((r) => stub.server.close(() => r()));
  });

  it("replays fixture search_posts and formats evidence", async () => {
    const fixture = JSON.parse(
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../tests/scout/fixtures/search_posts.json"), "utf8"),
    ) as { results: unknown[]; count: number; truncated: boolean };
    const stub = await startScoutStub([{ status: 200, body: fixture }]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url, scoutEnabled: true }),
      pool: store.pool,
      mentionKey: URI,
      author: USER,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    const out = (await tools.search_posts.execute({ query: "bitcoin", limit: 5 })) as {
      posts: { uri: string; claims: { label: string; claimant_ids: string[] }[] }[];
      provenance: string;
    };
    expect(out.provenance).toBe("scout");
    expect(out.posts[0]?.uri).toBe(URI);
    expect(out.posts[0]?.claims[0]?.label).toBe("bitcoin");
    expect(out.posts[0]?.claims[0]?.claimant_ids).toContain(USERB);
    const block = formatScoutEvidenceBlock([out]);
    expect(block).toMatch(/claims/);
    expect(block).not.toMatch(/is a builder/i);
    expect(scoutEvidenceBundle([out]).kind).toBe("scout");
    expect(SCOUT_SYSTEM_ADDENDUM).toMatch(/Jeb's/);
    await new Promise<void>((r) => stub.server.close(() => r()));
  });

  it("gates on scout switch and budgets", async () => {
    const stub = await startScoutStub([{ status: 200, body: { results: [], count: 0, truncated: false } }]);
    const toolsOff = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url, scoutEnabled: true }),
      pool: store.pool,
      storeSwitchOn: async () => true,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    const blocked = await toolsOff.search_posts.execute({ query: "x" });
    expect(blocked).toMatchObject({ error: "SWITCH" });

    const toolsDisabled = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url, scoutEnabled: false }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    expect(await toolsDisabled.search_posts.execute({ query: "x" })).toMatchObject({ error: "DISABLED" });

    await store.pool.query("DELETE FROM scout_queries");
    const gate = await checkScoutBudgets(store.pool, cfg({ scoutPerMentionCap: 1, scoutDailyCeiling: 1 }), {
      mentionKey: "k",
      raw: false,
    });
    expect(gate.blocked).toBe(false);
    await store.pool.query(
      `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, mention_key)
       VALUES ('search_posts','a','b',0,false,1,true,'k')`,
    );
    const gate2 = await checkScoutBudgets(store.pool, cfg({ scoutPerMentionCap: 1, scoutDailyCeiling: 100 }), {
      mentionKey: "k",
      raw: false,
    });
    expect(gate2.blocked).toBe(true);
    await store.pool.query(
      `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, mention_key)
       VALUES ('search_posts','c','d',0,false,1,false,'k-fail')`,
    );
    const gateFail = await checkScoutBudgets(store.pool, cfg({ scoutPerMentionCap: 1, scoutDailyCeiling: 100 }), {
      mentionKey: "k-fail",
      raw: false,
    });
    expect(gateFail.blocked).toBe(false);
    await new Promise<void>((r) => stub.server.close(() => r()));
  });

  it("pubchi persistent key with 13 prior ok rows is not exhausted by the per-mention cap", async () => {
    expect(isPersistentCallerKey("pubchi:owner")).toBe(true);
    expect(isPersistentCallerKey("nlq:caller")).toBe(true);
    expect(isPersistentCallerKey("pubky://mention/key")).toBe(false);
    const key = `pubchi:k1b-n2-${Date.now()}`;
    await store.pool.query("DELETE FROM scout_queries WHERE mention_key = $1", [key]);
    await store.pool.query(
      `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, mention_key)
       SELECT 'search_posts', 'h' || g, 'p', 0, false, 1, true, $1 FROM generate_series(1, 13) g`,
      [key],
    );
    const gate = await checkScoutBudgets(store.pool, cfg({ scoutPerMentionCap: 12, scoutDailyCeiling: 400 }), {
      mentionKey: key,
      raw: false,
    });
    expect(gate.blocked).toBe(false);
    await store.pool.query("DELETE FROM scout_queries WHERE mention_key = $1", [key]);
  });

  it("plain mention key with 12 prior ok rows still hits the per-mention cap", async () => {
    const key = `k1b-mention-${Date.now()}`;
    await store.pool.query("DELETE FROM scout_queries WHERE mention_key = $1", [key]);
    await store.pool.query(
      `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, mention_key)
       SELECT 'search_posts', 'h' || g, 'p', 0, false, 1, true, $1 FROM generate_series(1, 12) g`,
      [key],
    );
    const gate = await checkScoutBudgets(store.pool, cfg({ scoutPerMentionCap: 12, scoutDailyCeiling: 400 }), {
      mentionKey: key,
      raw: false,
    });
    expect(gate).toEqual({ blocked: true, reason: "per_mention_scout_cap" });
    await store.pool.query("DELETE FROM scout_queries WHERE mention_key = $1", [key]);
  });

  it("pubchi daily NLQ ceiling still trips at its limit", async () => {
    const key = `pubchi:k1b-daily-${Date.now()}`;
    await store.pool.query("DELETE FROM scout_queries WHERE mention_key = $1", [key]);
    await store.pool.query(
      `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, mention_key)
       SELECT 'search_posts', 'h' || g, 'p', 0, false, 1, true, $1 FROM generate_series(1, 2) g`,
      [key],
    );
    const gate = await checkNlqDailyBudget(store.pool, 2, key);
    expect(gate).toEqual({ blocked: true, reason: "nlq_daily_ceiling" });
    await store.pool.query("DELETE FROM scout_queries WHERE mention_key = $1", [key]);
  });

  it("NLQ daily ceiling uses the UTC calendar day, not session TimeZone", async () => {
    const client = await store.pool.connect();
    const key = `nlq:k1b-utc-${Date.now()}`;
    try {
      await client.query("SET TIME ZONE 'Asia/Tokyo'");
      const bounds = await client.query<{ tokyo_start: Date; utc_start: Date; tokyo: string; utc: string }>(
        `SELECT date_trunc('day', now()) AS tokyo_start,
                ((now() AT TIME ZONE 'UTC')::date)::timestamp AT TIME ZONE 'UTC' AS utc_start,
                CURRENT_DATE::text AS tokyo,
                (now() AT TIME ZONE 'UTC')::date::text AS utc`,
      );
      expect(bounds.rows[0]?.tokyo).toBeTruthy();
      expect(bounds.rows[0]?.utc).toBeTruthy();
      expect(bounds.rows[0]?.tokyo_start?.getTime()).not.toBe(bounds.rows[0]?.utc_start?.getTime());

      await client.query("DELETE FROM scout_queries WHERE mention_key = $1", [key]);
      await client.query(
        `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, mention_key, created_at)
         VALUES ('search_posts','utc-y','p',0,false,1,true,$1,
                 ((now() AT TIME ZONE 'UTC')::date - 1)::timestamp AT TIME ZONE 'UTC' + interval '12 hours')`,
        [key],
      );
      const yesterday = await checkNlqDailyBudget(client, 1, key);
      expect(yesterday.blocked).toBe(false);

      await client.query(
        `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, mention_key, created_at)
         VALUES ('search_posts','utc-t','p',0,false,1,true,$1,
                 ((now() AT TIME ZONE 'UTC')::date)::timestamp AT TIME ZONE 'UTC' + interval '1 hour')`,
        [key],
      );
      const today = await checkNlqDailyBudget(client, 1, key);
      expect(today).toEqual({ blocked: true, reason: "nlq_daily_ceiling" });
    } finally {
      await client.query("DELETE FROM scout_queries WHERE mention_key = $1", [key]);
      await client.query("SET TIME ZONE DEFAULT");
      client.release();
    }
  });

  it("query_graph respects guard then records", async () => {
    const stub = await startScoutStub([
      { status: 200, body: { results: [{ id: USER }], count: 1, truncated: false } },
    ]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url, scoutRawEnabled: true }),
      pool: store.pool,
      mentionKey: URI,
      author: USER,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    const bad = await tools.query_graph.execute({ cypher: "MATCH (n) DETACH DELETE n LIMIT 1" });
    expect(bad).toMatchObject({ error: "QUERY_REJECTED" });
    const good = await tools.query_graph.execute({
      cypher: "MATCH (u:User {id: $id}) RETURN u.id LIMIT 1",
      params: { id: USER },
    });
    expect(good).toMatchObject({ count: 1, provenance: "scout" });
    await new Promise<void>((r) => stub.server.close(() => r()));
  });

  it("identity summary shape from stub", async () => {
    const stub = await startScoutStub([
      {
        match: (c) => c.includes("count(p)"),
        status: 200,
        body: { results: [{ id: USER, name: "Ada", posts: 3 }], count: 1, truncated: false },
      },
      {
        match: (c) => c.includes("followers"),
        status: 200,
        body: { results: [{ followers: 9 }], count: 1, truncated: false },
      },
      {
        match: (c) => c.includes("following"),
        status: 200,
        body: { results: [{ following: 4 }], count: 1, truncated: false },
      },
      {
        match: (c) => c.includes("self_claim"),
        status: 200,
        body: {
          results: [{ label: "builder", count: 5, claimant_ids: [USERB], self_claim: false }],
          count: 1,
          truncated: false,
        },
      },
    ]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    const out = (await tools.get_identity_summary.execute({ pubky: USER })) as {
      posts: number;
      followers: number;
      tag_claims: { label: string; count: number }[];
    };
    expect(out.posts).toBe(3);
    expect(out.followers).toBe(9);
    expect(out.tag_claims[0]?.label).toBe("builder");
    expect(JSON.stringify(out)).not.toMatch(/is a builder/);
    await new Promise<void>((r) => stub.server.close(() => r()));
  });
});

describe("intent allows scout tools", () => {
  it("research_pubky find compare evidence_map answer include search_posts", () => {
    for (const i of ["research_pubky", "find", "compare", "evidence_map", "answer"] as const) {
      expect(toolsForIntent(i)).toContain("search_posts");
      expect(toolsForIntent(i)).toContain("get_identity_summary");
      expect(toolsForIntent(i)).toContain("query_graph");
      expect(toolsForIntent(i)).toContain("rank_users");
      expect(toolsForIntent(i)).toContain("recommend_follows");
      expect(toolsForIntent(i)).toContain("stale_follows");
      expect(toolsForIntent(i)).toContain("follow_path");
      expect(toolsForIntent(i)).toContain("trust_view");
      expect(toolsForIntent(i)).toContain("top_posts");
      expect(toolsForIntent(i)).toContain("mentions_of");
      expect(toolsForIntent(i)).toContain("profile_card");
    }
    expect(toolsForIntent("summarize")).toContain("search_posts");
  });
});

describe("live scout identity (SCOUT_LIVE=1)", () => {
  const live = process.env.SCOUT_LIVE === "1";
  it.skipIf(!live)("search John Carvalho then identity summary shape", async () => {
    const store = new Store(DB);
    await store.migrate();
    const c = cfg({ scoutUrl: "https://nexus-scout.pubky.app" });
    const tools = createScoutTools({
      cfg: c,
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(c, store.pool),
    });
    const found = (await tools.search_users_by_name.execute({ name: "John Carvalho", limit: 5 })) as {
      users: { pubky: string; name: string }[];
    };
    const hit = found.users.find((u) => /carvalho/i.test(u.name));
    expect(hit?.pubky).toMatch(/^[a-z0-9]{52}$/);
    const summary = (await tools.get_identity_summary.execute({ pubky: hit!.pubky })) as {
      pubky: string;
      posts: number;
      followers: number;
      following: number;
      tag_claims: unknown[];
      truncated: boolean;
    };
    expect(summary.pubky).toBe(hit!.pubky);
    expect(typeof summary.posts).toBe("number");
    expect(typeof summary.followers).toBe("number");
    expect(Array.isArray(summary.tag_claims)).toBe(true);
    await store.close();
  });
});

describe("rank_users tool", () => {
  it("returns ranked users from stub", async () => {
    const store = new Store(DB);
    await store.migrate();
    const stub = await startScoutStub([
      {
        status: 200,
        body: {
          results: [
            {
              pubky: USER,
              name: "Ada",
              tags_applied: 20,
              tags_received: 7,
              posts: 1,
              followers: 3,
              tags_applied_per_post: 20,
            },
          ],
          count: 1,
          truncated: false,
        },
      },
    ]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    const out = (await tools.rank_users.execute({ metric: "tags_applied_per_post", limit: 5 })) as {
      users: { pubky: string; value: number; tags_applied: number; tags_received: number; posts: number }[];
      truncated: boolean;
    };
    expect(out.users[0]?.pubky).toBe(USER);
    expect(out.users[0]?.value).toBe(20);
    expect(out.users[0]?.tags_applied).toBe(20);
    expect(out.users[0]?.tags_received).toBe(7);
    expect(out.truncated).toBe(false);
    await new Promise<void>((r) => stub.server.close(() => r()));
    await store.close();
  });
});

describe("recommend_follows and stale_follows tools", () => {
  it("recommend_follows returns evidence rows without advice text", async () => {
    const store = new Store(DB);
    await store.migrate();
    const stub = await startScoutStub([
      {
        match: (cypher) => cypher.includes("mutual_followers_count"),
        status: 200,
        body: {
          results: [{ pubky: USERB, name: "Bea", mutual_followers_count: 3, post_count_30d: 4 }],
          count: 1,
          truncated: false,
        },
      },
      {
        match: (cypher) => cypher.includes("received") && cypher.includes("applied"),
        status: 200,
        body: {
          results: [
            { pubky: USER, received: ["builder"], applied: ["pubky"] },
            { pubky: USERB, received: ["builder"], applied: [] },
          ],
          count: 2,
          truncated: false,
        },
      },
    ]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    const out = (await tools.recommend_follows.execute({ pubky: USER, limit: 5 })) as {
      users: { pubky: string; mutual_followers_count: number; shared_tags: string[]; post_count_30d: number }[];
    };
    expect(out.users[0]?.pubky).toBe(USERB);
    expect(out.users[0]?.mutual_followers_count).toBe(3);
    expect(out.users[0]?.shared_tags).toEqual(["builder"]);
    expect(out.users[0]?.post_count_30d).toBe(4);
    expect(JSON.stringify(out)).not.toMatch(/you should/i);
    await new Promise<void>((r) => stub.server.close(() => r()));
    await store.close();
  });

  it("stale_follows returns last_post_at and follows_back", async () => {
    const store = new Store(DB);
    await store.migrate();
    const stub = await startScoutStub([
      {
        status: 200,
        body: {
          results: [{ pubky: USERB, name: "Bea", last_post_at: 1, follows_back: false }],
          count: 1,
          truncated: false,
        },
      },
    ]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    const out = (await tools.stale_follows.execute({ pubky: USER, inactive_days: 60, limit: 5 })) as {
      users: { pubky: string; last_post_at?: number; follows_back: boolean }[];
    };
    expect(out.users[0]?.pubky).toBe(USERB);
    expect(out.users[0]?.last_post_at).toBe(1);
    expect(out.users[0]?.follows_back).toBe(false);
    expect(JSON.stringify(out)).not.toMatch(/you should/i);
    await new Promise<void>((r) => stub.server.close(() => r()));
    await store.close();
  });
});

describe("live scout rank_users (SCOUT_LIVE=1)", () => {
  const live = process.env.SCOUT_LIVE === "1";
  it.skipIf(!live)("rank_users tags_applied_per_post returns pubky ids", async () => {
    const store = new Store(DB);
    await store.migrate();
    const c = cfg({ scoutUrl: "https://nexus-scout.pubky.app" });
    const tools = createScoutTools({
      cfg: c,
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(c, store.pool),
    });
    const out = (await tools.rank_users.execute({ metric: "tags_applied_per_post", limit: 3 })) as {
      users: { pubky: string; value: number }[];
    };
    expect(out.users.length).toBeGreaterThan(0);
    for (const u of out.users.slice(0, 3)) {
      expect(u.pubky).toMatch(/^[a-z0-9]{52}$/);
    }
    // eslint-disable-next-line no-console
    console.log("rank_users top-3", out.users.slice(0, 3).map((u) => u.pubky).join(" "));
    await store.close();
  });
});

describe("live scout follow tools (SCOUT_LIVE=1)", () => {
  const live = process.env.SCOUT_LIVE === "1";
  const subject = "gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo";
  it.skipIf(!live)("recommend_follows and stale_follows return pubky ids", async () => {
    const store = new Store(DB);
    await store.migrate();
    const c = cfg({ scoutUrl: "https://nexus-scout.pubky.app" });
    const tools = createScoutTools({
      cfg: c,
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(c, store.pool),
    });
    const rec = (await tools.recommend_follows.execute({ pubky: subject, limit: 3 })) as {
      users: { pubky: string }[];
    };
    const stale = (await tools.stale_follows.execute({ pubky: subject, inactive_days: 60, limit: 3 })) as {
      users: { pubky: string }[];
    };
    expect(rec.users.length).toBeGreaterThan(0);
    expect(stale.users.length).toBeGreaterThan(0);
    for (const u of [...rec.users.slice(0, 3), ...stale.users.slice(0, 3)]) {
      expect(u.pubky).toMatch(/^[a-z0-9]{52}$/);
    }
    // eslint-disable-next-line no-console
    console.log("recommend_follows top-3", rec.users.slice(0, 3).map((u) => u.pubky).join(" "));
    // eslint-disable-next-line no-console
    console.log("stale_follows top-3", stale.users.slice(0, 3).map((u) => u.pubky).join(" "));
    await store.close();
  });
});

describe("what_did_i_miss bounded branches", () => {
  it("pins the live rejection of the superseded CALL query", () => {
    const fixture = JSON.parse(
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../tests/scout/fixtures/missed_scope_call_rejected.json"), "utf8"),
    ) as { query_class: string; query_sha256: string; status: number; error_code: string; response_shape: { kind: string } };
    const supersededCallQuery = `CALL {
  MATCH (u:User {id: $owner})-[:FOLLOWS]->(a:User)-[:AUTHORED]->(p:Post)
  WHERE p.indexed_at >= $since AND p.indexed_at < $until
  RETURN 'post' AS event_kind, a.id AS author_id, a.name AS author_name, p.id AS post_id, p.content AS content, p.indexed_at AS indexed_at, false AS deleted
  UNION ALL
  MATCH (u:User {id: $owner})-[:AUTHORED]->(root:Post)<-[:REPLIED]-(p:Post)<-[:AUTHORED]-(a:User)
  WHERE p.indexed_at >= $since AND p.indexed_at < $until
  RETURN 'reply' AS event_kind, a.id AS author_id, a.name AS author_name, p.id AS post_id, p.content AS content, p.indexed_at AS indexed_at, false AS deleted
  UNION ALL
  MATCH (tagger:User)-[t:TAGGED]->(target)
  WHERE (target:User AND target.id = $owner OR target:Post AND EXISTS { MATCH (:User {id: $owner})-[:AUTHORED]->(target) })
    AND t.indexed_at >= $since AND t.indexed_at < $until
  RETURN 'tag' AS event_kind, tagger.id AS author_id, tagger.name AS author_name, target.id AS post_id, t.label AS content, t.indexed_at AS indexed_at, false AS deleted
}
RETURN event_kind, author_id, author_name, post_id, content, indexed_at, deleted
ORDER BY indexed_at ASC, author_id ASC, post_id ASC
LIMIT $limit`;
    const guarded = guardRawCypher(supersededCallQuery, { owner: "test-owner", since: 1, until: 2, limit: 50 }, {
      limitMax: 50,
      profilePropMax: 3,
      rawEnabled: true,
    });
    expect(fixture).toMatchObject({
      query_class: "CALL_SUBQUERY",
      status: 400,
      error_code: "QUERY_REJECTED",
      response_shape: { kind: "error" },
    });
    expect(fixture.query_sha256).toBe(sha256(supersededCallQuery));
    expect(guarded).toEqual({ ok: false, reason: "multiple statements / UNION rejected" });
  });

  it("guards and executes every branch with deterministic merge semantics", async () => {
    const store = new Store(DB);
    await store.migrate();
    const queries = whatDidIMissTemplates(USER, 10, 20, 2);
    for (const query of queries) {
      const checked = guardRawCypher(query.cypher.replace(/LIMIT \$limit$/i, `LIMIT ${query.limit}`), query.params, {
        limitMax: 50,
        profilePropMax: 3,
        rawEnabled: true,
      });
      expect(checked.ok, `${query.name}: ${checked.reason}`).toBe(true);
      expect(query.cypher).not.toMatch(/\bCALL\b|\bUNION\b/i);
    }
    const stub = await startScoutStub([
      {
        match: (cypher) => cypher.includes("FOLLOWS"),
        status: 200,
        body: {
          results: [{ event_kind: "post", author_id: USERB, author_name: "Bea", post_id: "p1", content: "one", indexed_at: 2, deleted: false }],
          count: 1,
          truncated: false,
        },
      },
      {
        match: (cypher) => cypher.includes("REPLIED"),
        status: 200,
        body: {
          results: [{ event_kind: "reply", author_id: USERB, author_name: "Bea", post_id: "p2", content: "two", indexed_at: 1, deleted: false }],
          count: 1,
          truncated: false,
        },
      },
      {
        match: (cypher) => cypher.includes("TAGGED") && cypher.includes("p:User"),
        status: 200,
        body: {
          results: [{ event_kind: "tag", author_id: USERB, author_name: "Bea", post_id: USER, content: "three", indexed_at: 3, deleted: false }],
          count: 1,
          truncated: false,
        },
      },
      {
        match: (cypher) => cypher.includes("TAGGED") && cypher.includes("p:Post"),
        status: 200,
        body: {
          results: [{ event_kind: "tag", author_id: USERB, author_name: "Bea", post_id: "p1", content: "one", indexed_at: 2, deleted: false }],
          count: 1,
          truncated: false,
        },
      },
    ]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url, scoutMaxQps: 50 }),
      pool: store.pool,
      mentionKey: "what-did-i-miss-test",
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url, scoutMaxQps: 50 }), store.pool),
    });
    const out = await tools.get_what_did_i_miss.execute({ owner: USER, since: 10, until: 20, limit: 2 }) as {
      posts: { post_id: string }[];
      replies: { post_id: string }[];
      tags: { post_id: string }[];
      complete: boolean;
      truncated: boolean;
    };
    expect(stub.calls).toHaveLength(4);
    for (const raw of stub.calls) {
      const body = JSON.parse(raw) as { params: Record<string, unknown>; cypher: string; limit: number };
      expect(body.params).toMatchObject({ owner: USER, since: 10, until: 20, limit: 3 });
      expect(body.limit).toBe(3);
      expect(body.cypher).not.toMatch(/\bCALL\b|\bUNION\b/i);
    }
    expect(out.replies[0]?.post_id).toBe("p2");
    expect(out.posts).toHaveLength(1);
    expect(out.tags).toHaveLength(1);
    expect(out.complete).toBe(false);
    expect(out.truncated).toBe(true);
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    await store.close();
  });

  it("marks exact branch saturation conservatively at limits one and fifty", async () => {
    const cases = [
      { limit: 1, count: 1, envelopeTruncated: false, truncated: false },
      { limit: 1, count: 2, envelopeTruncated: false, truncated: true },
      { limit: 50, count: 49, envelopeTruncated: false, truncated: false },
      { limit: 50, count: 50, envelopeTruncated: false, truncated: true },
      { limit: 50, count: 0, envelopeTruncated: true, truncated: true },
    ];
    for (const testCase of cases) {
      const store = new Store(DB);
      await store.migrate();
      const stub = await startScoutStub([
        {
          match: (cypher) => cypher.includes("FOLLOWS"),
          status: 200,
          body: {
            results: Array.from({ length: testCase.count }, (_, index) => ({
              event_kind: "post",
              author_id: USERB,
              author_name: "Bea",
              post_id: `p${index}`,
              content: `post ${index}`,
              indexed_at: index + 1,
              deleted: false,
            })),
            count: testCase.count,
            truncated: testCase.envelopeTruncated,
          },
        },
        { status: 200, body: { results: [], count: 0, truncated: false } },
      ]);
      const tools = createScoutTools({
        cfg: cfg({ scoutUrl: stub.url, scoutMaxQps: 50 }),
        pool: store.pool,
        storeSwitchOn: async () => false,
        client: new ScoutClient(cfg({ scoutUrl: stub.url, scoutMaxQps: 50 }), store.pool),
      });
      const out = await tools.get_what_did_i_miss.execute({
        owner: USER,
        since: 10,
        until: 20,
        limit: testCase.limit,
      }) as { truncated: boolean };
      expect(out.truncated, JSON.stringify(testCase)).toBe(testCase.truncated);
      await new Promise<void>((resolve) => stub.server.close(() => resolve()));
      await store.close();
    }
  });

  it("marks a successful fan-out partial when one branch fails", async () => {
    const store = new Store(DB);
    await store.migrate();
    const stub = await startScoutStub([
      {
        match: (cypher) => cypher.includes("REPLIED"),
        status: 503,
        body: { error: "UPSTREAM_UNAVAILABLE" },
      },
      { status: 200, body: { results: [], count: 0, truncated: false } },
    ]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url, scoutMaxQps: 50 }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url, scoutMaxQps: 50 }), store.pool),
    });
    const out = await tools.get_what_did_i_miss.execute({ owner: USER, since: 10, until: 20, limit: 2 }) as {
      complete: boolean;
      failed_branches: string[];
    };
    expect(out.complete).toBe(false);
    expect(out.failed_branches).toContain("what_did_i_miss_replies");
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    await store.close();
  });

  it("rejects a branch envelope with the wrong event shape", async () => {
    const store = new Store(DB);
    await store.migrate();
    const stub = await startScoutStub([
      {
        status: 200,
        body: { results: [{ event_kind: "post" }], count: 1, truncated: false },
      },
    ]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url, scoutMaxQps: 50 }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url, scoutMaxQps: 50 }), store.pool),
    });
    expect(await tools.get_what_did_i_miss.execute({ owner: USER, since: 10, until: 20, limit: 2 })).toMatchObject({
      error: "SHAPE_ERROR",
    });
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    await store.close();
  });

  it("accepts nullable display fields and counts deleted or incomplete rows as skipped", async () => {
    const store = new Store(DB);
    await store.migrate();
    const stub = await startScoutStub([
      {
        match: (cypher) => cypher.includes("FOLLOWS"),
        status: 200,
        body: {
          results: [
            { event_kind: "post", author_id: USERB, author_name: null, post_id: "p1", content: "one", indexed_at: 1, deleted: false },
            { event_kind: "post", author_id: USERB, author_name: "Bea", post_id: "p2", content: null, indexed_at: 2, deleted: false },
            { event_kind: "post", author_id: USERB, author_name: "Bea", post_id: "p3", content: "three", indexed_at: 3, deleted: true },
          ],
          count: 3,
          truncated: false,
        },
      },
      { status: 200, body: { results: [], count: 0, truncated: false } },
    ]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url, scoutMaxQps: 50 }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url, scoutMaxQps: 50 }), store.pool),
    });
    const out = await tools.get_what_did_i_miss.execute({ owner: USER, since: 10, until: 20, limit: 10 }) as {
      skipped: number;
      posts: unknown[];
    };
    expect(out.skipped).toBe(3);
    expect(out.posts).toHaveLength(0);
    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
    await store.close();
  });

  it("rejects invalid event kinds, objects, and non-scalar fields", async () => {
    const invalidRows = [
      { event_kind: "unknown", author_id: USERB, author_name: "Bea", post_id: "p1", content: "one", indexed_at: 1, deleted: false },
      { event_kind: "post", author_id: USERB, author_name: { name: "Bea" }, post_id: "p1", content: "one", indexed_at: 1, deleted: false },
      null,
    ];
    for (const invalidRow of invalidRows) {
      const store = new Store(DB);
      await store.migrate();
      const stub = await startScoutStub([
        {
          match: (cypher) => cypher.includes("FOLLOWS"),
          status: 200,
          body: { results: [invalidRow], count: 1, truncated: false },
        },
        { status: 200, body: { results: [], count: 0, truncated: false } },
      ]);
      const tools = createScoutTools({
        cfg: cfg({ scoutUrl: stub.url, scoutMaxQps: 50 }),
        pool: store.pool,
        storeSwitchOn: async () => false,
        client: new ScoutClient(cfg({ scoutUrl: stub.url, scoutMaxQps: 50 }), store.pool),
      });
      expect(await tools.get_what_did_i_miss.execute({ owner: USER, since: 10, until: 20, limit: 10 })).toMatchObject({
        error: "SHAPE_ERROR",
      });
      await new Promise<void>((resolve) => stub.server.close(() => resolve()));
      await store.close();
    }
  });
});

describe("stage1 scout tools (12f)", () => {
  const opts = { limitMax: 50, profilePropMax: 3, rawEnabled: true };
  const NEW_TEMPLATE_NAMES = new Set([
    "follow_path_count",
    "follow_path",
    "trust_view_user",
    "trust_view_topic",
    "top_posts",
    "mentions_of",
    "profile_snapshot",
    "profile_tags_applied",
    "profile_replied_to",
    "profile_mutual",
  ]);

  function cypherForGuard(cypher: string, limit: number): string {
    return cypher.replace(/\bLIMIT\s+\$limit\s*$/i, `LIMIT ${limit}`);
  }

  it("param schemas accept bounded inputs and reject trust_view xor", async () => {
    const { followPathParams, trustViewParams, topPostsParams, mentionsOfParams, profileCardParams } = await import(
      "./tools.js"
    );
    expect(followPathParams.parse({ a: USER, b: USERB, max_hops: 3 }).max_hops).toBe(3);
    expect(() => followPathParams.parse({ a: USER, b: USERB, max_hops: 4 })).toThrow();
    expect(topPostsParams.parse({ metric: "bookmarks" }).metric).toBe("bookmarks");
    expect(() => topPostsParams.parse({ metric: "likes" })).toThrow();
    expect(mentionsOfParams.parse({ pubky: USER }).pubky).toBe(USER);
    expect(profileCardParams.parse({ pubky: USER, asker: USERB }).asker).toBe(USERB);
    expect(() => trustViewParams.parse({ asker: USER })).toThrow();
    expect(() => trustViewParams.parse({ asker: USER, target: USER, topic: "x" })).toThrow();
    expect(trustViewParams.parse({ asker: USER, target: USERB }).target).toBe(USERB);
    expect(trustViewParams.parse({ asker: USER, topic: "bitcoin" }).topic).toBe("bitcoin");
  });

  it("template hop/limit clamps fall back to 1 on NaN/Infinity (audit F-C)", () => {
    const time = { since: 0, until: 1 };
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(followPathCountTemplate(USER, USERB, bad).cypher).toContain("FOLLOWS*1..1");
      expect(followPathTemplate(USER, USERB, bad, 5).cypher).toContain("FOLLOWS*1..1");
      expect(trustViewUserTemplate(USER, USERB, bad, time, 5).cypher).toContain("FOLLOWS*1..1");
      expect(trustViewTopicTemplate(USER, "bitcoin", bad, time, 5).cypher).toContain("FOLLOWS*1..1");
      const lim = followPathTemplate(USER, USERB, 2, bad);
      expect(lim.limit).toBe(1);
      expect(lim.params.limit).toBe(1);
    }
    // Finite values clamp exactly as before.
    expect(followPathTemplate(USER, USERB, 99, 99).cypher).toContain("FOLLOWS*1..3");
    expect(followPathTemplate(USER, USERB, 2, 99).limit).toBe(25);
  });

  it("runs the cypher guard over each new template", () => {
    const news = allTemplateCyphers().filter((q) => NEW_TEMPLATE_NAMES.has(q.name));
    expect(news.length).toBeGreaterThanOrEqual(NEW_TEMPLATE_NAMES.size);
    for (const q of news) {
      const r = guardRawCypher(cypherForGuard(q.cypher, q.limit), q.params, opts);
      expect(r.ok, `${q.name}: ${r.reason}`).toBe(true);
    }
  });

  it("follow_path / trust_view / top_posts / mentions_of / profile_card shapes from stub", async () => {
    const store = new Store(DB);
    await store.migrate();
    const stub = await startScoutStub([
      {
        match: (c) => c.includes("allShortestPaths") && c.includes("path_count"),
        status: 200,
        body: { results: [{ path_count: 2, hops: 2 }], count: 1, truncated: false },
      },
      {
        match: (c) => c.includes("allShortestPaths") && c.includes("hop_ids"),
        status: 200,
        body: {
          results: [{ hop_ids: [USER, USERB], hop_names: ["Ada", "Bea"], hops: 2 }],
          count: 1,
          truncated: false,
        },
      },
      {
        match: (c) => c.includes("graph_count"),
        status: 200,
        body: {
          results: [{ label: "builder", global_count: 9, graph_count: 2, claimant_ids: [USERB] }],
          count: 1,
          truncated: false,
        },
      },
      {
        match: (c) => c.includes("BOOKMARKED") || c.includes(" AS score"),
        status: 200,
        body: {
          results: [
            {
              author_id: USER,
              author_name: "Ada",
              post_id: POST,
              content: "hello world this is a post about pubky",
              indexed_at: 1,
              score: 4,
            },
          ],
          count: 1,
          truncated: false,
        },
      },
      {
        match: (c) => c.includes("MENTIONED"),
        status: 200,
        body: {
          results: [
            {
              author_id: USERB,
              author_name: "Bea",
              post_id: POST,
              content: "Ada, here is the Pubky detail you asked about.",
              indexed_at: 2,
              labels: ["pubky"],
              taggers: [USER],
            },
          ],
          count: 1,
          truncated: false,
        },
      },
      {
        match: (c) => c.includes("muted_count"),
        status: 200,
        body: { results: [{ id: USER, name: "Ada", indexed_at: 9, posts: 3, muted_count: 7 }], count: 1, truncated: false },
      },
      {
        match: (c) => c.includes("followers"),
        status: 200,
        body: { results: [{ followers: 9 }], count: 1, truncated: false },
      },
      {
        match: (c) => c.includes("following"),
        status: 200,
        body: { results: [{ following: 4 }], count: 1, truncated: false },
      },
      {
        match: (c) => c.includes("self_claim"),
        status: 200,
        body: {
          results: [{ label: "builder", count: 5, claimant_ids: [USERB], self_claim: false }],
          count: 1,
          truncated: false,
        },
      },
      {
        match: (c) => c.includes("TAGGED]->(x)"),
        status: 200,
        body: { results: [{ label: "pubky", count: 2 }], count: 1, truncated: false },
      },
      {
        match: (c) => c.includes("REPLIED]->(parent"),
        status: 200,
        body: { results: [{ pubky: USERB, name: "Bea", replies: 3 }], count: 1, truncated: false },
      },
      {
        match: (c) => c.includes("asker_follows_target"),
        status: 200,
        body: { results: [{ asker_follows_target: true, target_follows_asker: false }], count: 1, truncated: false },
      },
    ]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    const path = (await tools.follow_path.execute({ a: USER, b: USERB, max_hops: 3 })) as {
      paths: { hop_ids: string[]; hops: number }[];
      path_count: number;
    };
    expect(path.paths[0]?.hop_ids).toEqual([USER, USERB]);
    expect(path.path_count).toBe(2);
    expect(JSON.stringify(path)).not.toMatch(/trusted/i);

    const tv = (await tools.trust_view.execute({ asker: USER, target: USERB })) as {
      claims: { label: string; global_count: number; graph_count: number }[];
    };
    expect(tv.claims[0]?.global_count).toBe(9);
    expect(tv.claims[0]?.graph_count).toBe(2);

    const top = (await tools.top_posts.execute({ metric: "bookmarks", limit: 5 })) as {
      posts: { uri: string; score: number; content_preview: string }[];
    };
    expect(top.posts[0]?.uri).toBe(URI);
    expect(top.posts[0]?.score).toBe(4);
    expect(top.posts[0]?.content_preview.length).toBeLessThanOrEqual(140);

    const men = (await tools.mentions_of.execute({ pubky: USER })) as {
      posts: { author_id: string; uri: string; content: string; labels: string[] }[];
    };
    expect(men.posts[0]?.author_id).toBe(USERB);
    expect(men.posts[0]?.content).toContain("Pubky detail");
    expect(men.posts[0]?.labels).toEqual(["pubky"]);

    const card = (await tools.profile_card.execute({ pubky: USER, asker: USERB })) as {
      muted_count: number;
      posts: number;
      mutual?: { asker_follows_target: boolean };
      tags_received: { label: string }[];
      most_replied_to: { pubky: string }[];
    };
    expect(card.posts).toBe(3);
    expect(card.muted_count).toBe(7);
    expect(card.mutual?.asker_follows_target).toBe(true);
    expect(card.tags_received[0]?.label).toBe("builder");
    expect(card.most_replied_to[0]?.pubky).toBe(USERB);
    expect(JSON.stringify(card)).not.toMatch(/muted_by_ids|who muted/i);

    await new Promise<void>((r) => stub.server.close(() => r()));
    await store.close();
  });
});

void ScoutToolError;
