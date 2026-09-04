import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../../../../src/db.js";
import { configFromProcessEnv } from "../../../../src/config.js";
import { ScoutClient } from "../scout/client.js";
import { createScoutTools } from "../scout/tools.js";
import { resetScoutBreakerForTests } from "../scout/circuit.js";
import { refreshScoutSchema, resetScoutSchemaCacheForTests } from "../scout/schema-cache.js";
import { extractCypherSchemaRefs } from "../scout/schema-refs.js";
import {
  identityFollowersTemplate,
  identityFollowingTemplate,
  identityTagsTemplate,
  RELATED,
  TOP_POST_METRICS,
} from "../scout/templates.js";
import { SCOUT_TOOLS, type AllowedTool } from "./intent.js";
import { cyphersForTool } from "./tool-deps.js";
import { startNlqScoutStub } from "./stub.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const USER = "1111111111111111111111111111111111111111111111111111";
const USERB = "2222222222222222222222222222222222222222222222222222";
const POST = `pubky://${USER}/pub/pubky.app/posts/AAAAAAAAAAAAA`;

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

function refsCovered(listed: string[], emitted: string): boolean {
  const have = extractCypherSchemaRefs(listed.join("\n"));
  const need = extractCypherSchemaRefs(emitted);
  return (
    need.labels.every((l) => have.labels.includes(l)) &&
    need.relTypes.every((r) => have.relTypes.includes(r)) &&
    need.properties.every((p) => have.properties.includes(p))
  );
}

describe("cyphersForTool coverage (F-9)", () => {
  it("lists all seven profile_card templates", () => {
    const listed = cyphersForTool("profile_card");
    expect(listed).toHaveLength(7);
    expect(listed).toContain(identityFollowersTemplate("id").cypher);
    expect(listed).toContain(identityFollowingTemplate("id").cypher);
    expect(listed).toContain(identityTagsTemplate("id", { since: 1, until: 2 }, 10).cypher);
  });

  it("covers every cypher each scout tool can emit", async () => {
    const stub = await startNlqScoutStub();
    const c = {
      ...configFromProcessEnv({ requireSecret: false }),
      scoutUrl: stub.url,
      scoutEnabled: true,
      scoutRawEnabled: true,
      scoutMaxQps: 50,
    };
    const client = new ScoutClient(c, store.pool);
    await refreshScoutSchema(client);
    const tools = createScoutTools({
      cfg: c,
      pool: store.pool,
      storeSwitchOn: async () => false,
      client,
    });

    const runs: Array<{ tool: AllowedTool; args: Record<string, unknown> }> = [
      { tool: "search_posts", args: { query: "pubky" } },
      { tool: "scout_get_thread", args: { uri: POST } },
      { tool: "get_identity_summary", args: { pubky: USER } },
      { tool: "get_topic_brief", args: { topic: "pubky" } },
      { tool: "get_what_changed", args: { topic: "pubky", since: 1 } },
      ...RELATED.map((relationship) => ({
        tool: "get_related_posts" as const,
        args: { uri: POST, relationship },
      })),
      { tool: "get_relationship", args: { pubky_a: USER, pubky_b: USERB } },
      { tool: "get_tag_landscape", args: { tag: "pubky" } },
      { tool: "get_emerging_topics", args: {} },
      { tool: "get_debate_map", args: { topic: "pubky" } },
      { tool: "search_users_by_name", args: { name: "Ada" } },
      { tool: "rank_users", args: { metric: "tags_applied_per_post" } },
      { tool: "recommend_follows", args: { pubky: USER } },
      { tool: "stale_follows", args: { pubky: USER } },
      { tool: "follow_path", args: { a: USER, b: USERB } },
      { tool: "trust_view", args: { asker: USER, target: USERB } },
      { tool: "trust_view", args: { asker: USER, topic: "pubky" } },
      ...TOP_POST_METRICS.map((metric) => ({ tool: "top_posts" as const, args: { metric } })),
      { tool: "mentions_of", args: { pubky: USER } },
      { tool: "profile_card", args: { pubky: USER, asker: USERB } },
    ];

    const emitted = new Map<string, string[]>();
    for (const run of runs) {
      stub.calls.length = 0;
      const tool = tools[run.tool as keyof typeof tools] as { execute: (args: never) => Promise<unknown> };
      await tool.execute(run.args as never);
      const cyphers = stub.calls.map((raw) => {
        const body = JSON.parse(raw) as { cypher?: string };
        return body.cypher ?? "";
      }).filter(Boolean);
      emitted.set(run.tool, [...(emitted.get(run.tool) ?? []), ...cyphers]);
    }

    const scoutEmitters = SCOUT_TOOLS.filter((t) => t !== "query_graph");
    for (const tool of scoutEmitters) {
      const listed = cyphersForTool(tool);
      const got = emitted.get(tool) ?? [];
      expect(got.length, `${tool} emitted no cypher`).toBeGreaterThan(0);
      for (const cypher of got) {
        expect(refsCovered(listed, cypher), `${tool} missed refs for ${cypher.slice(0, 80)}`).toBe(true);
      }
    }

    await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  });
});
