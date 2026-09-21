import { afterEach, describe, expect, it } from "vitest";
import {
  PHASE0_BRAIN,
  parseBrainRefV1,
  parsePubchiConfigV1,
  type BrainRefV1,
} from "../pubchi-schemas/index.js";
import { startFakeOpenAI } from "../../tests/fake-openai.js";
import {
  BRAIN_ENDPOINT_MAX_BYTES,
  createPubchiBrainServe,
  servePubchiBrain,
  validateServedBrainRef,
} from "./brain-serve.js";
import { countingBrain, loadFixture, testTenant } from "./test-helpers.js";

const hosted: BrainRefV1 = { ...PHASE0_BRAIN };
const ollamaLoopback: BrainRefV1 = {
  adapter: "vercel-ai",
  execution: "self-hosted",
  provider_id: "ollama",
  model_id: "qwen2.5:7b",
  endpoint: "http://127.0.0.1:11434/v1",
};

function openaiLoopback(endpoint: string): BrainRefV1 {
  return {
    adapter: "vercel-ai",
    execution: "self-hosted",
    provider_id: "openai-compatible",
    model_id: "local-model",
    endpoint,
  };
}

describe("brain descriptor validation", () => {
  it("accepts synonym-hosted moonshot and loopback self-hosted ollama", () => {
    expect(validateServedBrainRef(hosted)).toMatchObject({ ok: true });
    expect(validateServedBrainRef(ollamaLoopback)).toMatchObject({ ok: true });
    expect(parseBrainRefV1(hosted)).toMatchObject({ ok: true });
    expect(parseBrainRefV1(ollamaLoopback)).toMatchObject({ ok: true });
  });

  it("rejects execution/provider pairing", () => {
    expect(parseBrainRefV1({ ...hosted, execution: "self-hosted", endpoint: "http://127.0.0.1:9/v1" })).toEqual({
      ok: false,
      code: "BRAIN_FORBIDDEN",
    });
    expect(parseBrainRefV1({ ...hosted, provider_id: "openai-compatible" })).toEqual({
      ok: false,
      code: "BRAIN_FORBIDDEN",
    });
    expect(validateServedBrainRef({ ...hosted, execution: "self-hosted", endpoint: "http://127.0.0.1:9/v1", provider_id: "moonshot" })).toMatchObject({
      ok: false,
      code: "BRAIN_FORBIDDEN",
    });
  });

  it("rejects credentials, query strings, non-https remote hosts, and oversized endpoints", () => {
    expect(validateServedBrainRef(openaiLoopback("https://user:pass@127.0.0.1/v1"))).toMatchObject({
      ok: false,
      code: "BRAIN_FORBIDDEN",
      cause: "brain_endpoint_credentials",
    });
    expect(validateServedBrainRef(openaiLoopback("http://127.0.0.1:9/v1?api_key=x"))).toMatchObject({
      ok: false,
      code: "BRAIN_FORBIDDEN",
      cause: "brain_endpoint_credentials",
    });
    expect(validateServedBrainRef(openaiLoopback("http://example.com/v1"))).toMatchObject({
      ok: false,
      code: "BRAIN_FORBIDDEN",
    });
    expect(validateServedBrainRef(openaiLoopback("https://api.openai.com/v1"))).toMatchObject({
      ok: false,
      code: "BRAIN_FORBIDDEN",
      cause: "brain_loopback",
    });
    expect(validateServedBrainRef({
      ...ollamaLoopback,
      endpoint: "https://api.openai.com/v1",
    })).toMatchObject({ ok: false, code: "BRAIN_FORBIDDEN" });
    const oversized = `http://127.0.0.1/${"a".repeat(BRAIN_ENDPOINT_MAX_BYTES)}`;
    expect(validateServedBrainRef(openaiLoopback(oversized))).toMatchObject({
      ok: false,
      code: "BRAIN_FORBIDDEN",
      cause: "brain_endpoint_size",
    });
  });

  it("records self-hosted ollama in config fixtures and rejects hosted-endpoint pairing", () => {
    expect(parsePubchiConfigV1(loadFixture("valid/config__self-hosted-ollama.json"))).toMatchObject({ ok: true });
    expect(parsePubchiConfigV1(loadFixture("invalid/config__BRAIN_FORBIDDEN__hosted-endpoint.json"))).toEqual({
      ok: false,
      code: "BRAIN_FORBIDDEN",
    });
    expect(parsePubchiConfigV1(loadFixture("invalid/config__BRAIN_FORBIDDEN__moonshot-self-hosted.json"))).toEqual({
      ok: false,
      code: "BRAIN_FORBIDDEN",
    });
  });
});

