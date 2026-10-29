import { afterEach, describe, expect, it } from "vitest";
import { completionJson, startFakeOpenAI, type FakeOpenAIHandler } from "../../../../tests/fake-openai.js";
import { createHostedMoonshotBrain } from "./moonshot.js";
import {
  classifyFallbackError,
  ModelRouteStats,
  withModelFallback,
  type ModelFallbackEvent,
} from "./fallback.js";
import type { Brain } from "./types.js";

const PRIMARY = "kimi-k3.1-pro";
const FALLBACK = "kimi-k3";
const OVERLOADED = { error: { message: "The engine is currently overloaded, please try again later", type: "engine_overloaded_error" } };

type Fake = Awaited<ReturnType<typeof startFakeOpenAI>>;
const open: Fake[] = [];

async function setup(handler: FakeOpenAIHandler, primaryTimeoutMs?: number) {
  const fake = await startFakeOpenAI({ handler });
  open.push(fake);
  const make = (model: string): Brain =>
    createHostedMoonshotBrain({ model, apiKey: "sk-test", baseUrl: fake.url, temperature: 1 });
  const events: ModelFallbackEvent[] = [];
  const stats = new ModelRouteStats();
  const brain = withModelFallback(make(PRIMARY), make(FALLBACK), {
    primaryTimeoutMs,
    stats,
    onEvent: (e) => events.push(e),
  });
  const generate = (signal: AbortSignal = new AbortController().signal) =>
    brain.generate({ messages: [{ role: "user", content: "hi" }], temperature: 1, abortSignal: signal });
  return { fake, brain, events, stats, generate };
}

const modelsCalled = (fake: Fake) => fake.bodies.map((b) => b.model);

afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => new Promise<void>((r) => f.server.close(() => r()))));
});

