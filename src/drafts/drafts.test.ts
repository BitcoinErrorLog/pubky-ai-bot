import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../db.js";
import { configFromProcessEnv } from "../config.js";
import { ScoutClient } from "../scout/client.js";
import { createScoutTools } from "../scout/tools.js";
import { startScoutStub } from "../scout/stub.js";
import { generateWhatChanged } from "./what-changed.js";
import { generateThreadWorthReading } from "./thread-worth-reading.js";
import { generateTheDisagreement } from "./the-disagreement.js";
import { generateNewConnection } from "./new-connection.js";
import { generatePubkyExplained } from "./pubky-explained.js";
import { generateReleaseRadar } from "./release-radar.js";
import { finishDraft, DraftRejectedError } from "./finish.js";
import { assertNoAutonomousDraftPublish } from "./no-autonomous.js";
import { approveDraftToPublishRequest } from "./publish-request.js";
import type { Config } from "../config.js";
import type { Draft } from "./types.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const USER = "1111111111111111111111111111111111111111111111111111";
const USERB = "2222222222222222222222222222222222222222222222222222";
const POST = "AAAAAAAAAAAAA";
const POSTB = "BBBBBBBBBBBBB";
const BOT = "o".repeat(52);

function cfg(over: Partial<Config> = {}): Config {
  process.env.DATABASE_URL ??= DB;
  return { ...configFromProcessEnv({ requireSecret: false }), scoutEnabled: true, scoutRawEnabled: true, ...over };
}

const postRow = {
  author_id: USER,
  post_id: POST,
  content: "homeserver session notes",
  indexed_at: Date.now(),
  score: 9,
  author_name: "a",
  claims: [{ label: "pubky", tagger: USERB }],
};

const debateRow = {
  label_a_on_b: "spec",
  label_b_on_a: "ship",
  root_author: USER,
  root_post_id: POST,
  author_a: USER,
  author_b: USERB,
  reply_id: POSTB,
};

function envelope(results: unknown[]) {
  return { results, count: results.length, truncated: false };
}

describe("draft generators", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
  });
  afterAll(async () => {
    await store.close();
  });

  it("rejects a draft with zero evidence URIs", () => {
    expect(() =>
      finishDraft({ format: "what_changed", body: "hello", uris: [], tool_trace: [] }),
    ).toThrow(DraftRejectedError);
  });

  it("what_changed requires evidence URIs from get_what_changed", async () => {
    const stub = await startScoutStub([{ status: 200, body: envelope([]) }]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    await expect(generateWhatChanged({ scout: tools, appUrl: "https://pubky.app" })).rejects.toBeInstanceOf(
      DraftRejectedError,
    );
    await new Promise<void>((r) => stub.server.close(() => r()));

    const stub2 = await startScoutStub([{ status: 200, body: envelope([postRow]) }]);
    const tools2 = createScoutTools({
      cfg: cfg({ scoutUrl: stub2.url }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub2.url }), store.pool),
    });
    const d = await generateWhatChanged({ scout: tools2, appUrl: "https://pubky.app" });
    expect(d.format).toBe("what_changed");
    expect(d.evidence.uris.length).toBeGreaterThanOrEqual(1);
    expect(d.body.length).toBeLessThanOrEqual(2000);
    expect(d.body).toMatch(/What changed/i);
    await new Promise<void>((r) => stub2.server.close(() => r()));
  });

  it("thread_worth_reading uses top_posts evidence", async () => {
    const stub = await startScoutStub([{ status: 200, body: envelope([postRow]) }]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    const d = await generateThreadWorthReading({ scout: tools, appUrl: "https://pubky.app" });
    expect(d.format).toBe("thread_worth_reading");
    expect(d.evidence.uris[0]).toContain(USER);
    await new Promise<void>((r) => stub.server.close(() => r()));
  });

  it("the_disagreement uses debate map URIs", async () => {
    const stub = await startScoutStub([{ status: 200, body: envelope([debateRow]) }]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    const d = await generateTheDisagreement({ scout: tools, appUrl: "https://pubky.app" });
    expect(d.format).toBe("the_disagreement");
    expect(d.evidence.uris.length).toBeGreaterThanOrEqual(1);
    expect(d.body).toMatch(/disagreement/i);
    await new Promise<void>((r) => stub.server.close(() => r()));
  });

  it("new_connection needs emerging topic plus posts", async () => {
    const stub = await startScoutStub([
      {
        match: (c, p) => c.includes("AS distinct_taggers") && Number(p.until) > Date.now() - 3 * 86400000,
        status: 200,
        body: envelope([{ label: "pkarr", distinct_taggers: 8, uses: 8 }]),
      },
      {
        match: (c) => c.includes("AS distinct_taggers"),
        status: 200,
        body: envelope([{ label: "pkarr", distinct_taggers: 1, uses: 1 }]),
      },
      {
        match: (c) => c.includes("CONTAINS toLower($q)"),
        status: 200,
        body: envelope([
          { author_id: USER, post_id: POST, content: "pkarr note", indexed_at: Date.now(), labels: ["pkarr"], taggers: [USER] },
          { author_id: USERB, post_id: POSTB, content: "pkarr two", indexed_at: Date.now(), labels: ["pkarr"], taggers: [USERB] },
        ]),
      },
      {
        status: 200,
        body: envelope([{ a_follows_b: true, b_follows_a: false, shared_taggers: 2 }]),
      },
    ]);
    const tools = createScoutTools({
      cfg: cfg({ scoutUrl: stub.url }),
      pool: store.pool,
      storeSwitchOn: async () => false,
      client: new ScoutClient(cfg({ scoutUrl: stub.url }), store.pool),
    });
    const d = await generateNewConnection({ scout: tools, appUrl: "https://pubky.app" });
    expect(d.format).toBe("new_connection");
    expect(d.evidence.uris.length).toBeGreaterThanOrEqual(1);
    await new Promise<void>((r) => stub.server.close(() => r()));
  });

  it("pubky_explained requires knowledge source URLs", async () => {
    await expect(
      generatePubkyExplained({ searchKnowledge: async () => ({ chunks: [{ content: "x", source_url: null }] }) }),
    ).rejects.toBeInstanceOf(DraftRejectedError);
    const d = await generatePubkyExplained({
      searchKnowledge: async () => ({
        chunks: [{ content: "A pubky is a public key identity.", source_url: "https://pubky.org/Glossary.md", status: "canonical" }],
      }),
    });
    expect(d.format).toBe("pubky_explained");
    expect(d.evidence.uris).toContain("https://pubky.org/Glossary.md");
  });

  it("release_radar cites sources and does not invent when nothing is new", async () => {
    const d = await generateReleaseRadar({
      nowMs: Date.parse("2026-09-04T00:00:00Z"),
      listReleases: async () => [
        {
          repo: "pubky/pubky-core",
          html_url: "https://github.com/pubky/pubky-core/releases",
          name: "old",
          tag_name: "v0.1.0",
          published_at: "2020-01-01T00:00:00Z",
        },
      ],
    });
    expect(d.format).toBe("release_radar");
    expect(d.body).toMatch(/no dated GitHub releases/i);
    expect(d.evidence.uris.length).toBeGreaterThanOrEqual(1);

    const fresh = await generateReleaseRadar({
      nowMs: Date.parse("2026-09-04T00:00:00Z"),
      listReleases: async () => [
        {
          repo: "pubky/pubky-core",
          html_url: "https://github.com/pubky/pubky-core/releases/tag/v9.9.9",
          name: "v9.9.9",
          tag_name: "v9.9.9",
          published_at: "2026-09-01T00:00:00Z",
        },
      ],
    });
    expect(fresh.body).toMatch(/v9\.9\.9/);
    expect(fresh.body).not.toMatch(/no dated GitHub releases/i);
  });
});

