import { afterEach, describe, expect, it } from "vitest";
import { completionJson, startFakeOpenAI } from "../../tests/fake-openai.js";
import { modelRouteSnapshot } from "../bot-kit/brain/fallback.js";
import {
  createPubchiDeploymentBrain,
  DEFAULT_FALLBACK_AFTER_MS,
  PHASE0_BRAIN_FALLBACK,
  pubchiFallbackAfterMs,
  pubchiFallbackModelId,
} from "./brain-fallback.js";
import { handlePubchiRequest } from "./http.js";
import { baseListenOpts } from "./test-helpers.js";

const PRIMARY = "kimi-k3.1-pro";
const open: Array<Awaited<ReturnType<typeof startFakeOpenAI>>> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => new Promise<void>((r) => f.server.close(() => r()))));
});

describe("pubchiFallbackModelId", () => {
  it("defaults the hosted Moonshot brain to the pinned fallback_model_id", () => {
    expect(PHASE0_BRAIN_FALLBACK.fallback_model_id).toBe("kimi-k3");
    expect(pubchiFallbackModelId({ brain: "moonshot", primary: PRIMARY, env: {} })).toBe("kimi-k3");
  });
  it("is absent when it equals the primary (today's kimi-k3 pin)", () => {
    expect(pubchiFallbackModelId({ brain: "moonshot", primary: "kimi-k3", env: {} })).toBeUndefined();
  });
  it("honours PUBCHI_MODEL_FALLBACK, including off", () => {
    expect(pubchiFallbackModelId({ brain: "moonshot", primary: PRIMARY, env: { PUBCHI_MODEL_FALLBACK: "kimi-k2" } })).toBe("kimi-k2");
    expect(pubchiFallbackModelId({ brain: "moonshot", primary: PRIMARY, env: { PUBCHI_MODEL_FALLBACK: "off" } })).toBeUndefined();
  });
  it("never applies the Moonshot default to another provider", () => {
    expect(pubchiFallbackModelId({ brain: "ollama", primary: "qwen2.5:7b", env: {} })).toBeUndefined();
  });
});

describe("pubchiFallbackAfterMs", () => {
  it("defaults to half the 30 s wall clock and never exceeds it", () => {
    expect(DEFAULT_FALLBACK_AFTER_MS).toBe(15_000);
    expect(pubchiFallbackAfterMs({})).toBe(15_000);
    expect(pubchiFallbackAfterMs({ PUBCHI_MODEL_FALLBACK_AFTER_MS: "5000" })).toBe(5_000);
    expect(pubchiFallbackAfterMs({ PUBCHI_MODEL_FALLBACK_AFTER_MS: "60000" })).toBe(15_000);
    expect(pubchiFallbackAfterMs({ PUBCHI_MODEL_FALLBACK_AFTER_MS: "nope" })).toBe(15_000);
  });
});

describe("Pubchi deployment brain fallback", () => {
  it("answers from the fallback when the pinned model returns 429 overloaded, and /healthz reports it", async () => {
    const fake = await startFakeOpenAI({
      handler: (_n, body) =>
        body.model === PRIMARY
          ? { status: 429, json: { error: { message: "overloaded", type: "engine_overloaded_error" } } }
          : { json: completionJson("pubchi-fallback-answer") },
    });
    open.push(fake);
    const brain = createPubchiDeploymentBrain({ id: "moonshot", model: PRIMARY, apiKey: "sk-test", baseUrl: fake.url, env: {} });
    const out = await brain.generate({
      messages: [{ role: "user", content: "hi" }],
      temperature: 1,
      abortSignal: new AbortController().signal,
    });
    expect(out.text).toBe("pubchi-fallback-answer");
    expect(fake.bodies.map((b) => b.model)).toEqual([PRIMARY, "kimi-k3"]);

    const health = await handlePubchiRequest("GET", "/healthz", "", baseListenOpts({ modelRouting: modelRouteSnapshot }));
    expect(health.status).toBe(200);
    expect((health.body as { model_routing: { primary: string; fallback: string; lastAnsweredModel: string; fallbackCount: number } }).model_routing).toMatchObject({
      primary: PRIMARY,
      fallback: "kimi-k3",
      lastAnsweredModel: "kimi-k3",
      fallbackCount: 1,
    });
    expect(JSON.stringify(health.body)).not.toContain("sk-test");
  });

  it("does not retry a 401", async () => {
    const fake = await startFakeOpenAI({ handler: () => ({ status: 401, json: { error: { message: "bad key", type: "invalid_authentication_error" } } }) });
    open.push(fake);
    const brain = createPubchiDeploymentBrain({ id: "moonshot", model: PRIMARY, apiKey: "sk-test", baseUrl: fake.url, env: {} });
    await expect(
      brain.generate({ messages: [{ role: "user", content: "hi" }], temperature: 1, abortSignal: new AbortController().signal }),
    ).rejects.toThrow();
    expect(fake.calls.n).toBe(1);
  });
});
