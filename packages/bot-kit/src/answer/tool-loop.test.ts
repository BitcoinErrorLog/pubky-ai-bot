import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ScreenFlag } from "../security/tool-screen.js";
import {
  createToolLoop,
  type KnowledgeFirstRoute,
  type ToolLoopGenerate,
  type ToolLoopGenerateResult,
  type ToolLoopSpec,
} from "./tool-loop.js";

const passthroughScreen = (value: unknown) => ({ value, flags: [] });

const compose = {
  fromEvidencePrompt: "Compose from the evidence gathered so far; say what you could not check.",
  deterministicText: "deterministic-compose",
};

function abortWait(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

function textResult(text: string, tokens = 2): ToolLoopGenerateResult {
  return {
    text,
    usage: { totalTokens: tokens },
    response: { messages: [{ role: "assistant", content: text }] },
  };
}

describe("createToolLoop", () => {
  it("runs beforeModel for initial, post-tool, and final compose calls", async () => {
    let modelCalls = 0;
    let beforeCalls = 0;
    const outputCaps: Array<number | undefined> = [];
    const generate: ToolLoopGenerate = async ({ tools, maxOutputTokens }) => {
      modelCalls += 1;
      outputCaps.push(maxOutputTokens);
      if (tools) {
        const result = await (tools.post as { execute: (args: unknown) => Promise<unknown> }).execute({});
        return {
          text: "",
          toolCalls: [{ toolName: "post", args: {} }],
          toolResults: [result],
          response: {
            messages: [
              { role: "assistant", content: "" },
              { role: "tool", content: JSON.stringify(result) },
            ],
          },
        };
      }
      return textResult("final-compose");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: {
        post: { description: "post", parameters: z.object({}), execute: async () => ({ ok: true }) },
      },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 2_000 },
      budgets: { answerBudgetMs: 30_000, toolMaxSteps: 2 },
      maxOutputTokens: 4_096,
      beforeModel: async () => { beforeCalls += 1; },
    });
    expect((await loop.run({ prompt: "inspect" })).text).toBe("final-compose");
    expect(modelCalls).toBe(3);
    expect(beforeCalls).toBe(3);
    expect(outputCaps).toEqual([4_096, 4_096, 4_096]);
  });

  it("adds multimodal evidence gathered from a tool to the next model step", async () => {
    let calls = 0;
    let pending = false;
    const seenMessages: unknown[] = [];
    const generate: ToolLoopGenerate = async ({ tools, messages }) => {
      calls += 1;
      seenMessages.push(messages);
      if (calls === 1) {
        const result = await (tools?.post as { execute: (args: unknown) => Promise<unknown> }).execute({});
        return {
          text: "",
          toolCalls: [{ toolName: "post", args: {} }],
          toolResults: [result],
          response: { messages: [{ role: "assistant", content: "" }, { role: "tool", content: JSON.stringify(result) }] },
        };
      }
      return textResult("used-image");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: { post: { description: "post", parameters: z.object({}), execute: async () => ({ attachments: ["public-image"] }) } },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 2_000 },
      budgets: { answerBudgetMs: 30_000, toolMaxSteps: 3 },
      afterTool: async () => { pending = true; },
      takeAdditionalMessages: () => {
        if (!pending) return [];
        pending = false;
        return [{ role: "user", content: [{ type: "text", text: "image evidence" }] }];
      },
    });
    expect((await loop.run({ prompt: "inspect" })).text).toBe("used-image");
    expect(JSON.stringify(seenMessages[1])).toContain("image evidence");
  });

  it("turns a tool throw into an in-band error result and continues the loop", async () => {
    const seenErrors: unknown[] = [];
    let calls = 0;
    const generate: ToolLoopGenerate = async ({ tools }) => {
      calls += 1;
      if (calls === 1) {
        const boom = tools?.boom as { execute: (args: unknown) => Promise<unknown> };
        const result = await boom.execute({});
        seenErrors.push(result);
        return {
          text: "",
          toolCalls: [{ toolName: "boom", args: {} }],
          toolResults: [result],
          usage: { totalTokens: 3 },
          response: {
            messages: [
              { role: "assistant", content: "" },
              { role: "tool", content: JSON.stringify(result) },
            ],
          },
        };
      }
      return textResult("recovered-after-tool-error", 4);
    };
    const boom: ToolLoopSpec = {
      description: "throws",
      parameters: z.object({}),
      execute: async () => {
        throw new Error("nexus down");
      },
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: { boom },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 2_000 },
      budgets: { answerBudgetMs: 30_000, toolMaxSteps: 4 },
      identity: { systemPrompt: "You are a test bot." },
    });
    const out = await loop.run({ prompt: "call boom" });
    expect(seenErrors[0]).toEqual({ error: "nexus down" });
    expect(out.text).toBe("recovered-after-tool-error");
    expect(out.outcome).toBe("complete");
    expect(out.tokens).toBe(7);
    expect(out.toolTrace[0]).toEqual({ toolCalls: [{ name: "boom", args: {} }] });
    expect(calls).toBe(2);
  });

  it("returns the deadline outcome when the per-step timeout fires", async () => {
    const generate: ToolLoopGenerate = async ({ abortSignal }) => abortWait(abortSignal);
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: {},
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 40 },
      budgets: { answerBudgetMs: 10_000, toolMaxSteps: 3 },
      identity: { systemPrompt: "You are a test bot." },
    });
    const started = Date.now();
    const out = await loop.run({ prompt: "hang" });
    expect(out.outcome).toBe("deadline");
    expect(out.budgetExhausted).toBe(true);
    expect(out.hasEvidence).toBe(false);
    expect(out.text).toBe("");
    expect(Date.now() - started).toBeLessThan(400);
  });

  it("stops with the budget outcome when the overall answer budget is exhausted", async () => {
    let calls = 0;
    const generate: ToolLoopGenerate = async () => {
      calls += 1;
      return textResult("should-not-run");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: {},
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 5_000 },
      budgets: { answerBudgetMs: 100, toolMaxSteps: 6 },
      identity: { systemPrompt: "You are a test bot." },
    });
    const out = await loop.run({ prompt: "budget" });
    expect(out.outcome).toBe("budget");
    expect(out.budgetExhausted).toBe(true);
    expect(out.hasEvidence).toBe(false);
    expect(out.text).toBe("");
    expect(out.toolTrace).toEqual([{ budget_exhausted: true }]);
    expect(calls).toBe(0);
  });
});