describe("draft storage and approval", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
    await store.pool.query("DELETE FROM drafts");
  });
  afterAll(async () => {
    await store.pool.query("DELETE FROM drafts");
    await store.close();
  });

  function sample(body: string): Draft {
    return {
      format: "what_changed",
      title: "What changed: pubky",
      body,
      evidence: { uris: [`pubky://${USER}/pub/pubky.app/posts/${POST}`], tool_trace: [{ tool: "t" }], voice_violations: [] },
      created_at: new Date().toISOString(),
    };
  }

  it("round-trips a draft row", async () => {
    const id = await store.insertDraft(sample("round trip body with a citation https://pubky.app/post/x/y"));
    const row = await store.getDraft(id);
    expect(row?.status).toBe("draft");
    expect(row?.format).toBe("what_changed");
    expect(row?.evidence.uris.length).toBe(1);
    const listed = await store.listDrafts("draft");
    expect(listed.some((d) => d.id === id)).toBe(true);
  });

  it("reject path records decided_by and reason", async () => {
    const id = await store.insertDraft(sample("reject me please with enough text"));
    const row = await store.rejectDraft(id, "alice", "off-voice");
    expect(row.status).toBe("rejected");
    expect(row.decided_by).toBe("alice");
    expect(row.reject_reason).toBe("off-voice");
  });

  it("approve enforces one proactive post per UTC day", async () => {
    const a = await store.insertDraft(sample("first approved proactive draft body"));
    const b = await store.insertDraft(sample("second approved proactive draft body"));
    const env = { JEB_PROACTIVE_MAX_PER_DAY: "1" };
    const first = await approveDraftToPublishRequest(store, { draftId: a, decidedBy: "bob", botPk: BOT, env });
    expect(first.draft.status).toBe("approved");
    expect(first.draft.decided_by).toBe("bob");
    expect(first.draft.proactive_utc_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.publishRequestId).toBeGreaterThan(0);
    const pub = await store.pool.query<{ standalone: boolean; categories: unknown }>(
      "SELECT standalone, categories FROM publish_requests WHERE id = $1",
      [first.publishRequestId],
    );
    expect(pub.rows[0]?.standalone).toBe(true);
    await expect(
      approveDraftToPublishRequest(store, { draftId: b, decidedBy: "bob", botPk: BOT, env }),
    ).rejects.toThrow(/daily cap/);
  });

  it("cannot mark published without approved decided_by", async () => {
    const id = await store.insertDraft(sample("still a draft"));
    await expect(store.markDraftPublished(id)).rejects.toThrow(/approved row with decided_by/);
  });

  it("no autonomous publish path in drafts modules", () => {
    expect(() => assertNoAutonomousDraftPublish()).not.toThrow();
  });
});
