import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeOpenAI } from "../../../../tests/fake-openai.js";
import { createToolLoop, type ToolLoopGenerate } from "../answer/tool-loop.js";
import { createBrain } from "./create.js";
import { BrainEgressError } from "./egress.js";
import { createHostedMoonshotBrain } from "./moonshot.js";
import { createOllamaBrain } from "./ollama.js";
import { createGuardedBrainFetch, createOpenAICompatibleBrain } from "./openai-compatible.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Brain } from "./types.js";

const passthroughScreen = (value: unknown) => ({ value, flags: [] });

describe("Brain interface", () => {
  it("advertises capabilities and is a ToolLoopModel", () => {
    const brain = createOpenAICompatibleBrain({
      model: "test-model",
      apiKey: "sk-test",
      baseUrl: "http://127.0.0.1:9/v1",
      temperature: 0.4,
    });
    expect(brain.capabilities).toEqual({
      name: "test-model",
      providerId: "openai-compatible",
      supportsTools: true,
      maxContextTokens: 128_000,
      samplingDefaults: { temperature: 0.4 },
    });
    expect(typeof brain.generate).toBe("function");
    expect(brain.temperature).toBe(0.4);
    expect(brain).not.toHaveProperty("loadThread");
    expect(brain).not.toHaveProperty("saveThread");
    expect(brain).not.toHaveProperty("remember");
  });

  it("surfaces generate errors and does not invoke another brain", async () => {
    const fake = await startFakeOpenAI({
      handler: () => ({ status: 500, json: {} }),
    });
    const secondCalls = { n: 0 };
    const second: Brain = {
      capabilities: {
        name: "other",
        providerId: "other",
        supportsTools: true,
        maxContextTokens: 1,
        samplingDefaults: { temperature: 1 },
      },
      temperature: 1,
      generate: (async () => {
        secondCalls.n += 1;
        return { text: "fallback", usage: { totalTokens: 1 }, response: { messages: [] } };
      }) as ToolLoopGenerate,
    };
    try {
      const first = createOpenAICompatibleBrain({
        model: "kimi-k3",
        apiKey: "sk-test",
        baseUrl: fake.url,
        temperature: 1,
      });
      await expect(
        first.generate({
          messages: [{ role: "user", content: "hi" }],
          temperature: 1,
          abortSignal: new AbortController().signal,
        }),
      ).rejects.toThrow();
      expect(secondCalls.n).toBe(0);
      expect(second.capabilities.providerId).toBe("other");
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("createBrain rejects unknown ids instead of substituting", () => {
    expect(() =>
      createBrain({ id: "anthropic" as never, model: "x", apiKey: "k", baseUrl: "http://127.0.0.1:9/v1" }),
    ).toThrow(/unknown brain/);
  });
});

describe("openai-compatible adapter", () => {
  let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
  beforeAll(async () => {
    fake = await startFakeOpenAI();
  });
  afterAll(async () => {
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("posts to the given base URL with temperature and returns text", async () => {
    const brain = createOpenAICompatibleBrain({
      model: "gpt-4o-mini",
      apiKey: "sk-test",
      baseUrl: fake.url,
      temperature: 0.2,
    });
    const out = await brain.generate({
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
      abortSignal: new AbortController().signal,
    });
    expect(out.text).toBe("fake-answer");
    expect(fake.bodies.at(-1)?.temperature).toBe(0.2);
    expect(fake.bodies.at(-1)?.model).toBe("gpt-4o-mini");
  });

  it("feeds the existing tool loop", async () => {
    const brain = createOpenAICompatibleBrain({
      model: "gpt-4o-mini",
      apiKey: "sk-test",
      baseUrl: fake.url,
      temperature: 1,
    });
    const loop = createToolLoop({
      model: brain,
      tools: {},
      screen: passthroughScreen,
      compose: { fromEvidencePrompt: "compose", deterministicText: "det" },
      timeouts: { modelTimeoutMs: 5_000 },
      budgets: { answerBudgetMs: 10_000, toolMaxSteps: 1 },
    });
    const result = await loop.run({ prompt: "hello" });
    expect(result.text).toBe("fake-answer");
    expect(result.outcome).toBe("complete");
  });

  it("requires base URL and API key", () => {
    expect(() => createOpenAICompatibleBrain({ model: "m", apiKey: "k" })).toThrow(/base URL/);
    expect(() =>
      createOpenAICompatibleBrain({ model: "m", apiKey: "", baseUrl: "http://127.0.0.1:9/v1" }),
    ).toThrow(/API key/);
  });
});

describe("hosted-moonshot adapter", () => {
  it("defaults provider id, temperature 1, and Moonshot base URL", () => {
    const brain = createHostedMoonshotBrain({ model: "kimi-k3", apiKey: "sk-test" });
    expect(brain.capabilities.providerId).toBe("moonshot");
    expect(brain.capabilities.name).toBe("kimi-k3");
    expect(brain.capabilities.supportsTools).toBe(true);
    expect(brain.temperature).toBe(1);
    expect(brain.capabilities.samplingDefaults.temperature).toBe(1);
    expect(brain.capabilities.maxContextTokens).toBe(256_000);
  });

  it("uses a caller base URL when provided (loopback tests)", async () => {
    const fake = await startFakeOpenAI();
    try {
      const brain = createHostedMoonshotBrain({
        model: "kimi-k3",
        apiKey: "sk-test",
        baseUrl: fake.url,
        temperature: 1,
      });
      const out = await brain.generate({
        messages: [{ role: "user", content: "hi" }],
        temperature: 1,
        abortSignal: new AbortController().signal,
      });
      expect(out.text).toBe("fake-answer");
      expect(fake.bodies.at(-1)?.temperature).toBe(1);
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });

  it("injects Moonshot provider options into the request body", async () => {
    const fake = await startFakeOpenAI();
    try {
      const brain = createHostedMoonshotBrain({
        model: "kimi-k3",
        apiKey: "sk-test",
        baseUrl: fake.url,
      });
      await brain.generate({
        messages: [{ role: "user", content: "hi" }],
        temperature: 1,
        abortSignal: new AbortController().signal,
        providerOptions: { moonshot: { thinking: { type: "disabled" } } },
      });
      expect(fake.bodies.at(-1)?.thinking).toEqual({ type: "disabled" });
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });
});

describe("ollama adapter", () => {
  it("defaults to loopback OpenAI-compatible URL and dummy key", () => {
    const brain = createOllamaBrain({ model: "qwen2.5:7b" });
    expect(brain.capabilities.providerId).toBe("ollama");
    expect(brain.capabilities.supportsTools).toBe(true);
    expect(brain.capabilities.maxContextTokens).toBe(32_768);
    expect(brain.temperature).toBe(0.7);
  });

  it("talks to a mocked OpenAI-compatible server and fills missing usage", async () => {
    const fake = await startFakeOpenAI();
    try {
      const brain = createOllamaBrain({
        model: "qwen2.5:7b",
        baseUrl: fake.url,
        temperature: 0.3,
      });
      const out = await brain.generate({
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.3,
        abortSignal: new AbortController().signal,
      });
      expect(out.text).toBe("fake-answer");
      expect(out.usage).toBeDefined();
      expect(fake.bodies.at(-1)?.temperature).toBe(0.3);
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
    }
  });
});

describe("brain egress allowlist", () => {
  it("allows api.moonshot.ai and loopback", () => {
    expect(() =>
      createHostedMoonshotBrain({ model: "kimi-k3", apiKey: "sk-test" }),
    ).not.toThrow();
    expect(() =>
      createOpenAICompatibleBrain({
        model: "m",
        apiKey: "k",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).not.toThrow();
    expect(() =>
      createOpenAICompatibleBrain({
        model: "m",
        apiKey: "k",
        baseUrl: "http://localhost:9/v1",
      }),
    ).not.toThrow();
  });

  it("refuses a non-allowlisted host", () => {
    expect(() =>
      createHostedMoonshotBrain({
        model: "kimi-k3",
        apiKey: "sk-test",
        baseUrl: "https://api.openai.com/v1",
      }),
    ).toThrow(BrainEgressError);
    expect(() =>
      createOpenAICompatibleBrain({
        model: "m",
        apiKey: "k",
        baseUrl: "https://api.groq.com/openai/v1",
      }),
    ).toThrow(/brain egress refused/);
  });

  it("refuses a 302 redirect so the API key never leaves the first hop", async () => {
    const sent: Array<{ url: string; auth: string | null; redirect?: RequestRedirect }> = [];
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      sent.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
        redirect: init?.redirect,
      });
      return new Response(null, { status: 302, headers: { Location: "https://evil.example/steal" } });
    };
    const brain = createOpenAICompatibleBrain({
      model: "kimi-k3",
      apiKey: "sk-secret-key-never-leave",
      baseUrl: "http://127.0.0.1:9/v1",
      fetchImpl: mockFetch,
    });
    await expect(
      brain.generate({
        messages: [{ role: "user", content: "hi" }],
        temperature: 1,
        abortSignal: new AbortController().signal,
      }),
    ).rejects.toThrow(/redirect|egress/i);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((row) => !row.url.includes("evil.example"))).toBe(true);
    expect(sent.every((row) => row.redirect === "error")).toBe(true);
    expect(sent.some((row) => row.auth?.includes("sk-secret-key-never-leave"))).toBe(true);
  });

  it("createGuardedBrainFetch errors on 302 and does not follow", async () => {
    let followed = false;
    const guarded = createGuardedBrainFetch({
      fetchImpl: async (_input, init) => {
        if (init?.redirect === "follow") followed = true;
        return new Response(null, { status: 302, headers: { Location: "https://evil.example/" } });
      },
    });
    await expect(guarded("http://127.0.0.1:9/v1/chat/completions", { headers: { Authorization: "Bearer k" } })).rejects.toThrow(
      /redirect/,
    );
    expect(followed).toBe(false);
  });

  it("no other brain adapter uses global fetch or generateText", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const name of ["create.ts", "moonshot.ts", "ollama.ts", "egress.ts", "index.ts"]) {
      const src = readFileSync(join(here, name), "utf8");
      expect(src, name).not.toMatch(/\bfetch\s*\(/);
      expect(src, name).not.toMatch(/generateText/);
    }
  });

  it("allows a non-allowlisted host only with the dangerous override", () => {
    const brain = createOpenAICompatibleBrain({
      model: "m",
      apiKey: "k",
      baseUrl: "https://api.openai.com/v1",
      egressDangerous: true,
    });
    expect(brain.capabilities.providerId).toBe("openai-compatible");
  });
});
