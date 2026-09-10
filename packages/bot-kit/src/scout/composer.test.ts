import { describe, expect, it } from "vitest";
import { loadGoldenScoutGraph } from "./schema-model.js";
import {
  COMPOSER_HINTS,
  ComposerErrorCode,
  composeCypher,
  revalidateResolvedParams,
} from "./composer.js";
import { memoryComposedQueryBudget, ScoutCallBudgetError, ScoutCallMeter } from "./budget.js";

const owner = "a".repeat(52);
const schema = loadGoldenScoutGraph();
const base = { tenant: { owner }, schema, untrustedTexts: [] };

function compose(query: string, params: Record<string, unknown> = {}, extra: Partial<typeof base> = {}) {
  return composeCypher({ ...base, ...extra, query, params });
}

describe("composeCypher", () => {
  it.each([
    ["CREATE (u:User {id:$id}) RETURN u LIMIT 1", ComposerErrorCode.QUERY_NOT_READ_ONLY],
    ["MATCH (u:User {id:$id}) CALL db.labels() RETURN u LIMIT 1", ComposerErrorCode.QUERY_NOT_READ_ONLY],
    ["MATCH (u:User {id:$id}) RETURN u LIMIT 1; MATCH (x:User) RETURN x LIMIT 1", ComposerErrorCode.MULTIPLE_STATEMENTS],
    ["// no\nMATCH (u:User {id:$id}) RETURN u LIMIT 1", ComposerErrorCode.COMMENT],
    ["MATCH (u:User {id:$id})-[:FOLLOWS*]->(x:User) RETURN x.id LIMIT 1", ComposerErrorCode.UNBOUNDED_PATH],
    ["MATCH (u:User {id:$id}) RETURN u.id LIMIT 51", ComposerErrorCode.LIMIT_TOO_HIGH],
    ["MATCH (u:User {id:$id}) RETURN u.id", ComposerErrorCode.LIMIT_REQUIRED],
    ["MATCH (u:User {id:$id}) MATCH (x:User) RETURN x.id LIMIT 1", ComposerErrorCode.CARTESIAN_PRODUCT],
    ["MATCH (u:User {id:$id}) UNWIND range(1, 100) AS n RETURN n LIMIT 1", ComposerErrorCode.COST],
    ["MATCH (u:User {id:$id}) RETURN u.name ORDER BY u.name LIMIT 1", ComposerErrorCode.ORDER_BY_UNINDEXED],
    ["MATCH (u:User {id:$missing}) RETURN u.id LIMIT 1", ComposerErrorCode.PARAM_REQUIRED],
    ["MATCH (u:User {id:$id}) WHERE u.name = 'private question from context' RETURN u.id LIMIT 1", ComposerErrorCode.LITERAL_LEAK],
    ["MATCH (u:User {id:$owner}) RETURN u.id LIMIT 1", ComposerErrorCode.TENANT_PARAM_REJECTED],
    ["MATCH (a:User)-[m:MUTED]->(b:User) RETURN a.id,b.id LIMIT 50", ComposerErrorCode.MUTED_VISIBILITY],
    ["MERGE (u:User {id:$id}) RETURN u LIMIT 1", ComposerErrorCode.QUERY_NOT_READ_ONLY],
    ["MATCH (u:User {id:$id}) SET u.name = $name RETURN u.id LIMIT 1", ComposerErrorCode.QUERY_NOT_READ_ONLY],
    ["MATCH (u:User {id:$id}) REMOVE u.name RETURN u.id LIMIT 1", ComposerErrorCode.QUERY_NOT_READ_ONLY],
    ["MATCH (u:User {id:$id}) DETACH DELETE u LIMIT 1", ComposerErrorCode.QUERY_NOT_READ_ONLY],
    ["MATCH (u:User {id:$id}) LOAD CSV FROM $uri AS row RETURN row LIMIT 1", ComposerErrorCode.QUERY_NOT_READ_ONLY],
    ["MATCH (u:User {id:$id}) CALL { RETURN u } RETURN u LIMIT 1", ComposerErrorCode.QUERY_NOT_READ_ONLY],
    ["MATCH (u:User {id:$id}) RETURN u.id LIMIT 0", ComposerErrorCode.LIMIT_TOO_HIGH],
    ["MATCH (u:User {id:$id}) RETURN u.id LIMIT 100", ComposerErrorCode.LIMIT_TOO_HIGH],
    ["MATCH (u:User {id:$id}) OPTIONAL MATCH (u)-[:FOLLOWS]->(a:User) OPTIONAL MATCH (u)-[:FOLLOWS]->(b:User) OPTIONAL MATCH (u)-[:FOLLOWS]->(c:User) RETURN u.id LIMIT 1", ComposerErrorCode.OPTIONAL_MATCH_CAP],
    ["MATCH (u:User {id:$id}) UNWIND [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22] AS n RETURN n LIMIT 1", ComposerErrorCode.COST],
    ["MATCH (u:User {id:$id}) RETURN u.id ORDER BY u.bio LIMIT 1", ComposerErrorCode.ORDER_BY_UNINDEXED],
    ["MATCH (u:User {id:$id}) MATCH (p:Post) RETURN p.id LIMIT 1", ComposerErrorCode.CARTESIAN_PRODUCT],
    ["MATCH (u:User {id:$id})-[:FOLLOWS*1..]->(x:User) RETURN x.id LIMIT 1", ComposerErrorCode.UNBOUNDED_PATH],
    ["MATCH (u:User {id:$id}) RETURN u.id LIMIT 999", ComposerErrorCode.LIMIT_TOO_HIGH],
    ["MATCH (u:User {id:$id}) RETURN u.id /* leaked */ LIMIT 1", ComposerErrorCode.COMMENT],
    ["MATCH (u:User {id:$id}) RETURN u.id // leaked\nLIMIT 1", ComposerErrorCode.COMMENT],
    ["MATCH (u:User {id:$id}),(x:User) RETURN x.id LIMIT 50", ComposerErrorCode.CARTESIAN_PRODUCT],
  ])("rejects forbidden query (%s)", (query, code) => {
    const result = compose(query, code === ComposerErrorCode.PARAM_REQUIRED ? {} :
      code === ComposerErrorCode.TENANT_PARAM_REJECTED ? { owner } : query.includes("$id") ? { id: owner } : {}, {
      untrustedTexts: query.includes("$id") ? [] : ["untrusted"],
    });
    expect(result).toMatchObject({ ok: false, code });
  });

  it.each([
    "MATCH (u:User {id:$id}) RETURN u.id LIMIT 1",
    "MATCH (u:User {id:$id}) RETURN u.name LIMIT 5",
    "MATCH (u:User {id:$id})-[:FOLLOWS]->(f:User) RETURN f.id LIMIT 10",
    "MATCH (u:User {id:$id})-[t:TAGGED]->(p:Post) WHERE t.indexed_at >= $since RETURN t.label LIMIT 10",
    "MATCH (u:User {id:$id})-[t:TAGGED]->(p:Post) RETURN count(p) AS posts ORDER BY posts DESC LIMIT 10",
    "MATCH (u:User {id:$id}) OPTIONAL MATCH (u)-[:FOLLOWS]->(f:User) RETURN count(f) AS follows LIMIT 1",
    "MATCH (u:User {id:$id})-[:AUTHORED]->(p:Post) RETURN count(p) AS posts LIMIT 1",
    "MATCH (u:User {id:$owner})-[m:MUTED]->(w:User) RETURN count(m) AS muted LIMIT 1",
  ])("accepts bounded composed query %s", (query) => {
    const result = compose(query, query.includes("$owner") ? {} : {
      id: owner,
      ...(query.includes("$since") ? { since: 1_700_000_000_000 } : {}),
    });
    expect(result.ok).toBe(true);
  });

  it("accepts the top tagger follow-up and injects owner", () => {
    const result = compose(
      "MATCH (u:User {id:$user})-[t:TAGGED]->(p:Post) WHERE t.indexed_at >= $since AND t.indexed_at <= $until RETURN t.label AS label,count(*) AS count ORDER BY count DESC LIMIT 10",
      { user: owner, since: 1_700_000_000_000, until: 1_700_000_100_000 },
    );
    expect(result).toMatchObject({ ok: true, limit: 10 });
    if (result.ok) expect(result.params.owner).toBe(owner);
  });

  it("accepts an owner-anchored muted aggregate", () => {
    const result = compose(
      "MATCH (u:User {id:$owner})-[m:MUTED]->(w:User) RETURN count(DISTINCT m) AS muted_count LIMIT 10",
      {},
      { scopeKind: "owner_network" },
    );
    expect(result.ok).toBe(true);
  });

  it("holds usage-site uri params to the pubky public-path validator", () => {
    const query = "MATCH (f:File {id:$id}) WHERE f.uri = $target RETURN f.name LIMIT 1";
    expect(compose(query, { id: owner, target: `pubky://${owner}/pub/pubky.app/files/abc` }).ok).toBe(true);
    expect(compose(query, { id: owner, target: "https://evil.example/exfil?q=secret" }))
      .toMatchObject({ ok: false, code: ComposerErrorCode.PARAM_INVALID });
    expect(compose(query, { id: owner, target: `pubky://${owner}/pub/other.app/files/abc` }))
      .toMatchObject({ ok: false, code: ComposerErrorCode.PARAM_INVALID });
  });

  it("allows a whole-graph muted count but never muted enumeration", () => {
    expect(compose(
      "MATCH (a:User)-[m:MUTED]->(b:User) WHERE m.indexed_at >= $since RETURN count(*) AS muted_edges LIMIT 1",
      { since: 1_700_000_000_000 },
    ).ok).toBe(true);
    expect(compose(
      "MATCH (a:User)-[m:MUTED]->(b:User) WHERE m.indexed_at >= $since RETURN b.id AS muted, count(*) AS n LIMIT 50",
      { since: 1_700_000_000_000 },
    )).toMatchObject({ ok: false, code: ComposerErrorCode.MUTED_VISIBILITY });
  });

  it("splits comma-separated patterns without splitting map literals", () => {
    expect(compose(
      "MATCH (u:User {id:$id, indexed_at:1})-[:FOLLOWS]->(f:User), (f)-[:AUTHORED]->(p:Post) RETURN p.id LIMIT 10",
      { id: owner },
    ).ok).toBe(true);
  });

  it.each([
    "MATCH (u:User {id:$id})-[:AUTHORED]->(p:Post) RETURN p LIMIT 50",
    "MATCH (u:User {id:$id})-[:AUTHORED]->(p:Post) RETURN p AS post LIMIT 50",
    "MATCH (u:User {id:$id})-[:AUTHORED]->(p:Post) RETURN [(u)-[:AUTHORED]->(p) | p] LIMIT 50",
    "MATCH (u:User {id:$id})-[:AUTHORED]->(p:Post) RETURN properties(p) LIMIT 50",
    "MATCH (u:User {id:$id})-[:AUTHORED]->(p:Post) RETURN p{.*} LIMIT 50",
  ])("rejects whole post output: %s", (query) => {
    expect(compose(query, { id: owner })).toMatchObject({ ok: false, code: ComposerErrorCode.QUERY_NOT_READ_ONLY });
  });

  it("allows explicit safe post properties and mentions from other authors", () => {
    expect(compose(
      "MATCH (u:User {id:$id})-[:AUTHORED]->(p:Post) RETURN p.id, p.indexed_at LIMIT 10",
      { id: owner },
    ).ok).toBe(true);
    expect(compose(
      "MATCH (u:User {id:$id})<-[:MENTIONED]-(p:Post) RETURN p.content LIMIT 10",
      { id: owner },
    ).ok).toBe(true);
  });

  it("caps parameter size and validates usage sites", () => {
    expect(compose("UNWIND $ids AS id MATCH (u:User {id:$id}) RETURN u.id LIMIT 1", {
      id: owner,
      ids: Array.from({ length: 51 }, () => owner),
    })).toMatchObject({ ok: false, code: ComposerErrorCode.PARAM_INVALID });
    expect(compose("MATCH (u:User {id:$target}) RETURN u.id LIMIT 1", { target: "not-z32" }))
      .toMatchObject({ ok: false, code: ComposerErrorCode.PARAM_INVALID });
    expect(compose("MATCH (u:User {id:$id}) WHERE u.name = $note RETURN u.id LIMIT 1", { id: owner, note: "x".repeat(513) }))
      .toMatchObject({ ok: false, code: ComposerErrorCode.PARAM_INVALID });
    expect(compose("UNWIND $chunks AS chunk MATCH (u:User {id:$id}) RETURN u.id LIMIT 1", {
      id: owner,
      chunks: Array.from({ length: 10 }, () => "x".repeat(500)),
    })).toMatchObject({ ok: false, code: ComposerErrorCode.PARAM_INVALID });
  });

  it("rejects non-ASCII syntax outside literals", () => {
    expect(compose("MATCH (u:User {id:$id}) RETURN u.id CREАTE LIMIT 1", { id: owner }).ok).toBe(false);
  });

  it("rejects leaked context literals and validates resolved params", () => {
    expect(compose("MATCH (u:User {id:$id}) WHERE u.name = 'a private question with words' RETURN u.id LIMIT 1", { id: owner }, {
      untrustedTexts: ["A private question with words"],
    })).toMatchObject({ ok: false, code: ComposerErrorCode.LITERAL_LEAK });
    expect(() => revalidateResolvedParams({ user: "bad" })).toThrow();
  });
});

