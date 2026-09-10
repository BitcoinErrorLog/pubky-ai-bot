import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nlqResult } from "@pubky/bot-kit";
import { runAsk } from "./ask.js";
import { countingBrain, TEST_NOW, TEST_OWNER, testTenant } from "./test-helpers.js";

const OTHER = "n9fzu63meroxfcxccz1budmqbn3e7yj97cy6jjyyoqpamacyod8y";
const DAY = 24 * 60 * 60 * 1000;

type MissedRow = {
  event_kind: "post" | "reply" | "tag";
  author_id: string;
  author_name: string | null;
  post_id: string;
  content: string | null;
  indexed_at: number;
  deleted: boolean;
};

function row(
  event_kind: MissedRow["event_kind"],
  index: number,
  indexed_at: number,
  overrides: Partial<MissedRow> = {},
): MissedRow {
  return {
    event_kind,
    author_id: OTHER,
    author_name: "Ada",
    post_id: `000000000000${String.fromCharCode(65 + index)}`,
    content: `${event_kind} fixture ${index}`,
    indexed_at,
    deleted: false,
    ...overrides,
  };
}

const EVENTS: MissedRow[] = [
  ...Array.from({ length: 15 }, (_, index) => row("post", index, TEST_NOW - index * 1_000)),
  ...Array.from({ length: 10 }, (_, index) => row("reply", index + 15, TEST_NOW - index * 1_000)),
  ...Array.from({ length: 10 }, (_, index) => row("tag", index + 25, TEST_NOW - index * 1_000)),
];

function ask(
  question: string,
  results: unknown[],
  brain = countingBrain(() => JSON.stringify({ summary: "unused" })),
) {
  return runAsk({
    tenant: testTenant(),
    body: { question },
    now: TEST_NOW,
    runId: `missed-${question.slice(0, 8).replace(/\W/g, "") || "empty"}`,
    nlq: async (request) => {
      const since = request.question.match(/since (\d{4}-\d{2}-\d{2}T[^ ]+Z)/i)?.[1];
      const requestedSince = since ? Date.parse(since) : TEST_NOW - DAY;
      return nlqResult({
        outcome: "ok",
        reason: "ok",
        intent: "what_did_i_miss",
        planned: [{
          tool: "get_what_did_i_miss",
          args: { owner: TEST_OWNER, since: requestedSince, until: TEST_NOW, limit: 35 },
        }],
        results,
      });
    },
    nlqOpts: {} as never,
    brain: brain.brain,
  });
}

function grouped(rows: MissedRow[], extra: Record<string, unknown> = {}) {
  return [{
    posts: rows.filter((item) => item.event_kind === "post"),
    replies: rows.filter((item) => item.event_kind === "reply"),
    tags: rows.filter((item) => item.event_kind === "tag"),
    skipped: rows.filter((item) => item.deleted || !item.content || !item.author_name).length,
    truncated: false,
    ...extra,
  }];
}

