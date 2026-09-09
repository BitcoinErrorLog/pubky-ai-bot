import { describe, expect, it } from "vitest";
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
  query_graph: {
    description: "Raw Cypher",
    parameters: z.object({ cypher: z.string() }),
  },
};

describe("model Pubchi planner", () => {
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
});
