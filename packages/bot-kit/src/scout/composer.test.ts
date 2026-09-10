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
    ["MATCH (u:User {id:$id}) RETURN u.id LIMIT 1", ComposerErrorCode.PARAM_REQUIRED],
    ["MATCH (u:User {id:$id}) RETURN u.id LIMIT 1", ComposerErrorCode.LITERAL_LEAK],
    ["MATCH (u:User {id:$owner}) RETURN u.id LIMIT 1", ComposerErrorCode.TENANT_PARAM_REJECTED],
    ["MATCH (a:User)-[m:MUTED]->(b:User) RETURN a.id,b.id LIMIT 50", ComposerErrorCode.MUTED_VISIBILITY],
  ])("rejects forbidden query (%s)", (query, code) => {
    const result = compose(query, query.includes("$id") ? { id: owner } : {}, {
      untrustedTexts: query.includes("$id") ? [] : ["untrusted"],
    });
    expect(result).toMatchObject({ ok: false, code });
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
});

describe("composer hint table", () => {
  it("covers every error code", () => {
    for (const code of Object.values(ComposerErrorCode)) expect(COMPOSER_HINTS[code]).toBeTruthy();
  });
});
