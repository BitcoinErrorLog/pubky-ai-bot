import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { answerMention } from "./answer.js";
import type { Config } from "./config.js";
import type { ChainPost } from "./context.js";
import { Store } from "./db.js";
import { Nexus } from "./nexus.js";
import { completionJson, startFakeOpenAI } from "../tests/fake-openai.js";

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
      answerBudgetMs: 30_000,
      toolMaxSteps: 1,
    } as Config;
    const out = await answerMention(cfg, new Nexus("http://127.0.0.1:9"), "botpk", mention, [mention]);
    expect(out.content).toContain("fake-answer");
    expect(out.tokens).toBe(5);
  });
});

function listenNexus(
  handler: (url: URL, res: import("node:http").ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => handler(new URL(req.url ?? "/", "http://127.0.0.1"), res));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("per-step timeout and answer budget", () => {
  it("honours JEB_MODEL_TIMEOUT_MS on a single generateText step", async () => {
    const fake = await startFakeOpenAI({
      handler: () => ({ delayMs: 400, json: completionJson("too-late") }),
    });
    const cfg = {
      cannedReply: undefined,
      modelApiKey: "sk-test",
      modelBaseUrl: fake.url,
      model: "gpt-4o-mini",
      modelTimeoutMs: 80,
      answerBudgetMs: 10_000,
      toolMaxSteps: 4,
    } as Config;
    const started = Date.now();
    await expect(answerMention(cfg, new Nexus("http://127.0.0.1:9"), "botpk", mention, [mention])).rejects.toMatchObject(
      { name: "AbortError" },
    );
    expect(Date.now() - started).toBeLessThan(350);
    await new Promise<void>((r) => fake.server.close(() => r()));
  });

  it("slow tool then timed-out next step still publishes a compose-from-evidence reply", async () => {
    const USER = mention.author;
    const nexus = await listenNexus((u, res) => {
      const send = () => {
        if (u.pathname.includes("/user/")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ name: "Ada", id: USER }));
          return;
        }
        res.writeHead(404);
        res.end();
      };
      if (u.pathname.includes("/user/")) setTimeout(send, 250);
      else send();
    });
    const fake = await startFakeOpenAI({
      handler: (n, body) => {
        const tools = body.tools;
        const hasTools = Array.isArray(tools) && tools.length > 0;
        if (hasTools && n === 1) {
          return {
            json: completionJson("", {
              toolCalls: [
                {
                  id: "call_user",
                  type: "function",
                  function: { name: "get_user", arguments: JSON.stringify({ pubky: USER }) },
                },
              ],
            }),
          };
        }
        if (hasTools) return { delayMs: 800, json: completionJson("should-not-win") };
        return { json: completionJson("composed-from-evidence") };
      },
    });
    const cfg = {
      cannedReply: undefined,
      modelApiKey: "sk-test",
      modelBaseUrl: fake.url,
      model: "gpt-4o-mini",
      modelTimeoutMs: 200,
      answerBudgetMs: 8_000,
      toolMaxSteps: 6,
    } as Config;
    try {
      const out = await answerMention(cfg, new Nexus(nexus.url, 2000), "botpk", mention, [mention]);
      expect(out.content).toContain("composed-from-evidence");
      expect(JSON.stringify(out.toolTrace)).toMatch(/budget_exhausted|get_user/);
    } finally {
      await new Promise<void>((r) => fake.server.close(() => r()));
      await new Promise<void>((r) => nexus.server.close(() => r()));
    }
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