const GRAPH_TOOLS = ["get_topic_brief", "get_tag_landscape", "search_posts_by_tag", "get_post"] as const;

function knowledgeSpec(order: string[]): ToolLoopSpec {
  return {
    description: "knowledge",
    parameters: z.object({ query: z.string() }),
    execute: async () => {
      order.push("search_knowledge");
      return { chunks: [{ source_url: "https://github.com/BitcoinErrorLog/pubky-knowledge-base/blob/main/Explore/Vibes/Vibes%20Portal.md" }] };
    },
  };
}

function graphSpec(name: string, order: string[]): ToolLoopSpec {
  return {
    description: name,
    parameters: z.object({}),
    execute: async () => {
      order.push(name);
      return { tool: name };
    },
  };
}

function route(allowGraphTools: boolean, query: string): KnowledgeFirstRoute {
  return {
    tool: "search_knowledge",
    args: { query },
    graphTools: GRAPH_TOOLS,
    allowGraphTools,
  };
}

describe("knowledge-first routing", () => {
  it("calls search_knowledge before a topic-brief and tag-landscape answer", async () => {
    const order: string[] = [];
    const offered: string[][] = [];
    const generate: ToolLoopGenerate = async ({ tools, messages }) => {
      offered.push(Object.keys(tools ?? {}));
      expect(JSON.stringify(messages)).toContain("search_knowledge");
      if (tools && "get_topic_brief" in tools) {
        await (tools.get_topic_brief as { execute: (args: unknown) => Promise<unknown> }).execute({});
        await (tools.get_tag_landscape as { execute: (args: unknown) => Promise<unknown> }).execute({});
        return {
          text: "",
          toolCalls: [
            { toolName: "get_topic_brief", args: { topic: "vibes" } },
            { toolName: "get_tag_landscape", args: { tag: "vibes" } },
          ],
          response: { messages: [{ role: "assistant", content: "" }] },
        };
      }
      return textResult("vibes-from-knowledge");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: {
        search_knowledge: knowledgeSpec(order),
        get_topic_brief: graphSpec("get_topic_brief", order),
        get_tag_landscape: graphSpec("get_tag_landscape", order),
        search_posts_by_tag: graphSpec("search_posts_by_tag", order),
        get_post: graphSpec("get_post", order),
      },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 2_000 },
      budgets: { answerBudgetMs: 30_000, toolMaxSteps: 4 },
      knowledgeTool: (name) => name === "search_knowledge",
      knowledgeFirst: route(false, "What vibes are on the vibes board?"),
    });
    const out = await loop.run({ prompt: "What vibes are on the vibes board?" });
    expect(order).toEqual(["search_knowledge"]);
    expect(out.text).toBe("vibes-from-knowledge");
    expect(out.toolTrace[0]).toEqual({
      toolCalls: [{ name: "search_knowledge", args: { query: "What vibes are on the vibes board?" } }],
    });
    expect(offered[0]).toContain("search_knowledge");
    expect(offered[0]).not.toContain("get_topic_brief");
    expect(offered[0]).not.toContain("get_tag_landscape");
  });

  it("calls search_knowledge before a tag-search and get_post answer", async () => {
    const order: string[] = [];
    const offered: string[][] = [];
    const generate: ToolLoopGenerate = async ({ tools }) => {
      offered.push(Object.keys(tools ?? {}));
      if (tools && "search_posts_by_tag" in tools) {
        await (tools.search_posts_by_tag as { execute: (args: unknown) => Promise<unknown> }).execute({});
        await (tools.get_post as { execute: (args: unknown) => Promise<unknown> }).execute({});
        return {
          text: "",
          toolCalls: [
            { toolName: "search_posts_by_tag", args: { tag: "vibes", limit: 10 } },
            { toolName: "get_post", args: { uri: "pubky://example" } },
          ],
          response: { messages: [{ role: "assistant", content: "" }] },
        };
      }
      return textResult("vibes-from-knowledge");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: {
        search_knowledge: knowledgeSpec(order),
        get_topic_brief: graphSpec("get_topic_brief", order),
        get_tag_landscape: graphSpec("get_tag_landscape", order),
        search_posts_by_tag: graphSpec("search_posts_by_tag", order),
        get_post: graphSpec("get_post", order),
      },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 2_000 },
      budgets: { answerBudgetMs: 30_000, toolMaxSteps: 4 },
      knowledgeFirst: route(false, "What vibes are on the vibes board?"),
    });
    const out = await loop.run({ prompt: "What vibes are on the vibes board?" });
    expect(order).toEqual(["search_knowledge"]);
    expect(out.text).toBe("vibes-from-knowledge");
    expect(offered[0]).not.toContain("search_posts_by_tag");
    expect(offered[0]).not.toContain("get_post");
  });

  it.each([
    "What is Pubky Passport and how does recovery work?",
    "What's new in pubky-app 1.11?",
    "What's the status of Paykit and Locks?",
    "What can I do on the Pubky Marketplace?",
  ])("calls search_knowledge before answering %s", async (question) => {
    const order: string[] = [];
    let sawKnowledge = false;
    const generate: ToolLoopGenerate = async ({ messages, tools }) => {
      sawKnowledge = JSON.stringify(messages).includes("search_knowledge");
      expect(tools && "get_post" in tools).toBe(false);
      return textResult("kept");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: {
        search_knowledge: knowledgeSpec(order),
        get_post: graphSpec("get_post", order),
      },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 2_000 },
      budgets: { answerBudgetMs: 30_000, toolMaxSteps: 2 },
      knowledgeFirst: route(false, question),
    });
    expect((await loop.run({ prompt: question })).text).toBe("kept");
    expect(order).toEqual(["search_knowledge"]);
    expect(sawKnowledge).toBe(true);
  });

  it("runs graph tools only after search_knowledge when the ask is explicit", async () => {
    const order: string[] = [];
    const question = "Who tagged posts about Paykit?";
    let step = 0;
    const generate: ToolLoopGenerate = async ({ tools }) => {
      step += 1;
      expect(tools && "search_posts_by_tag" in tools).toBe(true);
      expect(tools && "get_tag_landscape" in tools).toBe(true);
      if (step === 1) {
        const result = await (tools?.search_posts_by_tag as { execute: (args: unknown) => Promise<unknown> }).execute({});
        return {
          text: "",
          toolCalls: [{ toolName: "search_posts_by_tag", args: { tag: "paykit" } }],
          toolResults: [result],
          response: { messages: [{ role: "assistant", content: "" }, { role: "tool", content: JSON.stringify(result) }] },
        };
      }
      return textResult("tagged");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: {
        search_knowledge: knowledgeSpec(order),
        get_tag_landscape: graphSpec("get_tag_landscape", order),
        search_posts_by_tag: graphSpec("search_posts_by_tag", order),
        get_post: graphSpec("get_post", order),
      },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 2_000 },
      budgets: { answerBudgetMs: 30_000, toolMaxSteps: 3 },
      knowledgeFirst: route(true, question),
    });
    const out = await loop.run({ prompt: question });
    expect(order).toEqual(["search_knowledge", "search_posts_by_tag"]);
    expect(out.toolTrace[0]).toEqual({
      toolCalls: [{ name: "search_knowledge", args: { query: question } }],
    });
    expect(out.text).toBe("tagged");
  });

  it("screens the forced knowledge result and still runs the budget check first", async () => {
    const order: string[] = [];
    const flags: ScreenFlag[] = [];
    let modelCalls = 0;
    const generate: ToolLoopGenerate = async ({ messages }) => {
      modelCalls += 1;
      expect(JSON.stringify(messages)).toContain("screened-knowledge");
      return textResult("after-screen");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: {
        search_knowledge: {
          description: "knowledge",
          parameters: z.object({ query: z.string() }),
          execute: async () => {
            order.push("search_knowledge");
            return { secret: "raw-knowledge" };
          },
        },
      },
      screen: () => ({
        value: { secret: "screened-knowledge" },
        flags: [{ tool: "search_knowledge", path: "secret", patterns: ["raw"], truncated: false }],
      }),
      compose,
      timeouts: { modelTimeoutMs: 2_000 },
      budgets: { answerBudgetMs: 30_000, toolMaxSteps: 2 },
      knowledgeFirst: route(false, "What is Paykit?"),
    });
    const out = await loop.run({ prompt: "What is Paykit?" });
    flags.push(...out.screenFlags);
    expect(order).toEqual(["search_knowledge"]);
    expect(modelCalls).toBe(1);
    expect(flags).toEqual([{ tool: "search_knowledge", path: "secret", patterns: ["raw"], truncated: false }]);
    expect(out.text).toBe("after-screen");
  });

  it("does not call the model when the knowledge call hits the token budget", async () => {
    const order: string[] = [];
    let modelCalls = 0;
    const generate: ToolLoopGenerate = async () => {
      modelCalls += 1;
      return textResult("should-not-run");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: { search_knowledge: knowledgeSpec(order) },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 2_000 },
      budgets: { answerBudgetMs: 30_000, toolMaxSteps: 2 },
      beforeTool: async () => {
        throw new Error("token budget exceeded");
      },
      knowledgeFirst: route(false, "What is Paykit?"),
    });
    await expect(loop.run({ prompt: "What is Paykit?" })).rejects.toThrow("token budget exceeded");
    expect(order).toEqual([]);
    expect(modelCalls).toBe(0);
  });

  it("does not call the model when the generation switch blocks the knowledge call", async () => {
    let modelCalls = 0;
    const generate: ToolLoopGenerate = async () => {
      modelCalls += 1;
      return textResult("should-not-run");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: { search_knowledge: knowledgeSpec([]) },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 2_000 },
      budgets: { answerBudgetMs: 30_000, toolMaxSteps: 2 },
      beforeTool: async () => {
        throw new Error("generation switch on");
      },
      knowledgeFirst: route(true, "Who tagged posts about Paykit?"),
    });
    await expect(loop.run({ prompt: "Who tagged posts about Paykit?" })).rejects.toThrow("generation switch on");
    expect(modelCalls).toBe(0);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("knowledge-first answer budget boundary", () => {
  it.each([1, 400])("skips the forced call and the model when answerBudgetMs is %i", async (answerBudgetMs) => {
    const order: string[] = [];
    let beforeToolCalls = 0;
    let modelCalls = 0;
    const generate: ToolLoopGenerate = async () => {
      modelCalls += 1;
      return textResult("should-not-run");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: { search_knowledge: knowledgeSpec(order) },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 5_000 },
      budgets: { answerBudgetMs, toolMaxSteps: 4 },
      beforeTool: async () => {
        beforeToolCalls += 1;
      },
      knowledgeFirst: route(false, "What is Paykit?"),
    });
    const out = await loop.run({ prompt: "What is Paykit?" });
    expect(order).toEqual([]);
    expect(beforeToolCalls).toBe(0);
    expect(modelCalls).toBe(0);
    expect(out.outcome).toBe("budget");
    expect(out.budgetExhausted).toBe(true);
    expect(out.hasEvidence).toBe(false);
    expect(out.text).toBe("");
    expect(out.toolTrace).toEqual([{ budget_exhausted: true }]);
  });

  it("cancels a hanging forced search_knowledge at the answer deadline and never calls the model", async () => {
    const hang = deferred<unknown>();
    let started = 0;
    let screened = 0;
    let afterToolCalls = 0;
    let modelCalls = 0;
    const generate: ToolLoopGenerate = async () => {
      modelCalls += 1;
      return textResult("should-not-run");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: {
        search_knowledge: {
          description: "knowledge",
          parameters: z.object({ query: z.string() }),
          execute: async () => {
            started += 1;
            return hang.promise;
          },
        },
      },
      screen: (value) => {
        screened += 1;
        return { value, flags: [] };
      },
      compose,
      timeouts: { modelTimeoutMs: 5_000 },
      // reserve = 500 ms, so the forced call gets the remaining ~200 ms of answer time.
      budgets: { answerBudgetMs: 700, toolMaxSteps: 4 },
      afterTool: async () => {
        afterToolCalls += 1;
      },
      knowledgeTool: (name) => name === "search_knowledge",
      knowledgeFirst: route(false, "What is Paykit?"),
    });
    const t0 = Date.now();
    const out = await loop.run({ prompt: "What is Paykit?" });
    const elapsed = Date.now() - t0;
    expect(started).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(600);
    expect(modelCalls).toBe(0);
    expect(out.outcome).toBe("deadline");
    expect(out.budgetExhausted).toBe(true);
    expect(out.hasEvidence).toBe(false);
    expect(out.text).toBe("");
    expect(out.knowledgeMs).toBeGreaterThanOrEqual(150);

    hang.resolve({ chunks: [{ source_url: "https://late.example" }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screened).toBe(0);
    expect(afterToolCalls).toBe(0);
    expect(modelCalls).toBe(0);
  });

  it("bounds a hanging forced call by the per-step model timeout", async () => {
    let modelCalls = 0;
    const generate: ToolLoopGenerate = async () => {
      modelCalls += 1;
      return textResult("should-not-run");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: {
        search_knowledge: {
          description: "knowledge",
          parameters: z.object({ query: z.string() }),
          execute: () => new Promise<never>(() => {}),
        },
      },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 40 },
      budgets: { answerBudgetMs: 10_000, toolMaxSteps: 4 },
      knowledgeFirst: route(false, "What is Paykit?"),
    });
    const t0 = Date.now();
    const out = await loop.run({ prompt: "What is Paykit?" });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(out.outcome).toBe("deadline");
    expect(modelCalls).toBe(0);
  });

  it("bounds a hanging beforeTool check on the forced call", async () => {
    const order: string[] = [];
    let modelCalls = 0;
    const generate: ToolLoopGenerate = async () => {
      modelCalls += 1;
      return textResult("should-not-run");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: { search_knowledge: knowledgeSpec(order) },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 40 },
      budgets: { answerBudgetMs: 10_000, toolMaxSteps: 4 },
      beforeTool: () => new Promise<never>(() => {}),
      knowledgeFirst: route(false, "What is Paykit?"),
    });
    const out = await loop.run({ prompt: "What is Paykit?" });
    expect(out.outcome).toBe("deadline");
    expect(order).toEqual([]);
    expect(modelCalls).toBe(0);
  });

  it("propagates caller abort during a hanging forced call", async () => {
    let modelCalls = 0;
    const generate: ToolLoopGenerate = async () => {
      modelCalls += 1;
      return textResult("should-not-run");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: {
        search_knowledge: {
          description: "knowledge",
          parameters: z.object({ query: z.string() }),
          execute: () => new Promise<never>(() => {}),
        },
      },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 5_000 },
      budgets: { answerBudgetMs: 30_000, toolMaxSteps: 4 },
      knowledgeFirst: route(false, "What is Paykit?"),
    });
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 30);
    const t0 = Date.now();
    await expect(loop.run({ prompt: "What is Paykit?", abortSignal: caller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(Date.now() - t0).toBeLessThan(400);
    expect(modelCalls).toBe(0);
  });

  it("counts the forced call as one of toolMaxSteps", async () => {
    const order: string[] = [];
    const offered: Array<string[] | undefined> = [];
    const generate: ToolLoopGenerate = async ({ tools }) => {
      offered.push(tools ? Object.keys(tools) : undefined);
      return textResult("composed");
    };
    const loop = createToolLoop({
      model: { generate, temperature: 1 },
      tools: { search_knowledge: knowledgeSpec(order) },
      screen: passthroughScreen,
      compose,
      timeouts: { modelTimeoutMs: 2_000 },
      budgets: { answerBudgetMs: 30_000, toolMaxSteps: 1 },
      knowledgeFirst: route(false, "What is Paykit?"),
    });
    const out = await loop.run({ prompt: "What is Paykit?" });
    expect(order).toEqual(["search_knowledge"]);
    expect(offered).toEqual([undefined]);
    expect(out.text).toBe("composed");
    expect(out.hasEvidence).toBe(true);
  });
});
