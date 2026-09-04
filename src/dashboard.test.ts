import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "./db.js";
import { dashboardJson, formatDashboardMarkdown, parseDashboardArgv, parseSince } from "./dashboard-report.js";
import { policySummary } from "./policy-summary.js";
import { collectDashboardFacts } from "./reporting.js";

const url = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const BOT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ASK_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ASK_B = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function uri(author: string, id: string): string {
  return `pubky://${author}/pub/pubky.app/posts/${id}`;
}

const keys = {
  pub1: uri(ASK_A, "DASHPUB000001"),
  pub2: uri(ASK_A, "DASHPUB000002"),
  skip: uri(ASK_B, "DASHSKIP00001"),
  fail: uri(ASK_B, "DASHFAIL00001"),
  proc: uri(ASK_A, "DASHPROC00001"),
  old: uri(ASK_B, "DASHOLD000001"),
};

const reply1 = uri(BOT, "DASHRPLY00001");
const reply2 = uri(BOT, "DASHRPLY00002");

let store: Store;

async function wipe(): Promise<void> {
  const list = Object.values(keys);
  await store.pool.query("DELETE FROM corrections WHERE mention_key = ANY($1::text[])", [list]);
  await store.pool.query("DELETE FROM token_usage WHERE mention_key = ANY($1::text[])", [list]);
  await store.pool.query("DELETE FROM scout_queries WHERE mention_key = ANY($1::text[])", [list]);
  await store.pool.query("DELETE FROM web_queries WHERE mention_key = ANY($1::text[])", [list]);
  await store.pool.query("DELETE FROM publish_requests WHERE mention_key = ANY($1::text[])", [list]);
  await store.pool.query("DELETE FROM evidence WHERE mention_key = ANY($1::text[])", [list]);
  await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = ANY($1::text[])", [list]);
}

