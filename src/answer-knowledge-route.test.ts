import { describe, expect, it } from "vitest";
import { answerMention } from "./answer.js";
import type { Config } from "./config.js";
import type { ChainPost } from "./context.js";
import { GRAPH_TAG_TOOLS } from "./knowledge/route.js";
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

async function answerQuestion(content: string, chain?: ChainPost[], current?: ChainPost) {
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
      current ?? { ...mention, content },
      chain ?? [{ ...mention, content }],
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
    "Need help recovering access to my identity",
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

  it("keeps graph reads available without forcing knowledge for an explicit tagger ask", async () => {
    const question = "Who tagged posts about Paykit?";
    const { out, fake } = await answerQuestion(question);
    try {
      const names = toolNames(fake.bodies[0] ?? {});
      expect(names).toEqual(expect.arrayContaining(["search_knowledge", "search_posts_by_tag", "get_post"]));
      expect(JSON.stringify(out.toolTrace)).not.toContain("search_knowledge");
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it.each([
    "Show me posts about Paykit",
    "Who tagged Paykit posts?",
    "Which people are discussing Paykit?",
    "What's the network activity around Paykit?",
  ])("keeps graph tools available for an explicit graph question: %s", async (question) => {
    const { fake } = await answerQuestion(question);
    try {
      expect(toolNames(fake.bodies[0] ?? {})).toEqual(expect.arrayContaining([
        "get_post",
        "search_posts_by_tag",
      ]));
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  const bitbearParent: ChainPost = {
    uri: "pubky://bitbear/pub/pubky.app/posts/0035S1SZZZZZZ",
    createdAt: 1,
    author: "bitbear",
    name: "Bitbear",
    content: "My identity settings show backup greyed out because I already backed up or closed my browser. Is Pubky Ring now my only way to maintain this profile, or do I have to start again to get a recovery phrase or encrypted backup?",
  };
  const johnMention: ChainPost = {
    uri: "pubky://gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo/pub/pubky.app/posts/0035S1T3ZQAPG",
    createdAt: 2,
    author: "gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo",
    name: "John",
    content: "@Jeb attempt to provide some customer support, and explain how the keys work and what he can do with them, and how Pubky is different than nostr in these regards",
    replied: bitbearParent.uri,
  };

  it("adds Bitbear's parent subject to John's forced knowledge query and withholds graph tools", async () => {
    const { out, fake } = await answerQuestion(johnMention.content, [bitbearParent, johnMention], johnMention);
    try {
      const query = (out.toolTrace[0] as { toolCalls: Array<{ args: { query: string } }> }).toolCalls[0]?.args.query ?? "";
      expect(query).toContain(johnMention.content);
      expect(query).toContain("backup greyed out");
      expect(query).toContain("Pubky Ring");
      expect(query).toContain("recovery phrase");
      const names = toolNames(fake.bodies[0] ?? {});
      for (const graphTool of GRAPH_TAG_TOOLS) expect(names).not.toContain(graphTool);
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it("uses the direct parent in a deep thread", async () => {
    const unrelatedRoot: ChainPost = {
      uri: "pubky://root/pub/pubky.app/posts/0035S1ROOT000",
      createdAt: 1,
      author: "root",
      name: "Root",
      content: "Which payment rail should my shop use?",
    };
    const directParent: ChainPost = {
      uri: "pubky://parent/pub/pubky.app/posts/0035S1PARENT0",
      createdAt: 4,
      author: "parent",
      name: "Parent",
      content: "My Passport session expired. How can I recover access?",
      replied: unrelatedRoot.uri,
    };
    const request: ChainPost = {
      ...johnMention,
      uri: "pubky://john/pub/pubky.app/posts/0035S1HELP000",
      createdAt: 5,
      content: "@Jeb please help the user in the parent post",
      replied: directParent.uri,
    };
    const { out, fake } = await answerQuestion(
      request.content,
      [unrelatedRoot, bitbearParent, directParent, request],
      request,
    );
    try {
      const query = (out.toolTrace[0] as { toolCalls: Array<{ args: { query: string } }> }).toolCalls[0]?.args.query ?? "";
      expect(query).toContain("Passport session expired");
      expect(query).not.toContain("payment rail");
      expect(query).not.toContain("backup greyed out");
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it("never substitutes a grandparent's different question for the direct parent", async () => {
    const grandparent: ChainPost = {
      uri: "pubky://grand/pub/pubky.app/posts/0035S1GRAND00",
      createdAt: 1,
      author: "grand",
      name: "Grandparent",
      content: "How do I recover my identity backup?",
    };
    const directParent: ChainPost = {
      uri: "pubky://parent/pub/pubky.app/posts/0035S1DIRECT0",
      createdAt: 2,
      author: "parent",
      name: "Parent",
      content: "How does Pubky Passport authorize this browser?",
      replied: grandparent.uri,
    };
    const request: ChainPost = {
      ...johnMention,
      uri: "pubky://john/pub/pubky.app/posts/0035S1DIRECT1",
      createdAt: 3,
      content: "@Jeb explain the request in the parent post",
      replied: directParent.uri,
    };
    const { out, fake } = await answerQuestion(
      request.content,
      [grandparent, directParent, request],
      request,
    );
    try {
      const query = (out.toolTrace[0] as { toolCalls: Array<{ args: { query: string } }> }).toolCalls[0]?.args.query ?? "";
      expect(query).toContain("Passport authorize this browser");
      expect(query).not.toContain("recover my identity backup");
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it("uses only the exact follow-up when its direct parent is Jeb", async () => {
    const followup: ChainPost = {
      uri: "pubky://gujx6qd8ksydh1makdphd3bxu351d9b8waqka8hfg6q7hnqkxexo/pub/pubky.app/posts/0035S1TKX0W60",
      createdAt: 5,
      author: johnMention.author,
      name: "John",
      content: "@Jeb bro no one asked for graph work. please reread the request and the original user post about his keys.",
      replied: "pubky://botpk/pub/pubky.app/posts/0035S1TAAAAAA",
    };
    const jebReply: ChainPost = {
      uri: "pubky://botpk/pub/pubky.app/posts/0035S1TAAAAAA",
      createdAt: 3,
      author: "botpk",
      name: "Jeb",
      content: "Previous Jeb response.",
    };
    const { out, fake } = await answerQuestion(
      followup.content,
      [bitbearParent, johnMention, jebReply, followup],
      followup,
    );
    try {
      const query = (out.toolTrace[0] as { toolCalls: Array<{ args: { query: string } }> }).toolCalls[0]?.args.query ?? "";
      expect(query).toBe(followup.content);
      expect(query).not.toContain("encrypted backup");
      expect(query).not.toContain("Pubky Ring");
      expect(query).not.toContain(johnMention.content);
      expect(query).not.toContain("Previous Jeb response");
      const names = toolNames(fake.bodies[0] ?? {});
      for (const graphTool of GRAPH_TAG_TOOLS) expect(names).not.toContain(graphTool);
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });
});
