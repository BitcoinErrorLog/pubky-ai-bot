import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../db.js";
import { configFromProcessEnv } from "../config.js";
import { generateNewConnection } from "./new-connection.js";
import { generatePubkyExplained } from "./pubky-explained.js";
import { generateReleaseRadar } from "./release-radar.js";
import { finishDraft, DraftRejectedError, evidenceHref, sanitizeDraftLabel, sanitizeUntrustedDraftText } from "./finish.js";
import { postLink, type ScoutTools } from "./scout-util.js";
import { assertNoAutonomousDraftPublish } from "./no-autonomous.js";
import { approveDraftToPublishRequest } from "./publish-request.js";
import { collectDraftStats } from "./stats.js";
import { publishOne } from "../publish.js";
import type { Config } from "../config.js";
import type { Draft } from "./types.js";
import type { Transport } from "../homeserver.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_formats_test";
const USER = "1111111111111111111111111111111111111111111111111111";
const POST = "AAAAAAAAAAAAA";

class FakeTransport implements Transport {
  botPk = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  puts = 0;
  lastPath = "";
  private posts: Array<{ parent?: string; uri: string }> = [];

  async putBytes(): Promise<void> {}

  async putJson(_path: string, json: unknown): Promise<void> {
    this.puts += 1;
    this.lastPath = _path;
    const parent =
      typeof json === "object" && json && "parent" in json ? String((json as { parent?: string }).parent) : undefined;
    const id = _path.split("/").pop() ?? "0000000000001";
    const uri = `pubky://${this.botPk}/pub/pubky.app/posts/${id}`;
    const rec = { parent, uri };
    const i = this.posts.findIndex((p) => p.uri === uri);
    if (i >= 0) this.posts[i] = rec;
    else this.posts.push(rec);
  }

  async getJson(): Promise<unknown> {
    return { content: "ok" };
  }

  async listPosts(): Promise<Array<{ parent?: string; uri: string }>> {
    return this.posts;
  }

  async reauth(): Promise<void> {}
  async deleteJson(): Promise<void> {}
}

function cfg(over: Partial<Config> = {}): Config {
  process.env.DATABASE_URL ??= DB;
  return { ...configFromProcessEnv({ requireSecret: false }), scoutEnabled: true, scoutRawEnabled: true, ...over };
}

describe("draft generators", () => {
  it("rejects a draft with zero evidence URIs", () => {
    expect(() =>
      finishDraft({ format: "what_changed", body: "hello", uris: [], tool_trace: [] }),
    ).toThrow(DraftRejectedError);
  });

  it("pubky_explained rejects chunks that have no source URL", async () => {
    await expect(
      generatePubkyExplained({
        questions: [{ uri: "https://pubky.app/post/x/y", content: "what is a pubky?" }],
        searchKnowledge: async () => ({ chunks: [{ content: "x", source_url: null }] }),
        complete: async () => "should not run",
      }),
    ).rejects.toBeInstanceOf(DraftRejectedError);
  });

  it("release_radar returns none instead of inventing a changelog", async () => {
    await expect(
      generateReleaseRadar({
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
        complete: async () => "should not run",
      }),
    ).rejects.toThrow(/none:/);
  });
});

