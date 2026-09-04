import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { answerMention } from "./answer.js";
import type { Config } from "./config.js";
import type { ChainPost } from "./context.js";
import { Nexus } from "./nexus.js";
import { startFakeOpenAI } from "../tests/fake-openai.js";

/**
 * Recorded from `answerMention` + fake OpenAI on this worktree before the
 * step-10 move (`npx tsx scripts/capture-answer-payloads.ts`). Inputs must stay fixed.
 */
const FIXTURES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../tests/fixtures/answer-tool-loop-payloads.json"), "utf8"),
) as {
  hello: Payload;
  factCheck: Payload;
};

type Payload = {
  model: string;
  temperature: number;
  system: string;
  messages: Array<{ role: string; content: unknown }>;
  toolNames: string[];
  tools: unknown[];
};

const BOT = "botpk";

const hello: ChainPost = {
  uri: "pubky://1111111111111111111111111111111111111111111111111111/pub/pubky.app/posts/0000000000001",
  createdAt: 1,
  author: "1111111111111111111111111111111111111111111111111111",
  name: "u",
  content: "hello jeb",
};

const factCheck: ChainPost = {
  ...hello,
  content: "fact-check this claim who supports it",
};

function summarize(body: Record<string, unknown>): Payload {
  const messages = (body.messages as Array<{ role: string; content: unknown }>) ?? [];
  const tools =
    (body.tools as Array<{ type?: string; function?: { name?: string } }>) ?? [];
  return {
    model: body.model as string,
    temperature: body.temperature as number,
    system: String(messages.find((m) => m.role === "system")?.content ?? ""),
    messages,
    toolNames: tools.map((t) => t.function?.name ?? ""),
    tools,
  };
}

async function capture(mention: ChainPost): Promise<Payload> {
  const fake = await startFakeOpenAI();
  const cfg = {
    cannedReply: undefined,
    modelApiKey: "sk-test",
    modelBaseUrl: fake.url,
    model: "gpt-4o-mini",
    modelTimeoutMs: 5000,
    answerBudgetMs: 30_000,
    toolMaxSteps: 1,
  } as Config;
  try {
    await answerMention(cfg, new Nexus("http://127.0.0.1:9"), BOT, mention, [mention]);
    return summarize((fake.bodies[0] ?? {}) as Record<string, unknown>);
  } finally {
    await new Promise<void>((r) => fake.server.close(() => r()));
  }
}

describe("answer tool-loop payload byte-identity vs pre-move fixture", () => {
  it("hello jeb system + messages + tools match the captured Step-10 pre-move body", async () => {
    const got = await capture(hello);
    expect(got.system).toBe(FIXTURES.hello.system);
    expect(JSON.stringify(got.messages)).toBe(JSON.stringify(FIXTURES.hello.messages));
    expect(JSON.stringify(got.toolNames)).toBe(JSON.stringify(FIXTURES.hello.toolNames));
    expect(JSON.stringify(got.tools)).toBe(JSON.stringify(FIXTURES.hello.tools));
    expect(got.temperature).toBe(FIXTURES.hello.temperature);
    expect(got.model).toBe(FIXTURES.hello.model);
  });

  it("fact-check system + messages + tools match the captured Step-10 pre-move body", async () => {
    const got = await capture(factCheck);
    expect(got.system).toBe(FIXTURES.factCheck.system);
    expect(JSON.stringify(got.messages)).toBe(JSON.stringify(FIXTURES.factCheck.messages));
    expect(JSON.stringify(got.toolNames)).toBe(JSON.stringify(FIXTURES.factCheck.toolNames));
    expect(JSON.stringify(got.tools)).toBe(JSON.stringify(FIXTURES.factCheck.tools));
    expect(got.temperature).toBe(FIXTURES.factCheck.temperature);
    expect(got.model).toBe(FIXTURES.factCheck.model);
  });
});