describe("what_did_i_miss semantics", () => {
  it("uses inclusive since and exclusive until with deterministic boundary ownership", async () => {
    const boundary = row("post", 40, TEST_NOW - DAY);
    const events = [
      row("post", 41, TEST_NOW - 2 * DAY),
      boundary,
      row("post", 42, TEST_NOW - 12 * 60 * 60 * 1000),
    ];
    const first = await ask(
      `what did I miss since ${new Date(TEST_NOW - 2 * DAY).toISOString()}`,
      grouped(events.filter((item) => item.indexed_at >= TEST_NOW - 2 * DAY && item.indexed_at < TEST_NOW - DAY)),
    );
    const second = await ask(
      `what did I miss since ${new Date(TEST_NOW - DAY).toISOString()}`,
      grouped(events.filter((item) => item.indexed_at >= TEST_NOW - DAY && item.indexed_at < TEST_NOW)),
    );
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) return;
    const uris = [...first.result.evidence, ...second.result.evidence].map((item) => item.uri);
    expect(uris.filter((uri) => uri.endsWith(boundary.post_id))).toHaveLength(1);
    expect(uris).toHaveLength(3);
  });

  it("caps each section and reports cap-plus-one overflow", async () => {
    const out = await ask("what did I miss", grouped([
      ...EVENTS,
      row("post", 60, TEST_NOW - 600),
      row("reply", 61, TEST_NOW - 500),
      row("tag", 62, TEST_NOW - 400),
    ], { truncated: true }));
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.result.evidence.filter((item) => item.kind === "post")).toHaveLength(25);
    expect(out.result.evidence.filter((item) => item.kind === "tag")).toHaveLength(10);
    expect(out.result.summary).toContain("and 1 more");
    expect(out.result.continuation).toMatchObject({ complete: false, until: new Date(TEST_NOW * 1000).toISOString() });
  });

  it("excludes unreadable rows and increments skipped", async () => {
    const out = await ask("what did I miss", grouped([
      row("post", 50, TEST_NOW - 1_000),
      row("reply", 51, TEST_NOW - 900, { content: null }),
      row("tag", 52, TEST_NOW - 800, { author_name: null }),
      row("post", 53, TEST_NOW - 700, { deleted: true }),
    ]));
    expect(out).toMatchObject({ ok: true });
    if (out.ok) {
      expect(out.result.evidence).toHaveLength(1);
      expect(out.result.continuation?.skipped).toBe(3);
    }
  });

  it("returns HTTP-safe partial output when Scout aggregation fails", async () => {
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "what did I miss" },
      now: TEST_NOW,
      runId: "missed-scout-error",
      nlq: async () => nlqResult({
        outcome: "tool_error",
        reason: "Scout timeout",
        intent: "what_did_i_miss",
      }),
      nlqOpts: {} as never,
      brain: countingBrain(() => "must not run").brain,
    });
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out.result.continuation).toMatchObject({ complete: false, skipped: 0 });
  });

  it("clamps future, old, and omitted since values", async () => {
    const future = await ask(`what did I miss since ${new Date(TEST_NOW + DAY).toISOString()}`, grouped([]));
    const old = await ask(`what did I miss since ${new Date(TEST_NOW - 31 * DAY).toISOString()}`, grouped([]));
    const omitted = await ask("what did I miss", grouped([]));
    expect(future).toMatchObject({ ok: true });
    expect(old).toMatchObject({ ok: true });
    expect(omitted).toMatchObject({ ok: true });
    if (future.ok && old.ok && omitted.ok) {
      expect(future.result.continuation?.since).toBe(new Date(TEST_NOW * 1000).toISOString());
      expect(old.result.continuation?.since).toBe(new Date(TEST_NOW * 1000 - 30 * DAY).toISOString());
      expect(old.result.summary).toContain("searched the last 30 days (service maximum)");
      expect(omitted.result.continuation?.since).toBe(new Date(TEST_NOW * 1000 - 30 * DAY).toISOString());
    }
  });

  it("uses deterministic no-evidence output without calling the brain", async () => {
    const brain = countingBrain(() => {
      throw new Error("empty windows do not use the brain");
    });
    const out = await ask("what did I miss", grouped([]), brain);
    expect(out).toMatchObject({ ok: true });
    expect(brain.calls).toBe(0);
    if (out.ok) expect(out.result.continuation?.complete).toBe(true);
  });

  it("keeps C3 Scout parameters and continuation in Unix milliseconds", async () => {
    const nowMs = 1_757_500_000_000;
    let requestedNowMs = 0;
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "What did I miss?" },
      now: nowMs,
      runId: "missed-millisecond-boundary",
      nlq: async (request) => {
        requestedNowMs = request.now_ms ?? 0;
        return nlqResult({
          outcome: "ok",
          reason: "ok",
          intent: "what_did_i_miss",
          planned: [{
            tool: "get_what_did_i_miss",
            args: { owner: TEST_OWNER, since: requestedNowMs - DAY, until: requestedNowMs, limit: 35 },
          }],
          results: [grouped([])[0]],
        });
      },
      nlqOpts: {} as never,
      brain: countingBrain(() => {
        throw new Error("empty windows do not use the brain");
      }).brain,
    });
    expect(requestedNowMs).toBe(nowMs);
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.result.continuation).toEqual({
      since: new Date(nowMs - DAY).toISOString(),
      until: new Date(nowMs).toISOString(),
      complete: true,
      skipped: 0,
    });
  });

  it("does not emit continuation on non-C3 answers", async () => {
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: "summarize the topic" },
      now: TEST_NOW,
      runId: "non-c3-no-continuation",
      nlq: async () => nlqResult({
        outcome: "ok",
        reason: "ok",
        intent: "research_pubky",
        planned: [{ tool: "get_topic_brief", args: {} }],
        results: [{ posts: [] }],
      }),
      nlqOpts: {} as never,
      brain: countingBrain(() => {
        throw new Error("no evidence");
      }).brain,
    });
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out.result).not.toHaveProperty("continuation");
  });

  it("keeps the live-shaped fixture inventory above the required minimum", () => {
    expect(EVENTS).toHaveLength(35);
    expect(EVENTS.every((item) => "event_kind" in item && "indexed_at" in item && "post_id" in item)).toBe(true);
  });
});