describe("withModelFallback", () => {
  it("answers from the fallback when the primary returns 429 engine_overloaded_error", async () => {
    const { fake, events, stats, generate } = await setup((_n, body) =>
      body.model === PRIMARY ? { status: 429, json: OVERLOADED } : { json: completionJson("from-fallback") },
    );
    const out = await generate();
    expect(out.text).toBe("from-fallback");
    expect(modelsCalled(fake)).toEqual([PRIMARY, FALLBACK]);
    expect(events).toContainEqual({ kind: "fallback", from: PRIMARY, to: FALLBACK, reason: "overloaded", status: 429 });
    expect(events.at(-1)).toEqual({ kind: "answered", model: FALLBACK, role: "fallback" });
    const snap = stats.snapshot();
    expect(snap.lastAnsweredModel).toBe(FALLBACK);
    expect(snap.lastAnsweredRole).toBe("fallback");
    expect(snap.fallbackCount).toBe(1);
    expect(snap.answeredByModel).toEqual({ [FALLBACK]: 1 });
    expect(snap.lastFallback).toMatchObject({ from: PRIMARY, to: FALLBACK, reason: "overloaded", status: 429 });
  });

  it("sends the same request, with the same key, to the fallback", async () => {
    const { fake, generate } = await setup((_n, body) =>
      body.model === PRIMARY ? { status: 429, json: OVERLOADED } : { json: completionJson("ok") },
    );
    await generate();
    const [first, second] = fake.bodies;
    expect({ ...second, model: undefined }).toEqual({ ...first, model: undefined });
  });

  it("answers from the primary without touching the fallback when it succeeds", async () => {
    const { fake, events, stats, generate } = await setup(() => ({ json: completionJson("from-primary") }));
    expect((await generate()).text).toBe("from-primary");
    expect(modelsCalled(fake)).toEqual([PRIMARY]);
    expect(events).toEqual([{ kind: "answered", model: PRIMARY, role: "primary" }]);
    expect(stats.snapshot().fallbackCount).toBe(0);
  });

  it("falls back on a 5xx", async () => {
    const { fake, generate } = await setup((_n, body) =>
      body.model === PRIMARY ? { status: 503, json: {} } : { json: completionJson("after-5xx") },
    );
    expect((await generate()).text).toBe("after-5xx");
    expect(modelsCalled(fake)).toEqual([PRIMARY, FALLBACK]);
  });

  it("falls back when the primary gives no response within the timeout", async () => {
    const { fake, events, generate } = await setup(
      (_n, body) => (body.model === PRIMARY ? { hang: true } : { json: completionJson("after-hang") }),
      150,
    );
    const started = Date.now();
    expect((await generate()).text).toBe("after-hang");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(modelsCalled(fake)).toEqual([PRIMARY, FALLBACK]);
    expect(events).toContainEqual({ kind: "fallback", from: PRIMARY, to: FALLBACK, reason: "timeout", status: undefined });
  });

  it("does not retry a 401 auth error", async () => {
    const { fake, events, generate } = await setup(() => ({
      status: 401,
      json: { error: { message: "invalid api key", type: "invalid_authentication_error" } },
    }));
    await expect(generate()).rejects.toThrow();
    expect(modelsCalled(fake)).toEqual([PRIMARY]);
    expect(events.some((e) => e.kind === "fallback")).toBe(false);
  });

  it("does not retry a 400 request error", async () => {
    const { fake, generate } = await setup(() => ({ status: 400, json: { error: { message: "bad", type: "invalid_request_error" } } }));
    await expect(generate()).rejects.toThrow();
    expect(modelsCalled(fake)).toEqual([PRIMARY]);
  });

  it("surfaces the fallback error when both models fail, after exactly one retry", async () => {
    const { fake, events, stats, generate } = await setup(() => ({ status: 429, json: OVERLOADED }));
    await expect(generate()).rejects.toThrow();
    expect(modelsCalled(fake)).toEqual([PRIMARY, FALLBACK]);
    expect(events.at(-1)).toEqual({ kind: "failed", model: FALLBACK, role: "fallback" });
    expect(stats.snapshot().fallbackFailedCount).toBe(1);
  });

  it("does not retry when the caller aborted", async () => {
    const { fake, generate } = await setup(() => ({ hang: true }));
    const ac = new AbortController();
    const pending = generate(ac.signal);
    setTimeout(() => ac.abort(), 50);
    await expect(pending).rejects.toThrow();
    expect(modelsCalled(fake)).toEqual([PRIMARY]);
  });

  it("has no fallback behaviour when no fallback brain is supplied", async () => {
    const fake = await startFakeOpenAI({ handler: () => ({ status: 429, json: OVERLOADED }) });
    open.push(fake);
    const primary = createHostedMoonshotBrain({ model: PRIMARY, apiKey: "sk-test", baseUrl: fake.url });
    const brain = withModelFallback(primary, null, { stats: new ModelRouteStats() });
    await expect(
      brain.generate({ messages: [{ role: "user", content: "hi" }], temperature: 1, abortSignal: new AbortController().signal }),
    ).rejects.toThrow();
    expect(fake.calls.n).toBe(1);
  });
});

describe("classifyFallbackError", () => {
  const api = (statusCode: number, responseBody = "") => Object.assign(new Error("api"), { statusCode, responseBody });
  it("retries 429, 408, 5xx, timeouts and network errors", () => {
    expect(classifyFallbackError(api(429), { primaryTimedOut: false })).toEqual({ reason: "rate_limited", status: 429 });
    expect(classifyFallbackError(api(429, '{"type":"engine_overloaded_error"}'), { primaryTimedOut: false })).toEqual({
      reason: "overloaded",
      status: 429,
    });
    expect(classifyFallbackError(api(408), { primaryTimedOut: false })?.reason).toBe("timeout");
    expect(classifyFallbackError(api(502), { primaryTimedOut: false })?.reason).toBe("server_error");
    expect(classifyFallbackError(new Error("x"), { primaryTimedOut: true })?.reason).toBe("timeout");
    expect(classifyFallbackError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }), { primaryTimedOut: false })?.reason).toBe(
      "network",
    );
  });
  it("never retries other 4xx or unknown errors", () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      expect(classifyFallbackError(api(status), { primaryTimedOut: false })).toBeNull();
    }
    expect(classifyFallbackError(new Error("brain egress refused"), { primaryTimedOut: false })).toBeNull();
  });
});
