import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Store } from "../db.js";
import { configFromProcessEnv } from "../config.js";
import { toolsForIntent } from "../intent.js";
import { ScoutClient, setScoutBackoff, ScoutToolError } from "./client.js";
import { createScoutTools } from "./tools.js";
import { allTemplateCyphers, GOLDEN_LABELS, GOLDEN_RELS } from "./templates.js";
import { guardRawCypher } from "./guard.js";
import { formatScoutEvidenceBlock, scoutEvidenceBundle, SCOUT_SYSTEM_ADDENDUM } from "./evidence.js";
import { startScoutStub } from "./stub.js";
import { checkScoutBudgets } from "./budget.js";
import type { Config } from "../config.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const USER = "1111111111111111111111111111111111111111111111111111";
const USERB = "2222222222222222222222222222222222222222222222222222";
const POST = "AAAAAAAAAAAAA";
const URI = `pubky://${USER}/pub/pubky.app/posts/${POST}`;

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
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../tests/scout/fixtures/search_posts.json"), "utf8"),
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
    }
    expect(toolsForIntent("summarize")).not.toContain("search_posts");
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
      users: { pubky: string; value: number; tags_applied: number; posts: number }[];
      truncated: boolean;
    };
    expect(out.users[0]?.pubky).toBe(USER);
    expect(out.users[0]?.value).toBe(20);
    expect(out.users[0]?.tags_applied).toBe(20);
    expect(out.truncated).toBe(false);
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

void ScoutToolError;
