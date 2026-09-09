import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTENT_REGEX_TABLES } from "../../../../src/intent.js";
import { log } from "../log.js";
import { loadGoldenScoutGraph } from "../scout/schema-model.js";
import { resetScoutBreakerForTests } from "../scout/circuit.js";
import { resetScoutSchemaCacheForTests, setActiveScoutSchemaForTests } from "../scout/schema-cache.js";
import { queryNlq } from "./service.js";
import type { Brain } from "../brain/types.js";

const USER = "1111111111111111111111111111111111111111111111111111";

function testBrain(text: string | (() => Promise<string>), calls: { count: number }): Brain {
  return {
    capabilities: {
      name: "test",
      providerId: "test",
      supportsTools: false,
      maxContextTokens: 1000,
      samplingDefaults: { temperature: 0 },
    },
    temperature: 0,
    generate: async () => {
      calls.count += 1;
      return { text: typeof text === "function" ? await text() : text, response: { messages: [] } };
    },
  } as Brain;
}

function options(brain: Brain) {
  return {
    cfg: {
      scoutUrl: "http://127.0.0.1:9",
      scoutTimeoutMs: 1000,
      scoutLimitMax: 25,
      scoutPerMentionCap: 12,
      scoutDailyCeiling: 400,
      scoutRawPerUserDaily: 8,
      scoutRawGlobalDaily: 40,
      scoutEnabled: true,
      scoutRawEnabled: false,
      scoutProfilePropMax: 3,
      scoutClaimantCap: 12,
    },
    pool: { query: async () => ({ rows: [{ n: "0" }] }) } as never,
    tables: INTENT_REGEX_TABLES,
    client: {
      query: async () => ({
        envelope: {
          results: [{ pubky: USER, name: "Alice", tags_received: 7, tags_applied: 2, posts: 3, followers: 4, following: 1 }],
          truncated: false,
          notes: [],
        },
      }),
    } as never,
    storeSwitchOn: async () => false,
    brain,
  };
}

describe("Pubchi model planner fallback", () => {
  beforeEach(() => {
    setActiveScoutSchemaForTests(loadGoldenScoutGraph(), "live");
    resetScoutBreakerForTests();
  });

  afterEach(() => {
    resetScoutSchemaCacheForTests();
    resetScoutBreakerForTests();
    vi.restoreAllMocks();
  });

  it("(a) skips the brain when regex routing succeeds", async () => {
    const calls = { count: 0 };
    const out = await queryNlq(
      { question: "Who are the most followed users?", pubchiMode: true },
      options(testBrain('{"tool":"rank_users","args":{"metric":"tags_received"},"confidence":1}', calls)),
    );
    expect(out.outcome).toBe("ok");
    expect(calls.count).toBe(0);
  });

  it("(b) calls once, dispatches rank_users, and returns execution evidence", async () => {
    const calls = { count: 0 };
    const brain = testBrain('{"tool":"rank_users","args":{"metric":"tags_received"},"confidence":0.9}', calls);
    const out = await queryNlq(
      { question: "Who has the most tags from different people on their posts and profile?", pubchiMode: true },
      options(brain),
    );
    expect(calls.count).toBe(1);
    expect(out).toMatchObject({
      outcome: "ok",
      planned: [{ tool: "rank_users", args: { metric: "tags_received" } }],
    });
    expect(out.toolTrace[0]).toMatchObject({ toolCalls: [{ name: "rank_users" }] });
    expect(out.results[0]).toMatchObject({ users: [{ name: "Alice", value: 7 }] });
  });

  it("(c,d) rejects malformed, unknown, extra-arg, and raw plans without execution", async () => {
    for (const text of [
      '{"tool":"missing","args":{},"confidence":1}',
      '{"tool":"rank_users","args":{"metric":"tags_received","extra":"x"},"confidence":1}',
      '{"tool":"rank_users"',
      "not json",
      '{"tool":"query_graph","args":{"cypher":"MATCH (n) RETURN n"},"confidence":1}',
    ]) {
      const calls = { count: 0 };
      const out = await queryNlq(
        { question: "Who has the most tags from different people?", pubchiMode: true },
        options(testBrain(text, calls)),
      );
      expect(out.outcome).toBe("unsupported");
      expect(out.results).toEqual([]);
      expect(out.planned).toEqual([]);
    }
  });

  it("(g) never calls the planner in Jeb mode", async () => {
    const calls = { count: 0 };
    const out = await queryNlq(
      { question: "Who has the most tags from different people?", pubchiMode: false },
      options(testBrain('{"tool":"rank_users","args":{"metric":"tags_received"},"confidence":1}', calls)),
    );
    expect(out.outcome).toBe("unsupported");
    expect(calls.count).toBe(0);
  });

  it("(h) records route source without logging question text", async () => {
    const info = vi.spyOn(log, "info");
    const calls = { count: 0 };
    await queryNlq(
      { question: "Who are the most followed users?", pubchiMode: true },
      options(testBrain('{"tool":"rank_users","args":{"metric":"tags_received"},"confidence":1}', calls)),
    );
    await queryNlq(
      { question: "Who has the most tags from different people?", pubchiMode: true },
      options(testBrain('{"tool":"rank_users","args":{"metric":"tags_received"},"confidence":1}', calls)),
    );
    await queryNlq(
      { question: "why does this exist", pubchiMode: true },
      options(testBrain('{"tool":null}', calls)),
    );
    const routes = info.mock.calls
      .map(([value]) => value)
      .filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null && "route_source" in value);
    expect(routes.map((value) => value.route_source)).toEqual(["regex", "model", "none"]);
    expect(JSON.stringify(info.mock.calls)).not.toContain("why does this exist");
  });
});
