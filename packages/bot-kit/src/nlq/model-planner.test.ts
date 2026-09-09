import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  modelPlanPubchi,
  renderPubchiToolCatalog,
  type ModelPlannerTools,
} from "./model-planner.js";
import type { Brain } from "../brain/types.js";

function brain(text: string): Brain {
  return {
    capabilities: {
      name: "test",
      providerId: "test",
      supportsTools: false,
      maxContextTokens: 1000,
      samplingDefaults: { temperature: 0 },
    },
    temperature: 0,
    generate: async () => ({ text, response: { messages: [] } }),
  } as Brain;
}

const tools: ModelPlannerTools = {
  rank_users: {
    description: "Rank users by graph metric",
    parameters: z.object({
      metric: z.enum(["tags_received", "followers"]),
      order: z.enum(["asc", "desc"]).optional(),
    }),
  },
  top_posts: {
    description: "Find active posts",
    parameters: z.object({ metric: z.enum(["replies", "reposts"]), topic: z.string().optional() }),
  },
  get_emerging_topics: {
    description: "Find emerging topics",
    parameters: z.object({}),
  },
  recommend_follows: {
    description: "Recommend follows",
    parameters: z.object({ pubky: z.string() }),
  },
  query_graph: {
    description: "Raw Cypher",
    parameters: z.object({ cypher: z.string() }),
  },
};

describe("model Pubchi planner", () => {
  afterEach(() => vi.useRealTimers());
  it("renders the served schema and excludes query_graph", () => {
    const catalog = renderPubchiToolCatalog(tools);
    expect(catalog).toContain('"name":"rank_users"');
    expect(catalog).toContain('"enum":["tags_received","followers"]');
    expect(catalog).not.toContain("query_graph");
  });

  it("validates a selected tool and its enum arguments", async () => {
    const result = await modelPlanPubchi({
      brain: brain(
        '{"tool":"rank_users","args":{"metric":"tags_received"},"confidence":0.91}',
      ),
      question: "Who has the most tags from different people?",
      tools,
    });
    expect(result).toEqual({
      ok: true,
      planned: { tool: "rank_users", args: { metric: "tags_received" } },
      confidence: 0.91,
    });
  });

  it.each([
    '{"tool":"query_graph","args":{"cypher":"MATCH (n) RETURN n"},"confidence":1}',
    '{"tool":"rank_users","args":{"metric":"tags_received","extra":"x"},"confidence":1}',
    "I think rank_users is best",
  ])("fails closed for %s", async (text) => {
    const result = await modelPlanPubchi({
      brain: brain(text),
      question: "question",
      tools,
    });
    expect(result).toEqual({ ok: false });
  });

  it("(e) times out a brain that never resolves", async () => {
    vi.useFakeTimers();
    const pending = brain("");
    pending.generate = () => new Promise(() => undefined);
    const result = modelPlanPubchi({ brain: pending, question: "question", tools });
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(result).resolves.toEqual({ ok: false });
  });

  it("(f) dispatches ten natural phrasings through validated plans", async () => {
    const cases = [
      ["Who receives the most tags?", "rank_users", { metric: "tags_received" }],
      ["Which profiles have the highest tag counts?", "rank_users", { metric: "tags_received" }],
      ["Show the busiest reply threads", "top_posts", { metric: "replies" }],
      ["What posts are most reposted?", "top_posts", { metric: "reposts" }],
      ["What topics are taking off?", "get_emerging_topics", {}],
      ["Which subjects are newly popular?", "get_emerging_topics", {}],
      ["Who should I follow next?", "recommend_follows", { pubky: "1111111111111111111111111111111111111111111111111111" }],
      ["Find useful people to follow", "recommend_follows", { pubky: "1111111111111111111111111111111111111111111111111111" }],
      ["Tell me something unrelated", null, null],
      ["Can you write a poem?", null, null],
    ] as const;
    for (const [question, tool, args] of cases) {
      const text = tool === null ? '{"tool":null}' : JSON.stringify({ tool, args, confidence: 0.8 });
      const result = await modelPlanPubchi({ brain: brain(text), question, tools });
      if (tool === null) expect(result).toEqual({ ok: false });
      else expect(result).toMatchObject({ ok: true, planned: { tool, args } });
    }
  });
});
