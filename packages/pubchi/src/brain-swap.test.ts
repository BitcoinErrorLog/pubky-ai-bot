import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJson,
  parsePubchiBotV1,
  parsePubchiConfigV1,
  sha256Hex,
  type BrainRefV1,
} from "../pubchi-schemas/index.js";
import { startFakeOpenAI } from "../../tests/fake-openai.js";
import { createBrain } from "../bot-kit/brain/create.js";
import { createPubchiBrainServe, providerStateKeysIn } from "./brain-serve.js";
import { loadFixture, TEST_BOT, TEST_OWNER, TEST_NOW, TWO_HOP_BITCOIN_FEED } from "./test-helpers.js";

type Fake = Awaited<ReturnType<typeof startFakeOpenAI>>;

const moonshotRef: BrainRefV1 = {
  adapter: "vercel-ai",
  execution: "synonym-hosted",
  provider_id: "moonshot",
  model_id: "kimi-k3",
  endpoint: null,
};

function ollamaRef(endpoint: string): BrainRefV1 {
  return {
    adapter: "vercel-ai",
    execution: "self-hosted",
    provider_id: "ollama",
    model_id: "qwen2.5:7b",
    endpoint,
  };
}

function pubchiState(brain: BrainRefV1) {
  const bot = loadFixture("valid/bot__custody-v1.json");
  const configRaw = loadFixture("valid/config__app-cross-repo.json") as Record<string, unknown>;
  const configBrain = configRaw.brain as Record<string, unknown>;
  const config = {
    ...configRaw,
    bot: TEST_BOT,
    owner: TEST_OWNER,
    brain: {
      ...configBrain,
      adapter: brain.adapter,
      execution: brain.execution,
      provider_id: brain.provider_id,
      model_id: brain.model_id,
      endpoint: brain.endpoint,
    },
  };
  const interests = {
    schema: "pubchi-interests",
    version: 1,
    bot: TEST_BOT,
    owner: TEST_OWNER,
    updated_at: TEST_NOW,
    topics: [{ label: "bitcoin", weight: 3, source: "explicit", expires_at: null }],
    excluded_topics: [],
  };
  const formats = {
    schema: "pubchi-approved-formats",
    version: 1,
    bot: TEST_BOT,
    owner: TEST_OWNER,
    updated_at: TEST_NOW,
    formats: [{ id: "weekly-missed-summary", mode: "suggest-only", enabled: true, max_per_day: 1, allowed_outputs: ["draft"], policy_version: 1 }],
  };
  const feed = {
    schema: "pubchi-feed-definition",
    version: 1,
    bot: TEST_BOT,
    owner: TEST_OWNER,
    updated_at: TEST_NOW,
    feed: TWO_HOP_BITCOIN_FEED,
    installed_user_feed_id: null,
  };
  const post = { uri: `pubky://${TEST_BOT}/pub/pubky.app/posts/00321FCW75ZFY`, author: TEST_BOT, content: "hello" };
  const tag = { uri: `pubky://${TEST_BOT}/pub/pubky.app/tags/FPB0AM9S93Q3M1GFY1KV09GMQM`, author: TEST_BOT };
  return { bot, config, interests, formats, feed, post, tag };
}

function hashesExceptConfigBrain(state: ReturnType<typeof pubchiState>) {
  const { brain: _brain, ...configWithoutBrain } = state.config as Record<string, unknown> & { brain: unknown };
  return {
    bot_pubky: sha256Hex(TEST_BOT),
    bot: sha256Hex(canonicalJson(state.bot)),
    config_without_brain: sha256Hex(canonicalJson(configWithoutBrain)),
    interests: sha256Hex(canonicalJson(state.interests)),
    formats: sha256Hex(canonicalJson(state.formats)),
    feed: sha256Hex(canonicalJson(state.feed)),
    post: sha256Hex(canonicalJson(state.post)),
    tag: sha256Hex(canonicalJson(state.tag)),
    authors: [state.post.author, state.tag.author],
  };
}