describe("composer budgets", () => {
  it("caps owner queries at 60 and calls at 10/20000ms", async () => {
    const budget = memoryComposedQueryBudget();
    for (let i = 0; i < 60; i += 1) expect(await budget.allow(owner)).toBe(true);
    expect(await budget.allow(owner)).toBe(false);
    const meter = new ScoutCallMeter();
    for (let i = 0; i < 10; i += 1) meter.record(2_000);
    expect(() => meter.assertBudget()).not.toThrow();
    meter.record(1);
    expect(() => meter.assertBudget()).toThrowError(new ScoutCallBudgetError("SCOUT_CALL_CAP"));
  });

  it("resets the memory budget at the UTC-day boundary", async () => {
    let now = new Date("2026-09-10T23:59:59.000Z");
    const budget = memoryComposedQueryBudget({ ownerDailyCap: 1, globalDailyCap: 1, now: () => now });
    expect(await budget.allow(owner)).toBe(true);
    expect(await budget.allow(owner)).toBe(false);
    now = new Date("2026-09-11T00:00:00.000Z");
    expect(await budget.allow(owner)).toBe(true);
  });
});

describe("composer hint table", () => {
  it("covers every error code", () => {
    for (const code of Object.values(ComposerErrorCode)) expect(COMPOSER_HINTS[code]).toBeTruthy();
  });
});
