import { describe, expect, it } from "vitest";
import { answerMention } from "./answer.js";
import type { Config } from "./config.js";
import type { ChainPost } from "./context.js";
import { Nexus } from "./nexus.js";
import { completionJson, startFakeOpenAI } from "../tests/fake-openai.js";

const mention: ChainPost = {
  uri: "pubky://1111111111111111111111111111111111111111111111111111/pub/pubky.app/posts/0000000000001",
  createdAt: 1,
  author: "1111111111111111111111111111111111111111111111111111",
  name: "u",
  content: "hello jeb",
};

function toolNames(body: Record<string, unknown>): string[] {
  const tools = body.tools;
  if (!Array.isArray(tools)) return [];
  const names: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const record = tool as Record<string, unknown>;
    if (typeof record.name === "string") names.push(record.name);
    const fn = record.function;
    if (fn && typeof fn === "object" && typeof (fn as { name?: unknown }).name === "string") {
      names.push((fn as { name: string }).name);
    }
  }
  return names;
}

async function answerQuestion(content: string) {
  const fake = await startFakeOpenAI({
    handler: () => ({ json: completionJson("routed-answer") }),
  });
  const cfg = {
    cannedReply: undefined,
    modelApiKey: "sk-test",
    modelBaseUrl: fake.url,
    model: "gpt-4o-mini",
    modelTimeoutMs: 5_000,
    answerBudgetMs: 30_000,
    toolMaxSteps: 2,
  } as Config;
  try {
    const out = await answerMention(
      cfg,
      new Nexus("http://127.0.0.1:9"),
      "botpk",
      { ...mention, content },
      [{ ...mention, content }],
    );
    return { out, fake };
  } catch (error) {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    throw error;
  }
}

describe("answer path knowledge routing", () => {
  it("does not force knowledge for a greeting and still offers graph reads", async () => {
    const { out, fake } = await answerQuestion("hello jeb");
    try {
      expect(out.intent).toBe("answer");
      expect(out.content).toContain("routed-answer");
      expect(JSON.stringify(out.toolTrace)).not.toContain("search_knowledge");
      expect(toolNames(fake.bodies[0] ?? {})).toEqual(expect.arrayContaining(["get_post", "search_posts_by_tag"]));
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it.each([
    "What vibes are on the vibes board?",
    "What vibes are on the vibes portal?",
    "What is Pubky Passport and how does recovery work?",
    "What's new in pubky-app 1.11?",
    "What's the status of Paykit and Locks?",
    "What can I do on the Pubky Marketplace?",
  ])("calls search_knowledge before the model answers: %s", async (question) => {
    const { out, fake } = await answerQuestion(question);
    try {
      expect(out.content).toContain("routed-answer");
      expect(out.toolTrace[0]).toEqual({
        toolCalls: [{ name: "search_knowledge", args: { query: question } }],
      });
      const names = toolNames(fake.bodies[0] ?? {});
      expect(names).toContain("search_knowledge");
      expect(names).not.toContain("get_topic_brief");
      expect(names).not.toContain("get_tag_landscape");
      expect(names).not.toContain("search_posts_by_tag");
      expect(names).not.toContain("get_post");
      const messages = JSON.stringify(fake.bodies[0]?.messages ?? []);
      expect(messages).toContain("DATABASE_URL required for search_knowledge");
      expect(messages).toContain("Graph and tag tools are withheld");
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it("does not reach the model when no answer time remains for the forced knowledge call", async () => {
    const fake = await startFakeOpenAI({
      handler: () => ({ json: completionJson("should-not-run") }),
    });
    const question = "What is Pubky Passport and how does recovery work?";
    const cfg = {
      cannedReply: undefined,
      modelApiKey: "sk-test",
      modelBaseUrl: fake.url,
      model: "gpt-4o-mini",
      modelTimeoutMs: 5_000,
      answerBudgetMs: 1,
      toolMaxSteps: 2,
    } as Config;
    try {
      await expect(
        answerMention(cfg, new Nexus("http://127.0.0.1:9"), "botpk", { ...mention, content: question }, [
          { ...mention, content: question },
        ]),
      ).rejects.toThrow("no evidence and no text");
      expect(fake.bodies).toHaveLength(0);
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it("keeps graph reads available after search_knowledge for an explicit tagger ask", async () => {
    const question = "Who tagged posts about Paykit?";
    const { out, fake } = await answerQuestion(question);
    try {
      expect(out.toolTrace[0]).toEqual({
        toolCalls: [{ name: "search_knowledge", args: { query: question } }],
      });
      const names = toolNames(fake.bodies[0] ?? {});
      expect(names).toEqual(expect.arrayContaining(["search_knowledge", "search_posts_by_tag", "get_post"]));
      const messages = JSON.stringify(fake.bodies[0]?.messages ?? []);
      expect(messages).toContain("DATABASE_URL required for search_knowledge");
      expect(messages).toContain("Use that evidence before any graph or tag tool");
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });
});
