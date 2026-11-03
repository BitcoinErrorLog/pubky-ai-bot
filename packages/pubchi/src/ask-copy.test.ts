import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nlqResult, type Brain } from "@pubky/bot-kit";
import { Nexus } from "../bot-kit/nexus/nexus.js";
import { runAsk } from "./ask.js";
import { countingBrain, TEST_FAKE, TEST_NOW, TEST_OWNER, testTenant } from "./test-helpers.js";

const OTHER = "n9fzu63meroxfcxccz1budmqbn3e7yj97cy6jjyyoqpamacyod8y";
const NO_INVENTION =
  "Never invent release dates, versions or timelines; for unreleased work, point to public GitHub issues, pull requests or releases.";

function recordingBrain(reply: (system: string, user: string) => string): { brain: Brain; systems: string[] } {
  const systems: string[] = [];
  const base = countingBrain(() => "").brain;
  const brain: Brain = {
    ...base,
    generate: async (args) => {
      const system = String(args.messages.find((m) => m.role === "system")?.content ?? "");
      const user = String(args.messages.at(-1)?.content ?? "");
      systems.push(system);
      return { text: reply(system, user), response: { messages: [] } };
    },
  };
  return { brain, systems };
}

describe("OP-3: no invented release dates in Pubchi prompts", () => {
  it("uses Jeb's sentence verbatim", () => {
    const jeb = readFileSync(new URL("../../src/knowledge/prompt.ts", import.meta.url), "utf8");
    expect(jeb).toContain(NO_INVENTION);
  });

  it("carries the rule on the thread-summary prompt and hedges when asked for a date", async () => {
    const uri = `pubky://${OTHER}/pub/pubky.app/posts/0035QYQSVNK60`;
    const replies = [
      { author_name: "Ada", author_id: OTHER, uri, content: "Paykit v2 is coming soon, no date yet." },
      { author_name: "Bo", author_id: TEST_OWNER, uri: `pubky://${TEST_OWNER}/pub/pubky.app/posts/0035QYQSVNK61`, content: "When does it ship?" },
    ];
    const { brain, systems } = recordingBrain((system) =>
      JSON.stringify({
        summary: system.includes(NO_INVENTION)
          ? `Nobody in the thread gives a release date; follow the public GitHub issues and releases for Paykit v2. ${OTHER} and ${TEST_OWNER} discuss it.`
          : `Paykit v2 ships on 14 December 2026. ${OTHER} and ${TEST_OWNER} discuss it.`,
      }),
    );
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: `Summarize this thread and tell me the release date ${uri}` },
      now: TEST_NOW,
      runId: "run-no-invented-date",
      nlq: async () => nlqResult({
        outcome: "ok",
        reason: "ok",
        intent: "summarize_thread",
        planned: [{ tool: "scout_get_thread", args: { uri } }],
        results: [{ posts: replies }],
      }),
      nlqOpts: {} as never,
      brain,
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    expect(systems.length).toBeGreaterThan(0);
    expect(systems.every((system) => system.includes(NO_INVENTION))).toBe(true);
    expect(out.result.summary).toMatch(/release date|GitHub/);
    expect(out.result.summary).not.toMatch(/December|2026/);
  });

  it("carries the rule on the composition prompt", async () => {
    const { brain, systems } = recordingBrain(() => JSON.stringify({ summary: "No release date is published." }));
    await runAsk({
      tenant: testTenant(),
      body: { question: "Who has the most tags?" },
      now: TEST_NOW,
      runId: "run-composition-prompt",
      nlq: async () => nlqResult({
        outcome: "ok",
        reason: "ok",
        intent: "research_pubky",
        planned: [{ tool: "get_topic_brief", args: {} }],
        results: [{ posts: [{ author_name: "Ada", uri: `pubky://${OTHER}/pub/pubky.app/posts/x`, content: "hello" }] }],
      }),
      nlqOpts: {} as never,
      brain,
    });
    expect(systems.length).toBeGreaterThan(0);
    expect(systems.every((system) => system.includes(NO_INVENTION))).toBe(true);
  });
});

