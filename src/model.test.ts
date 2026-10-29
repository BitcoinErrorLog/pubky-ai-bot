import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { completionJson, startFakeOpenAI } from "../tests/fake-openai.js";
import { configFromProcessEnv, type Config } from "./config.js";
import { modelRouteStats } from "./bot-kit/brain/index.js";
import {
  activeModelFallback,
  completeReply,
  createJebBrain,
  jebModelRouting,
  modelStepTimeoutMs,
  modelTemperature,
} from "./model.js";

describe("model temperature", () => {
  let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
  beforeAll(async () => {
    fake = await startFakeOpenAI();
  });
  afterAll(async () => {
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  function cfgWith(temperature: number | undefined): Config {
    return {
      modelApiKey: "sk-test",
      modelBaseUrl: fake.url,
      model: "kimi-k3",
      modelTimeoutMs: 5000,
      modelTemperature: temperature,
    } as Config;
  }

  it("generateText passes the configured temperature through", async () => {
    const out = await completeReply(cfgWith(0.4), "hi");
    expect(out.text).toBe("fake-answer");
    expect(fake.bodies.at(-1)?.temperature).toBe(0.4);
  });

  it("generateText defaults temperature to 1 when unset (never SDK default)", async () => {
    await completeReply(cfgWith(undefined), "hi");
    expect(fake.bodies.at(-1)?.temperature).toBe(1);
  });

  it("generateObject passes the configured temperature through", async () => {
    const cfg = cfgWith(1);
    const openai = createOpenAI({ apiKey: cfg.modelApiKey, baseURL: cfg.modelBaseUrl });
    const out = await generateObject({
      model: openai(cfg.model),
      schema: z.object({ ok: z.boolean() }),
      prompt: "hi",
      temperature: modelTemperature(cfg),
      mode: "json",
    });
    expect(out.object.ok).toBe(true);
    expect(fake.bodies.at(-1)?.temperature).toBe(1);
  });

  it("createJebBrain defaults to moonshot and uses the fake loopback URL", () => {
    const brain = createJebBrain(cfgWith(1));
    expect(brain.capabilities.providerId).toBe("moonshot");
    expect(brain.capabilities.supportsImages).toBe(true);
    expect(brain.temperature).toBe(1);
  });

  it("createJebBrain selects ollama without requiring a real API key", () => {
    const brain = createJebBrain({
      brain: "ollama",
      model: "qwen2.5:7b",
      modelApiKey: undefined,
      modelBaseUrl: fake.url,
      modelTemperature: 0.7,
      brainEgressDangerous: false,
    } as Config);
    expect(brain.capabilities.providerId).toBe("ollama");
    expect(brain.capabilities.supportsImages).toBe(false);
  });

  it("config parses JEB_MODEL_TEMPERATURE (0..2, optional)", () => {
    const prev = process.env.JEB_MODEL_TEMPERATURE;
    const prevDb = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = "postgres://johncarvalho@127.0.0.1:5432/jeb_vitest";
      delete process.env.JEB_MODEL_BASE_URL;
      delete process.env.JEB_BRAIN;
      process.env.JEB_MODEL_TEMPERATURE = "0.4";
      expect(configFromProcessEnv({ requireSecret: false }).modelTemperature).toBe(0.4);
      delete process.env.JEB_MODEL_TEMPERATURE;
      expect(configFromProcessEnv({ requireSecret: false }).modelTemperature).toBeUndefined();
      process.env.JEB_MODEL_TEMPERATURE = "3";
      expect(() => configFromProcessEnv({ requireSecret: false })).toThrow(/invalid config/);
    } finally {
      if (prev === undefined) delete process.env.JEB_MODEL_TEMPERATURE;
      else process.env.JEB_MODEL_TEMPERATURE = prev;
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
    }
  });
});

describe("Jeb model fallback", () => {
  const OVERLOADED = { error: { message: "engine overloaded", type: "engine_overloaded_error" } };
  let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
  let primaryStatus = 429;
  beforeAll(async () => {
    fake = await startFakeOpenAI({
      handler: (_n, body) =>
        body.model === "kimi-k3.1-pro"
          ? primaryStatus === 200
            ? { json: completionJson("from-3.1-pro") }
            : primaryStatus === 401
              ? { status: 401, json: { error: { message: "bad key", type: "invalid_authentication_error" } } }
              : { status: primaryStatus, json: OVERLOADED }
          : { json: completionJson("from-k3") },
    });
  });
  afterAll(async () => {
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  const cfg = (extra: Record<string, unknown> = {}): Config =>
    ({
      modelApiKey: "sk-test",
      modelBaseUrl: fake.url,
      model: "kimi-k3.1-pro",
      modelFallback: "kimi-k3",
      modelTimeoutMs: 5000,
      modelMaxOutputTokens: 256,
      ...extra,
    }) as Config;

  it("completeReply answers from the fallback model while the primary is overloaded", async () => {
    primaryStatus = 429;
    const before = fake.bodies.length;
    const out = await completeReply(cfg(), "hi");
    expect(out.text).toBe("from-k3");
    expect(fake.bodies.slice(before).map((b) => b.model)).toEqual(["kimi-k3.1-pro", "kimi-k3"]);
    expect(modelRouteStats.snapshot().lastAnsweredModel).toBe("kimi-k3");
    expect(modelRouteStats.snapshot().lastAnsweredRole).toBe("fallback");
  });

  it("completeReply stays on the primary when it is healthy", async () => {
    primaryStatus = 200;
    const before = fake.bodies.length;
    const out = await completeReply(cfg(), "hi");
    expect(out.text).toBe("from-3.1-pro");
    expect(fake.bodies.slice(before).map((b) => b.model)).toEqual(["kimi-k3.1-pro"]);
  });

  it("completeReply surfaces a 401 without calling the fallback", async () => {
    primaryStatus = 401;
    const before = fake.bodies.length;
    await expect(completeReply(cfg(), "hi")).rejects.toThrow();
    expect(fake.bodies.slice(before).map((b) => b.model)).toEqual(["kimi-k3.1-pro"]);
  });

  it("without JEB_MODEL_FALLBACK a 429 is not retried", async () => {
    primaryStatus = 429;
    const before = fake.bodies.length;
    await expect(completeReply(cfg({ modelFallback: undefined }), "hi")).rejects.toThrow();
    expect(fake.bodies.length - before).toBe(1);
  });

  it("ignores a fallback equal to the primary", () => {
    expect(activeModelFallback({ model: "kimi-k3", modelFallback: "kimi-k3" })).toBeUndefined();
    expect(activeModelFallback({ model: "kimi-k3.1-pro", modelFallback: "kimi-k3" })).toBe("kimi-k3");
  });

  it("gives the step budget the first-response window only when a fallback is active", () => {
    expect(modelStepTimeoutMs({ model: "a", modelFallback: "b", modelFallbackAfterMs: 60_000, modelTimeoutMs: 30_000 })).toBe(90_000);
    expect(modelStepTimeoutMs({ model: "a", modelFallback: undefined, modelFallbackAfterMs: 60_000, modelTimeoutMs: 30_000 })).toBe(30_000);
    expect(modelStepTimeoutMs({ model: "a", modelFallback: "a", modelFallbackAfterMs: 60_000, modelTimeoutMs: 30_000 })).toBe(30_000);
  });

  it("reports configured routing for /healthz without any secret", () => {
    const routing = jebModelRouting(cfg());
    expect(routing).toMatchObject({ primary: "kimi-k3.1-pro", fallback: "kimi-k3", fallbackAfterMs: 60_000 });
    expect(JSON.stringify(routing)).not.toContain("sk-test");
  });
});
