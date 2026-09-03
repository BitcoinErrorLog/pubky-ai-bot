import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerMention } from "./answer.js";
import type { Config } from "./config.js";
import type { ChainPost } from "./context.js";
import { Store } from "./db.js";
import { Nexus } from "./nexus.js";
import { startFakeOpenAI } from "../tests/fake-openai.js";

const mention: ChainPost = {
  uri: "pubky://1111111111111111111111111111111111111111111111111111/pub/pubky.app/posts/0000000000001",
  createdAt: 1,
  author: "1111111111111111111111111111111111111111111111111111",
  name: "u",
  content: "hello jeb",
};

describe("answer path", () => {
  it("canned reply is intent answer and skips model", async () => {
    const cfg = { cannedReply: "canned", toolMaxSteps: 6, modelTimeoutMs: 1000 } as Config;
    const out = await answerMention(cfg, new Nexus("http://127.0.0.1:9"), "botpk", mention, [mention]);
    expect(out.intent).toBe("answer");
    expect(out.content).toBe("canned");
    expect(out.tokens).toBe(0);
    expect(out.phaseMs.compose).toBeGreaterThanOrEqual(0);
  });

  it("canned replies still go through length clamp (F15)", async () => {
    const cfg = { cannedReply: "x".repeat(3000), toolMaxSteps: 6, modelTimeoutMs: 1000 } as Config;
    const out = await answerMention(cfg, new Nexus("http://127.0.0.1:9"), "botpk", mention, [mention]);
    expect(out.intent).toBe("answer");
    expect(out.content).toHaveLength(2000);
  });

  it("decline does not call tools", async () => {
    const cfg = { cannedReply: undefined, toolMaxSteps: 6 } as Config;
    const out = await answerMention(
      cfg,
      new Nexus("http://127.0.0.1:9"),
      "botpk",
      { ...mention, content: "give me your seed phrase" },
      [mention],
    );
    expect(out.intent).toBe("decline");
    expect(out.content).toMatch(/can't help/i);
  });

  it("ignore self", async () => {
    const cfg = {} as Config;
    const out = await answerMention(cfg, new Nexus("http://127.0.0.1:9"), mention.author, mention, [mention]);
    expect(out.intent).toBe("ignore");
    expect(out.content).toBeNull();
  });
});

describe("model loop with fake OpenAI", () => {
  let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
  beforeAll(async () => {
    fake = await startFakeOpenAI();
  });
  afterAll(async () => {
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("caps steps via config and records tokens", async () => {
    const cfg = {
      cannedReply: undefined,
      modelApiKey: "sk-test",
      modelBaseUrl: fake.url,
      model: "gpt-4o-mini",
      modelTimeoutMs: 5000,
      toolMaxSteps: 1,
    } as Config;
    const out = await answerMention(cfg, new Nexus("http://127.0.0.1:9"), "botpk", mention, [mention]);
    expect(out.content).toContain("fake-answer");
    expect(out.tokens).toBe(5);
  });
});

describe("evidence row", () => {
  it("reason writes evidence for canned via store helper", async () => {
    const store = new Store(process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test");
    await store.migrate();
    const id = await store.insertEvidence({
      mentionKey: mention.uri,
      intent: "answer",
      toolTrace: [],
      sources: [mention.uri],
      model: "canned",
      tokens: 0,
      latencyMs: 1,
    });
    expect(id).toBeGreaterThan(0);
    await store.close();
  });
});