describe("brain adapter selection", () => {
  const deployment = countingBrain(() => "deployment");

  afterEach(() => {
    deployment.calls = 0;
  });

  it("reuses the deployment brain for synonym-hosted moonshot", async () => {
    const served = servePubchiBrain(hosted, {
      deploymentBrain: deployment.brain,
      hostedModel: PHASE0_BRAIN.model_id,
      hostedApiKey: "hosted-secret",
    });
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    await served.brain.generate({
      messages: [{ role: "user", content: "hi" }],
      temperature: 1,
      abortSignal: new AbortController().signal,
    });
    expect(deployment.calls).toBe(1);
  });

  it("selects ollama for a loopback self-hosted descriptor", () => {
    const served = servePubchiBrain(ollamaLoopback, {
      deploymentBrain: deployment.brain,
      hostedApiKey: "hosted-secret",
    });
    expect(served.ok).toBe(true);
    if (!served.ok) return;
    expect(served.brain.capabilities.providerId).toBe("ollama");
    expect(deployment.calls).toBe(0);
  });

  it("does not forward the hosted key and fails visibly without a self-hosted key", async () => {
    const fake = await startFakeOpenAI();
    try {
      const missing = servePubchiBrain(openaiLoopback(fake.url), {
        deploymentBrain: deployment.brain,
        hostedApiKey: "hosted-secret",
      });
      expect(missing).toEqual({ ok: false, code: "BRAIN_UNAVAILABLE", cause: "brain_credentials" });
      expect(deployment.calls).toBe(0);
      expect(fake.calls.n).toBe(0);

      const served = servePubchiBrain(openaiLoopback(fake.url), {
        deploymentBrain: deployment.brain,
        hostedApiKey: "hosted-secret",
        selfHostedApiKey: "self-hosted-only",
      });
      expect(served.ok).toBe(true);
      if (!served.ok) return;
      expect(served.brain.capabilities.providerId).toBe("openai-compatible");
      const out = await served.brain.generate({
        messages: [{ role: "user", content: "hi" }],
        temperature: 1,
        abortSignal: new AbortController().signal,
      });
      expect(out.text).toBe("fake-answer");
      expect(deployment.calls).toBe(0);
      expect(fake.calls.n).toBe(1);
      const auth = JSON.stringify(fake.bodies);
      expect(auth).not.toContain("hosted-secret");
    } finally {
      await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    }
  });

  it("does not fall back to the deployment brain when self-hosted egress is refused", () => {
    const served = servePubchiBrain(openaiLoopback("https://api.openai.com/v1"), {
      deploymentBrain: deployment.brain,
      hostedApiKey: "hosted-secret",
      selfHostedApiKey: "self-hosted-only",
    });
    expect(served).toMatchObject({ ok: false, code: "BRAIN_FORBIDDEN", cause: "brain_loopback" });
    expect(deployment.calls).toBe(0);
  });

  it("rejects an openai-compatible descriptor pointing at api.moonshot.ai without sending the self-hosted key", () => {
    const served = servePubchiBrain(openaiLoopback("https://api.moonshot.ai/v1"), {
      deploymentBrain: deployment.brain,
      hostedApiKey: "hosted-secret",
      selfHostedApiKey: "self-hosted-only",
      egressDangerous: true,
    });
    expect(served).toEqual({ ok: false, code: "BRAIN_FORBIDDEN", cause: "brain_loopback" });
    expect(deployment.calls).toBe(0);
  });

  it("ignores JEB_BRAIN_EGRESS_DANGEROUS on tenant URLs", () => {
    const serve = createPubchiBrainServe({
      deploymentBrain: deployment.brain,
      hostedApiKey: "hosted-secret",
      selfHostedApiKey: "self-hosted-only",
      egressDangerous: true,
    });
    const remote = serve(
      testTenant({
        brain: openaiLoopback("https://api.openai.com/v1"),
      }),
    );
    expect(remote).toEqual({ ok: false, code: "BRAIN_FORBIDDEN", cause: "brain_loopback" });
    expect(deployment.calls).toBe(0);
    expect(
      servePubchiBrain(openaiLoopback("https://api.openai.com/v1"), {
        deploymentBrain: deployment.brain,
        selfHostedApiKey: "self-hosted-only",
        egressDangerous: true,
      }),
    ).toEqual({ ok: false, code: "BRAIN_FORBIDDEN", cause: "brain_loopback" });
  });

  it("caches adapters for identical descriptors", () => {
    const serve = createPubchiBrainServe({
      deploymentBrain: deployment.brain,
      hostedModel: PHASE0_BRAIN.model_id,
    });
    const tenant = testTenant({ brain: hosted });
    const first = serve(tenant);
    const second = serve(tenant);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.brain.capabilities.providerId).toBe(second.brain.capabilities.providerId);
    }
  });
});