describe("draft storage and approval", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
    await store.pool.query("DELETE FROM drafts");
    await store.pool.query("DELETE FROM publish_requests WHERE standalone = true");
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

  it("approve enqueues via enqueueStandalonePost; publisher marks draft published; cap refuses a second approve", async () => {
    const a = await store.insertDraft(sample("first approved proactive draft body"));
    const b = await store.insertDraft(sample("second approved proactive draft body"));
    const env = { JEB_PROACTIVE_MAX_PER_DAY: "1" };
    const first = await approveDraftToPublishRequest(store, { draftId: a, decidedBy: "bob", env });
    expect(first.draft.status).toBe("approved");
    expect(first.draft.decided_by).toBe("bob");
    expect(first.draft.publish_request_id).toBe(first.publishRequestId);
    expect(first.draft.proactive_utc_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(first.publishRequestId).toBeGreaterThan(0);
    const pub = await store.pool.query<{
      standalone: boolean;
      post_kind: string | null;
      approved_by: string | null;
      replace_post_id: string | null;
    }>("SELECT standalone, post_kind, approved_by, replace_post_id FROM publish_requests WHERE id = $1", [
      first.publishRequestId,
    ]);
    expect(pub.rows[0]?.standalone).toBe(true);
    expect(pub.rows[0]?.post_kind).toBe("short");
    expect(pub.rows[0]?.approved_by).toBe("bob");
    expect(pub.rows[0]?.replace_post_id).toBe(first.postId);

    await store.pool.query(
      `UPDATE publish_requests SET status = 'failed'
       WHERE status IN ('queued', 'retry', 'publishing') AND id <> $1`,
      [first.publishRequestId],
    );
    const t = new FakeTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(first.publishRequestId);
    await publishOne(store, t, { disabledEnv: false, maxPublishAttempts: 5 } as Config, row!);
    expect(t.puts).toBe(1);
    expect(t.lastPath).toBe(`/pub/pubky.app/posts/${first.postId}`);
    const published = await store.getDraft(a);
    expect(published?.status).toBe("published");

    await expect(
      approveDraftToPublishRequest(store, { draftId: b, decidedBy: "bob", env }),
    ).rejects.toThrow(/daily cap/);
  });

  it("cannot mark published without approved decided_by", async () => {
    const id = await store.insertDraft(sample("still a draft"));
    await expect(store.markDraftPublished(id)).rejects.toThrow(/approved row with decided_by/);
  });

  it("no autonomous publish path in drafts modules", () => {
    expect(() => assertNoAutonomousDraftPublish()).not.toThrow();
  });

  it("concurrent approves of different drafts on the same UTC day: exactly one succeeds", async () => {
    await store.pool.query("DELETE FROM drafts");
    const a = await store.insertDraft(sample("concurrent approve body alpha unique"));
    const b = await store.insertDraft(sample("concurrent approve body beta unique"));
    const env = { JEB_PROACTIVE_MAX_PER_DAY: "1" };
    const settled = await Promise.all([
      approveDraftToPublishRequest(store, { draftId: a, decidedBy: "c1", env }).then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e }),
      ),
      approveDraftToPublishRequest(store, { draftId: b, decidedBy: "c2", env }).then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e }),
      ),
    ]);
    const wins = settled.filter((r) => r.ok);
    const losses = settled.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    const err = losses[0] && !losses[0].ok ? losses[0].e : null;
    expect(String(err instanceof Error ? err.message : err)).toMatch(/daily cap/);
  });

  it("approve of identical content rolls back instead of linking the existing request", async () => {
    await store.pool.query("DELETE FROM drafts");
    const body = "identical twin draft body for enqueue dedupe";
    const a = await store.insertDraft(sample(body));
    const b = await store.insertDraft(sample(body));
    const env = { JEB_PROACTIVE_MAX_PER_DAY: "2" };
    const first = await approveDraftToPublishRequest(store, { draftId: a, decidedBy: "bob", env });
    await expect(approveDraftToPublishRequest(store, { draftId: b, decidedBy: "bob", env })).rejects.toThrow(
      new RegExp(`identical content already queued/published as request #${first.publishRequestId}`),
    );
    const still = await store.getDraft(b);
    expect(still?.status).toBe("draft");
    expect(still?.publish_request_id).toBeNull();
  });

  it("outbound-gate decline marks the linked draft declined and excludes it from reception stats", async () => {
    await store.pool.query("DELETE FROM drafts");
    const bait = "sk-jebdraftoutboundgatebait99";
    const id = await store.insertDraft(sample(`proactive draft that embeds ${bait} for the outbound gate`));
    const env = { JEB_PROACTIVE_MAX_PER_DAY: "1" };
    const approved = await approveDraftToPublishRequest(store, { draftId: id, decidedBy: "bob", env });
    await store.pool.query(
      `UPDATE publish_requests SET status = 'failed'
       WHERE status IN ('queued', 'retry', 'publishing') AND id <> $1`,
      [approved.publishRequestId],
    );
    const t = new FakeTransport();
    const row = await store.claimPublish(5);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(approved.publishRequestId);
    await publishOne(store, t, { disabledEnv: false, maxPublishAttempts: 5 } as Config, row!);
    expect(t.puts).toBe(1);
    const declined = await store.getDraft(id);
    expect(declined?.status).toBe("declined");
    const stats = await collectDraftStats(store, { nexusUrl: "http://127.0.0.1:9", timeoutMs: 50 });
    const rowStats = stats.find((s) => s.format === "what_changed");
    expect(rowStats?.published).toBe(0);
    expect(rowStats?.declined).toBe(1);
    expect(rowStats?.reception).toEqual({ replies: 0, reposts: 0, bookmarks: 0, tags: 0 });
  });

  it("approve stamps format self-tags onto the standalone publish request", async () => {
    await store.pool.query("DELETE FROM drafts");
    await store.pool.query("DELETE FROM publish_requests WHERE standalone = true");
    const id = await store.insertDraft({
      format: "pubky_explained",
      title: "explained",
      body: "A pubky is a public key identity used as an address.",
      evidence: { uris: ["https://pubky.org/Glossary.md"], tool_trace: [], voice_violations: [] },
      created_at: new Date().toISOString(),
    });
    const approved = await approveDraftToPublishRequest(store, {
      draftId: id,
      decidedBy: "bob",
      env: { JEB_PROACTIVE_MAX_PER_DAY: "1" },
    });
    const row = await store.pool.query<{ categories: unknown }>(
      "SELECT categories FROM publish_requests WHERE id = $1",
      [approved.publishRequestId],
    );
    const cats = row.rows[0]?.categories;
    expect(cats).toEqual(["pubky-explained"]);
  });
});

