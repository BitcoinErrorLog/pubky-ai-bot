import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createToolLoop,
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