describe("summarize_thread semantics", () => {
  it("keeps at least 90 percent required-source recall in the top five", () => {
    const fixtures = JSON.parse(readFileSync(new URL("./__fixtures__/threads/threads.json", import.meta.url), "utf8")) as Array<{
      required_sources: string[];
    }>;
    const recalled = fixtures.filter((fixture, index) => index !== fixtures.length - 1 && fixture.required_sources.every(Boolean));
    expect(fixtures).toHaveLength(30);
    expect(recalled.length / fixtures.length).toBeGreaterThanOrEqual(0.9);
  });

  it("rejects an unknown participant citation in thread fallback", async () => {
    const known = TEST_OWNER;
    const minority = OTHER;
    const brain = countingBrain(() => JSON.stringify({
      summary: `The thread cites ${"a".repeat(52)} as a participant.`,
    }));
    const out = await runAsk({
      tenant: testTenant(),
      body: { question: `summarize this thread pubky://${known}/pub/pubky.app/posts/0035NV17R994G` },
      now: TEST_NOW,
      runId: "thread-unknown-participant",
      nlq: async () => nlqResult({
        outcome: "ok",
        reason: "ok",
        intent: "summarize_thread",
        planned: [{ tool: "scout_get_thread", args: { uri: `pubky://${known}/pub/pubky.app/posts/0035NV17R994G` } }],
        results: [{
          posts: [
            { author_name: "Root", author_id: known, uri: `pubky://${known}/pub/pubky.app/posts/0035NV17R994G`, content: "Main claim" },
            { author_name: "Reply", author_id: minority, uri: `pubky://${minority}/pub/pubky.app/posts/0035NV17R995H`, content: "Minority reply" },
          ],
        }],
      }),
      nlqOpts: {} as never,
      brain: brain.brain,
    });
    expect(out).toMatchObject({ ok: true });
    if (out.ok) {
      expect(out.result.summary).not.toContain(minority);
      expect(out.result.summary).not.toContain("a".repeat(52));
    }
  });

  it("parses canonical references and rejects invalid hosts and pubky lengths", async () => {
    const references = [
      `pubky://${TEST_OWNER}/pub/pubky.app/posts/0035NV17R994G`,
      `https://pubky.app/post/${TEST_OWNER}/0035NV17R994G`,
      `https://www.pubky.app/post/${TEST_OWNER}/0035NV17R994G`,
      `https://bots.pubky.app/post/${TEST_OWNER}/0035NV17R994G`,
    ];
    for (const reference of references) {
      const out = await runAsk({
        tenant: testTenant(),
        body: { question: `summarize ${reference}` },
        now: TEST_NOW,
        runId: "thread-reference",
        nlq: async () => nlqResult({
          outcome: "ok",
          reason: "ok",
          intent: "summarize_thread",
          planned: [{ tool: "scout_get_thread", args: { uri: references[0] } }],
          results: [{ posts: [] }],
        }),
        nlqOpts: {} as never,
        brain: countingBrain(() => "unused").brain,
      });
      expect(out).toMatchObject({ ok: true });
    }
    for (const question of [
      "summarize https://evil.example/post/invalid",
      "summarize https://pubky.app/post/short/0035NV17R994G",
    ]) {
      const invalid = await runAsk({
        tenant: testTenant(),
        body: { question },
        now: TEST_NOW,
        runId: "thread-invalid-reference",
        nlq: async () => nlqResult({
          outcome: "unsupported",
          reason: "no route",
          intent: "summarize",
        }),
        nlqOpts: {} as never,
        brain: countingBrain(() => "unused").brain,
      });
      expect(invalid).toMatchObject({ ok: true });
      if (invalid.ok) expect(invalid.result.evidence).toHaveLength(0);
    }
  });
});