describe("dashboard report", () => {
  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await wipe();
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const twoHours = new Date(now.getTime() - 7_200_000);
    const weekAgo = new Date(now.getTime() - 10 * 86_400_000);

    await store.pool.query(
      `INSERT INTO handled_mentions (mention_key, status, author, bot_id, reply_uri, root_uri, skip_reason, fallback_reason, created_at, updated_at)
       VALUES
         ($1, 'published', $7, $8, $11, $1, NULL, NULL, $9, $10),
         ($2, 'published', $7, $8, $12, $2, NULL, 'timeout', $9, $10),
         ($3, 'skipped', $13, $8, NULL, $3, 'thread_cap', NULL, $9, $9),
         ($4, 'failed', $13, $8, NULL, $4, NULL, NULL, $9, $9),
         ($5, 'processing', $7, $8, NULL, $5, NULL, NULL, $9, $9),
         ($6, 'published', $13, $8, NULL, $6, NULL, NULL, $14, $14)`,
      [
        keys.pub1,
        keys.pub2,
        keys.skip,
        keys.fail,
        keys.proc,
        keys.old,
        ASK_A,
        BOT,
        hourAgo,
        new Date(hourAgo.getTime() + 8_000),
        reply1,
        reply2,
        ASK_B,
        weekAgo,
      ],
    );

    await store.pool.query(
      `INSERT INTO publish_requests (mention_key, parent_uri, content, status, created_at, updated_at)
       VALUES
         ($1, $1, 'ok', 'published', $3, $4),
         ($2, $2, 'ok2', 'published', $3, $5)`,
      [keys.pub1, keys.pub2, hourAgo, new Date(hourAgo.getTime() + 4_000), new Date(hourAgo.getTime() + 12_000)],
    );

    await store.pool.query(
      `INSERT INTO evidence (mention_key, intent, tool_trace, sources, model, tokens)
       VALUES
         ($1, 'answer', $3::jsonb, '[]'::jsonb, 'gpt-4o-mini', 10),
         ($2, 'decline', '[]'::jsonb, '[]'::jsonb, 'gpt-4o-mini', 2)`,
      [
        keys.pub1,
        keys.pub2,
        JSON.stringify([
          { toolCalls: [{ name: "search_knowledge", args: {} }, { name: "search_web", args: {} }] },
          { toolCalls: [{ name: "search_posts", args: {} }] },
        ]),
      ],
    );

    await store.pool.query(
      `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, error_code, mention_key, created_at)
       VALUES ('search_posts', 'a', 'b', 0, false, 10, FALSE, 'TIMEOUT', $1, $2),
              ('search_posts', 'c', 'd', 1, false, 10, TRUE, NULL, $1, $2)`,
      [keys.pub1, hourAgo],
    );
    await store.pool.query(
      `INSERT INTO web_queries (provider, query_hash, ok, sources_count, duration_ms, mention_key, created_at)
       VALUES ('moonshot', 'h1', FALSE, 0, 20, $1, $2), ('moonshot', 'h2', TRUE, 2, 20, $1, $2)`,
      [keys.pub1, hourAgo],
    );

    await store.pool.query(
      `INSERT INTO token_usage (mention_key, public_key, phase, model, total_tokens, created_at)
       VALUES ($1, $3, 'answer', 'gpt-4o-mini', 100, $4),
              ($2, $3, 'answer', 'kimi-k3', 50, $4)`,
      [keys.pub1, keys.pub2, ASK_A, hourAgo],
    );

    await store.pool.query(
      `INSERT INTO corrections (reply_uri, mention_key, reason, corrected_by, created_at)
       VALUES ($1, $2, 'wrong product', 'ops', $3)`,
      [reply1, keys.pub1, hourAgo],
    );
  });

  afterAll(async () => {
    await wipe();
    await store.close();
  });

  it("parses --since and argv", () => {
    const w = parseSince("24h", new Date("2026-09-04T12:00:00.000Z"));
    expect(w.since.toISOString()).toBe("2026-09-03T12:00:00.000Z");
    expect(parseSince("7d", new Date("2026-09-08T00:00:00.000Z")).since.toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
    expect(parseSince("2026-01-01T00:00:00.000Z").since.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    const argv = parseDashboardArgv(["--since", "7d", "--json", "--markdown-file", "/tmp/d.md"]);
    expect(argv.json).toBe(true);
    expect(argv.sinceRaw).toBe("7d");
    expect(argv.markdownFile).toBe("/tmp/d.md");
  });

  it("counts each dashboard section from seeded rows", async () => {
    const window = parseSince("24h");
    const facts = await collectDashboardFacts(store.pool, window, 2_000_000, {
      mentionKeys: Object.values(keys),
    });
    expect(facts.mentionsReceived).toBe(5);
    expect(facts.published).toBe(2);
    expect(facts.failed).toBe(1);
    expect(facts.skippedByReason).toEqual([{ reason: "thread_cap", count: 1 }]);
    expect(facts.fallbackByReason).toEqual([{ reason: "timeout", count: 1 }]);
    expect(facts.latencyMs.sampleSize).toBe(2);
    expect(facts.latencyMs.p50).toBeCloseTo(8000, 6);
    expect(facts.latencyMs.p95).toBeCloseTo(11600, 6);
    expect(facts.toolUsage).toEqual([
      { tool: "search_knowledge", count: 1 },
      { tool: "search_posts", count: 1 },
      { tool: "search_web", count: 1 },
    ]);
    expect(facts.scoutFailures).toBe(1);
    expect(facts.webSearchFailures).toBe(1);
    expect(facts.tokenByModel).toEqual([
      { model: "gpt-4o-mini", totalTokens: 100 },
      { model: "kimi-k3", totalTokens: 50 },
    ]);
    expect(facts.tokenByDay).toHaveLength(1);
    expect(facts.tokenByDay[0]?.totalTokens).toBe(150);
    expect(facts.dailyTokenBudget).toBe(2_000_000);
    expect(facts.todayGlobalTokens).toBe(150);
    expect(facts.topSpendersToday).toEqual([{ publicKey: ASK_A, totalTokens: 150 }]);
    expect(facts.securityDeclinedReplies).toBe(1);
    expect(facts.securityNote).toMatch(/No security_event/);
    expect(facts.killSwitch.switches.some((s) => s.name === "replies")).toBe(true);
    expect(facts.topAskers).toEqual([
      { author: ASK_A, count: 3 },
      { author: ASK_B, count: 2 },
    ]);
    expect(facts.corrections).toHaveLength(1);
    expect(facts.corrections[0]?.reason).toBe("wrong product");

    const md = formatDashboardMarkdown(
      facts,
      policySummary({
        maxRepliesPerThread: 12,
        maxTurnsPerUserPerThread: 6,
        maxPerUserPerHour: 5,
        dailyTokenBudget: 2_000_000,
        userDailyTokenBudget: 600_000,
        modelTimeoutMs: 30_000,
        answerBudgetMs: 180_000,
        replyDeadlineMs: 240_000,
        pollMs: 3_000,
        knownBots: new Set(),
        blocklist: new Set(),
      }),
    );
    expect(md).toContain("Jeb evidence dashboard");
    expect(md).toContain("thread_cap");
    expect(md).toContain("Top spenders today");
    expect(md).toContain("User opt-outs");
    expect(facts.activeOptouts).toBeGreaterThanOrEqual(0);
    const json = dashboardJson(facts, policySummary({
      maxRepliesPerThread: 12,
      maxTurnsPerUserPerThread: 6,
      maxPerUserPerHour: 5,
      dailyTokenBudget: 2_000_000,
      userDailyTokenBudget: 600_000,
      modelTimeoutMs: 30_000,
      answerBudgetMs: 180_000,
      replyDeadlineMs: 240_000,
      pollMs: 3_000,
      knownBots: new Set(),
      blocklist: new Set(),
    }));
    expect(json).toMatchObject({ mentionsReceived: facts.mentionsReceived, published: facts.published });
  });
});