describe("brain swap hash equality", () => {
  let moonshotFake: Fake;
  let ollamaFake: Fake;

  beforeAll(async () => {
    moonshotFake = await startFakeOpenAI();
    ollamaFake = await startFakeOpenAI();
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve) => moonshotFake.server.close(() => resolve())),
      new Promise<void>((resolve) => ollamaFake.server.close(() => resolve())),
    ]);
  });

  it("changing only config.json.brain leaves Pubchi state hashes and authors identical", async () => {
    const before = pubchiState(moonshotRef);
    const beforeHashes = hashesExceptConfigBrain(before);
    expect(parsePubchiBotV1(before.bot).ok).toBe(true);
    expect(parsePubchiConfigV1(before.config).ok).toBe(true);

    const deployment = createBrain({
      id: "moonshot",
      model: "kimi-k3",
      apiKey: "swap-a",
      baseUrl: moonshotFake.url,
    });
    const serve = createPubchiBrainServe({
      deploymentBrain: deployment,
      hostedModel: "kimi-k3",
      hostedApiKey: "swap-a",
      hostedBaseUrl: moonshotFake.url,
      selfHostedApiKey: "must-not-be-used-for-ollama",
    });

    const tenantA = {
      schema: "pubchi-tenant" as const,
      version: 1 as const,
      bot: TEST_BOT,
      owner: TEST_OWNER,
      tier: "read-only" as const,
      brain: moonshotRef,
      budgets: {
        per_request_input_tokens: 8_000,
        per_request_output_tokens: 2_000,
        per_request_wall_clock_ms: 30_000,
        per_owner_hourly_tokens: 50_000,
        per_owner_utc_day_tokens: 200_000,
        per_tenant_scout_queries: 20,
        per_tenant_scout_rows: 200,
        per_tenant_web_calls: 0,
        proactive_suggestions_per_day: 0,
      },
      created_at: TEST_NOW - 1,
      updated_at: TEST_NOW,
    };
    const servedA = serve(tenantA);
    expect(servedA.ok).toBe(true);
    if (!servedA.ok) return;
    const outA = await servedA.brain.generate({
      messages: [{ role: "user", content: "identical input" }],
      temperature: 1,
      abortSignal: new AbortController().signal,
    });
    expect(outA.text).toBe("fake-answer");

    const afterA = pubchiState(moonshotRef);
    expect(hashesExceptConfigBrain(afterA)).toEqual(beforeHashes);

    const swapped = ollamaRef(ollamaFake.url);
    const afterSwap = pubchiState(swapped);
    expect(parsePubchiConfigV1(afterSwap.config).ok).toBe(true);
    const afterHashes = hashesExceptConfigBrain(afterSwap);
    expect(afterHashes).toEqual(beforeHashes);
    expect(sha256Hex(canonicalJson(afterSwap.config))).not.toBe(sha256Hex(canonicalJson(before.config)));

    const tenantB = { ...tenantA, brain: swapped };
    const servedB = serve(tenantB);
    expect(servedB.ok).toBe(true);
    if (!servedB.ok) return;
    expect(servedB.brain.capabilities.providerId).toBe("ollama");
    const outB = await servedB.brain.generate({
      messages: [{ role: "user", content: "identical input" }],
      temperature: 1,
      abortSignal: new AbortController().signal,
    });
    expect(outB.text).toBe("fake-answer");
    expect(hashesExceptConfigBrain(pubchiState(swapped))).toEqual(beforeHashes);

    expect(moonshotFake.calls.n).toBe(1);
    expect(ollamaFake.calls.n).toBe(1);
    expect(providerStateKeysIn(moonshotFake.bodies)).toEqual([]);
    expect(providerStateKeysIn(ollamaFake.bodies)).toEqual([]);
    expect(JSON.stringify(moonshotFake.bodies)).not.toContain("thread");
    expect(JSON.stringify(ollamaFake.bodies)).not.toContain("assistant_id");
  });
});
