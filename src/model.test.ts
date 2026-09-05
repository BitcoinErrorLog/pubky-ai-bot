import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startFakeOpenAI } from "../tests/fake-openai.js";
import { configFromProcessEnv, type Config } from "./config.js";
import { completeReply, createJebBrain, modelTemperature } from "./model.js";

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
  });

  it("config parses JEB_MODEL_TEMPERATURE (0..2, optional)", () => {
    const prev = process.env.JEB_MODEL_TEMPERATURE;
    try {
      process.env.JEB_MODEL_TEMPERATURE = "0.4";
      expect(configFromProcessEnv({ requireSecret: false }).modelTemperature).toBe(0.4);
      delete process.env.JEB_MODEL_TEMPERATURE;
      expect(configFromProcessEnv({ requireSecret: false }).modelTemperature).toBeUndefined();
      process.env.JEB_MODEL_TEMPERATURE = "3";
      expect(() => configFromProcessEnv({ requireSecret: false })).toThrow(/invalid config/);
    } finally {
      if (prev === undefined) delete process.env.JEB_MODEL_TEMPERATURE;
      else process.env.JEB_MODEL_TEMPERATURE = prev;
    }
  });
});