describe("#55-5: image-only post", () => {
  it("answers with a one-line default and the attachment citation", async () => {
    const captured = JSON.parse(
      readFileSync(new URL("../../packages/bot-kit/src/scout/fixtures/nexus-post-image.json", import.meta.url), "utf8"),
    ) as { body: { details: { uri: string; content: string; author: string; attachments: string[] } } };
    const body = { ...captured.body, details: { ...captured.body.details, content: "" } };
    const uri = body.details.uri;
    const file = body.details.attachments[0];
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");
    try {
      const brain = countingBrain(() => {
        throw new Error("brain must not narrate an image-only post");
      });
      const out = await runAsk({
        tenant: testTenant(),
        body: { question: `Summarize this post ${uri}` },
        now: TEST_NOW,
        runId: "run-image-only",
        nlq: async () => nlqResult({
          outcome: "ok",
          reason: "ok",
          intent: "summarize_thread",
          planned: [{ tool: "scout_get_thread", args: { uri } }],
          results: [{ posts: [{ uri, author_id: body.details.author, author_name: "Ada", content: "" }] }],
        }),
        nlqOpts: {} as never,
        nexus: new Nexus(`http://127.0.0.1:${address.port}`, 5_000),
        brain: brain.brain,
      });
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok) return;
      expect(brain.calls).toBe(0);
      expect(out.result.summary).toBe(`No readable text in this post. Attachment: ${file}`);
      expect(out.result.summary.split("\n")).toHaveLength(1);
      expect(out.result.evidence[0]?.uri).toBe(uri);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("still summarizes a post that has text next to its image", async () => {
    const uri = `pubky://${OTHER}/pub/pubky.app/posts/0035QYQSVNK60`;
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: `Summarize this post ${uri}` },
      now: TEST_NOW,
      runId: "run-image-with-text",
      nlq: async () => nlqResult({
        outcome: "ok",
        reason: "ok",
        intent: "summarize_thread",
        planned: [{ tool: "scout_get_thread", args: { uri } }],
        results: [{ posts: [{ uri, author_id: OTHER, author_name: "Ada", content: "A ride to the market.", attachments: [`pubky://${OTHER}/pub/pubky.app/files/F1`] }] }],
      }),
      nlqOpts: {} as never,
      brain: countingBrain(() => JSON.stringify({ summary: "Ada rode to the market." })).brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.summary).not.toContain("No readable text");
  });
});

describe("#11-4: rank_users output is labelled and sorted", () => {
  it("renders 'most active people I follow' as labelled posts, highest first, with the window", async () => {
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "Who are the most active people I follow?" },
      now: TEST_NOW,
      runId: "run-rank-posts",
      nlq: async () => nlqResult({
        outcome: "ok",
        reason: "ok",
        intent: "research_pubky",
        planned: [{ tool: "rank_users", args: { metric: "posts", order: "desc", limit: 10 } }],
        results: [{
          users: [
            { name: "Bo", pubky: TEST_OWNER, posts: 3 },
            { name: "Ada", pubky: OTHER, posts: 12 },
            { name: "Cy", pubky: TEST_FAKE, posts: 7 },
          ],
        }],
      }),
      nlqOpts: {} as never,
      brain: countingBrain(() => {
        throw new Error("brain must not be called");
      }).brain,
    });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    expect(out.result.summary).toContain("ranked by posts (highest first)");
    expect(out.result.summary).toContain("Ada (12 posts), Cy (7 posts), Bo (3 posts)");
    expect(out.result.summary).toContain("last 30 days");
  });

  it("labels follower rankings and sorts them descending", async () => {
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "Who is most followed?" },
      now: TEST_NOW,
      runId: "run-rank-followers",
      nlq: async () => nlqResult({
        outcome: "ok",
        reason: "ok",
        intent: "research_pubky",
        planned: [{ tool: "rank_users", args: { metric: "followers", order: "desc" } }],
        results: [{ users: [{ name: "Bo", pubky: TEST_OWNER, followers: 2 }, { name: "Ada", pubky: OTHER, followers: 9 }] }],
      }),
      nlqOpts: {} as never,
      brain: countingBrain(() => "").brain,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result.summary).toContain("ranked by followers (highest first), are Ada (9 followers), Bo (2 followers)");
  });
});