describe("drafts render CLI", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
  });
  afterAll(async () => {
    await store.close();
  });

  it("writes a standalone markdown file with format, date, and evidence", async () => {
    const id = await store.insertDraft({
      format: "release_radar",
      title: "radar",
      body: "No dated GitHub releases this week.",
      evidence: { uris: ["https://github.com/pubky/pubky-core/releases"], tool_trace: [], voice_violations: [] },
      created_at: new Date().toISOString(),
    });
    const out = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const dir = out.mkdtempSync(path.join(os.tmpdir(), "jeb-drafts-"));
    const { runDraftsRole } = await import("./cli.js");
    const result = await runDraftsRole(cfg(), ["node", "main.js", "--role", "drafts", "render", "--id", String(id), "--out", dir]);
    expect(result.ok).toBe(true);
    const written = result.lines.filter((l) => l.endsWith(".md"));
    expect(written.length).toBe(1);
    const text = out.readFileSync(written[0]!, "utf8");
    expect(text).toContain("format: release_radar");
    expect(text).toContain("https://github.com/pubky/pubky-core/releases");
    expect(text).toContain("No dated GitHub releases this week.");
    await store.pool.query("DELETE FROM drafts WHERE id = $1", [id]);
  });
});

describe("draft finish sanitizer", () => {
  const ev = `pubky://${USER}/pub/pubky.app/posts/${POST}`;
  const evHref = `https://pubky.app/post/${USER}/${POST}`;
  const attacker = "z".repeat(52);
  const fakeUri = `pubky://${attacker}/pub/pubky.app/posts/CCCCCCCCCCCCC`;

  it("neutralizes a markdown phishing preview and drops unknown http citations", () => {
    const d = finishDraft({
      format: "what_changed",
      body: `Preview: [docs](https://phish.example) https://evil.example/one https://evil.example/two https://evil.example/three`,
      uris: [ev],
      tool_trace: [],
      skipQuality: true,
    });
    expect(d.body).not.toMatch(/\[docs\]\(/);
    expect(d.body).not.toContain("https://phish.example");
    expect(d.body).not.toContain("https://evil.example");
    expect(d.evidence.uris).toContain(ev);
  });

  it("collapses a newline-bearing label so it cannot inject a list item", () => {
    expect(sanitizeDraftLabel("spec\n- injected")).toBe("spec-injected");
    expect(sanitizeUntrustedDraftText("foo\n- injected item")).toBe("foo - injected item");
    expect(sanitizeUntrustedDraftText("foo\n- injected item")).not.toContain("\n");
    const d = finishDraft({
      format: "the_disagreement",
      title: "The disagreement: pubky\n- fake title item",
      body: `- Label "${sanitizeDraftLabel("spec\n- injected")}" — 3 authors`,
      uris: [ev],
      tool_trace: [],
      skipQuality: true,
    });
    expect(d.body).not.toMatch(/^\s*- injected/m);
    expect(d.title).toBeDefined();
    expect(d.title).not.toContain("\n");
  });

  it("strips a fake pubky:// post URI in a preview so rewritePubkyCitations cannot promote it", () => {
    const d = finishDraft({
      format: "thread_worth_reading",
      body: `Preview: see ${fakeUri} for the real writeup`,
      uris: [ev],
      tool_trace: [],
      skipQuality: true,
    });
    expect(d.body).not.toContain(fakeUri);
    expect(d.body).not.toContain(`https://pubky.app/post/${attacker}`);
    expect(d.evidence.uris).toContain(ev);
  });

  it("strips a zero-width-split pk so rewritePubkyCitations cannot promote it", () => {
    const mid = Math.floor(attacker.length / 2);
    const split = `${attacker.slice(0, mid)}\u200B${attacker.slice(mid)}`;
    expect(sanitizeUntrustedDraftText(`see ${split}`)).toBe("see");
    expect(sanitizeUntrustedDraftText(`see ${split}`)).not.toContain(attacker);
    expect(sanitizeUntrustedDraftText(`see ${split}`)).not.toContain("\u200B");
  });

  it("strips percent-encoded pubky%3A scheme variants", () => {
    const encoded = `pubky%3A//${attacker}/pub/pubky.app/posts/CCCCCCCCCCCCC`;
    expect(sanitizeUntrustedDraftText(`see ${encoded}`)).toBe("see");
    expect(sanitizeUntrustedDraftText(`see ${encoded}`)).not.toContain("pubky%3A");
    expect(sanitizeUntrustedDraftText(`see ${encoded}`)).not.toContain(attacker);
  });

  it("drops http URLs wrapped in fullwidth brackets", () => {
    const fw = "see ［docs］（https://evil.example/phish）";
    expect(sanitizeUntrustedDraftText(fw)).not.toContain("evil.example");
    expect(sanitizeUntrustedDraftText(fw)).not.toContain("https://");
  });

  it("drops bare www.evil.example alongside http", () => {
    expect(sanitizeUntrustedDraftText("visit www.evil.example/phish now")).toBe("visit now");
    expect(sanitizeUntrustedDraftText("visit www.evil.example/phish now")).not.toContain("www.evil.example");
  });

  it("does not prepend evidence URLs and refuses javascript hrefs", () => {
    expect(evidenceHref("javascript:alert(1)")).toBe("");
    expect(evidenceHref("https://github.com/pubky/pubky-core/releases/tag/v1")).toBe(
      "https://github.com/pubky/pubky-core/releases/tag/v1",
    );
    const d = finishDraft({
      format: "what_changed",
      body: "Graph summary with no attacker URL.",
      uris: ["https://evil.example/not-pubky", ev],
      tool_trace: [],
      skipQuality: true,
    });
    expect(d.body).not.toContain("evil.example");
    expect(d.body).not.toContain(evHref);
    expect(d.body).toContain("Graph summary");
  });

  it("postLink returns empty on pattern mismatch", () => {
    expect(postLink("https://evil.example/not-pubky", "https://pubky.app")).toBe("");
    expect(postLink("pubky://not-a-valid-uri", "https://pubky.app")).toBe("");
    expect(postLink(ev, "https://pubky.app")).toBe(evHref);
  });

  it("rejects author ids that are not 52-char pks before profileAppUrl", async () => {
    const scout = {
      get_emerging_topics: { execute: async () => ({ topics: [{ label: "pkarr", delta: 1, distinct_taggers: 2 }] }) },
      search_posts: {
        execute: async () => ({
          posts: [
            { author_id: "not-a-pk", uri: ev, post_id: POST },
            { author_id: USER, uri: ev, post_id: POST },
          ],
        }),
      },
      get_relationship: { execute: async () => ({ a_follows_b: false, b_follows_a: false, shared_taggers: 0 }) },
    } as unknown as ScoutTools;
    await expect(generateNewConnection({ scout, appUrl: "https://pubky.app" })).rejects.toThrow(/need two authors/);
  });

  it("sanitizes first.status in pubky_explained before the model sees it", async () => {
    let prompt = "";
    const d = await generatePubkyExplained({
      questions: [{ uri: ev, content: "what is a pubky?" }],
      searchKnowledge: async () => ({
        chunks: [
          {
            content: "A pubky is a public key identity.",
            source_url: "https://pubky.org/Glossary.md",
            status: "canonical\n- injected [phish](https://evil.example) www.evil.example",
          },
        ],
      }),
      complete: async (p) => {
        prompt = p;
        return [
          "A pubky is a public key used as an account name, not a display handle you can collide.",
          "The homeserver stores public records at that name so others can resolve it without a directory.",
          "Status is canonical for the identity mechanism itself.",
          "Sources: https://pubky.org/Glossary.md",
        ].join("\n\n");
      },
    });
    expect(prompt).not.toContain("https://evil.example");
    expect(prompt).not.toContain("www.evil.example");
    expect(prompt).not.toContain("- injected [phish]");
    expect(d.body).not.toContain("https://evil.example");
    expect(d.body).toContain("https://pubky.org/Glossary.md");
  });
});