describe("tenant self-hosted loopback policy", () => {
  const deployment = countingBrain(() => "deployment");

  it("accepts only 127.0.0.1, localhost, and ::1", () => {
    expect(validateServedBrainRef(openaiLoopback("http://127.0.0.1:9/v1"))).toMatchObject({ ok: true });
    expect(validateServedBrainRef(openaiLoopback("http://localhost:9/v1"))).toMatchObject({ ok: true });
    expect(validateServedBrainRef(openaiLoopback("http://[::1]:9/v1"))).toMatchObject({ ok: true });
    expect(validateServedBrainRef(openaiLoopback("http://127.0.0.2:9/v1"))).toMatchObject({
      ok: false,
      code: "BRAIN_FORBIDDEN",
      cause: "brain_loopback",
    });
  });

  it("rejects 0.0.0.0, mapped IPv6, DNS rebinding names, and fragments", () => {
    for (const endpoint of [
      "http://0.0.0.0:9/v1",
      "http://0:9/v1",
      "http://[::]:9/v1",
      "http://[::ffff:127.0.0.1]:9/v1",
      "http://[::ffff:7f00:1]:9/v1",
      "http://127.0.0.1.nip.io:9/v1",
      "http://localtest.me:9/v1",
      "http://localhost.:9/v1",
      "http://127.0.0.1:9/v1#token",
    ]) {
      expect(validateServedBrainRef(openaiLoopback(endpoint))).toMatchObject({
        ok: false,
        code: "BRAIN_FORBIDDEN",
      });
    }
  });

  it("rejects file and ftp schemes even on loopback", () => {
    expect(validateServedBrainRef(openaiLoopback("file://127.0.0.1/v1"))).toMatchObject({
      ok: false,
      code: "BRAIN_FORBIDDEN",
      cause: "brain_endpoint_scheme",
    });
    expect(validateServedBrainRef(openaiLoopback("ftp://127.0.0.1/v1"))).toMatchObject({
      ok: false,
      code: "BRAIN_FORBIDDEN",
      cause: "brain_endpoint_scheme",
    });
  });

  it("treats WHATWG-canonical decimal, hex, and octal IPv4 as 127.0.0.1", () => {
    for (const endpoint of [
      "http://2130706433:9/v1",
      "http://0x7f000001:9/v1",
      "http://127.1:9/v1",
      "http://0177.0.0.1:9/v1",
      "http://[0:0:0:0:0:0:0:1]:9/v1",
    ]) {
      expect(validateServedBrainRef(openaiLoopback(endpoint))).toMatchObject({ ok: true });
    }
  });

  it("never attaches the self-hosted key outside openai-compatible loopback", () => {
    expect(
      servePubchiBrain(openaiLoopback("https://api.moonshot.ai/v1"), {
        deploymentBrain: deployment.brain,
        selfHostedApiKey: "must-not-leave",
      }),
    ).toMatchObject({ ok: false, code: "BRAIN_FORBIDDEN" });
    expect(
      servePubchiBrain(ollamaLoopback, {
        deploymentBrain: deployment.brain,
        selfHostedApiKey: "must-not-leave",
      }),
    ).toMatchObject({ ok: true });
  });
});
