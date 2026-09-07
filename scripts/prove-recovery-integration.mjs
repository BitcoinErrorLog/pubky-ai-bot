/**
 * Real-Postgres integration: seed W36-like rows, recoverLegacyWeeklyPost --apply,
 * claimPublish + publishOne through createRunPublishHooks (the runPublish loop
 * hooks). This is the test that catches P1-A (recovery row left queued).
 *
 * DATABASE_URL defaults to the local jeb_stage1_test database — never production.
 */
import assert from "node:assert/strict";
import pg from "pg";
import { recoverLegacyWeeklyPost } from "../.prove-emit/weekly/store.js";
import { JEB_PUBKY } from "../.prove-emit/weekly/types.js";
import { claimPublish, markPublishDone, markPublishFailed, markPublishRetry } from "../.prove-emit/bot-kit/publish/publish-store.js";
import { publishOne } from "../.prove-emit/bot-kit/publish/publisher.js";
import { createRunPublishHooks } from "../.prove-emit/publish.js";
import { standaloneMentionKey } from "../.prove-emit/bot-kit/publish/publisher.js";

const url = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
if (/railway|prod|production/i.test(url)) {
  throw new Error("refusing to run recovery integration against a production-looking DATABASE_URL");
}

const OLD_ID = "FFFFFFFFFFFFF";
const CONTENT = JSON.stringify({ title: "W36 prove", body: `prove-p1-a ${Date.now()}` });
const ORIGIN_KEY = standaloneMentionKey({ content: CONTENT, kind: "long" });
const OLD_URI = `pubky://${JEB_PUBKY}/pub/pubky.app/posts/${OLD_ID}`;

class FakeTransport {
  botPk = JEB_PUBKY;
  puts = 0;
  lastPath = "";
  async putBytes() {}
  async putJson(path) {
    this.puts += 1;
    this.lastPath = path;
  }
  async getJson() {
    return {};
  }
  async listPosts() {
    return [];
  }
  async reauth() {}
  async deleteJson() {}
}

const pool = new pg.Pool({ connectionString: url, max: 4 });
const noop = async () => undefined;

try {
  await pool.query("SELECT 1 FROM weekly_legacy_recoveries LIMIT 0");
} catch (e) {
  console.error("NO_DB_OR_MIGRATION", String(e.message).split("\n")[0]);
  await pool.end();
  process.exit(2);
}

await pool.query("DELETE FROM weekly_legacy_recoveries WHERE series = 'feedback' AND week_key = '2026-W36'");
await pool.query("DELETE FROM weekly_posts WHERE series = 'feedback' AND week_key = '2026-W36'");
await pool.query("DELETE FROM publish_requests WHERE mention_key = $1 OR mention_key LIKE $2", [
  ORIGIN_KEY,
  "weekly-recovery:%",
]);
await pool.query("DELETE FROM handled_mentions WHERE mention_key = $1 OR mention_key LIKE $2", [
  ORIGIN_KEY,
  "weekly-recovery:%",
]);

const ins = await pool.query(
  `INSERT INTO publish_requests
     (mention_key, parent_uri, content, evidence_id, categories, replace_post_id, standalone, post_kind, approved_by, status)
   VALUES ($1, $1, $2, NULL, '[]'::jsonb, $3, TRUE, 'long', 'weekly', 'published')
   RETURNING id`,
  [ORIGIN_KEY, CONTENT, OLD_ID],
);
const oldReqId = ins.rows[0].id;
await pool.query(
  `INSERT INTO handled_mentions (mention_key, status, author, bot_id, reply_uri)
   VALUES ($1, 'published', $2, $2, $3)
   ON CONFLICT (mention_key) DO UPDATE SET author = EXCLUDED.author, bot_id = EXCLUDED.bot_id, reply_uri = EXCLUDED.reply_uri, status = 'published'`,
  [ORIGIN_KEY, JEB_PUBKY, OLD_URI],
);
await pool.query(
  `INSERT INTO weekly_posts (series, week_key, post_uri, mention_key, status, tags)
   VALUES ('feedback', '2026-W36', $1, $2, 'published', '{}')`,
  [OLD_URI, ORIGIN_KEY],
);

const applied = await recoverLegacyWeeklyPost(pool, {
  series: "feedback",
  weekKey: "2026-W36",
  botPk: JEB_PUBKY,
  dryRun: false,
});
assert.equal(applied.status, "applied");
assert.match(applied.replacementUri, /\/posts\/[0-9A-HJKMNP-TV-Z]{13}$/);

const rec = await pool.query(
  `SELECT status, replacement_post_uri, replacement_mention_key FROM weekly_legacy_recoveries
   WHERE series = 'feedback' AND week_key = '2026-W36'`,
);
assert.equal(rec.rows[0].status, "queued");
assert.equal(rec.rows[0].replacement_post_uri, null);
const replacementKey = rec.rows[0].replacement_mention_key;

await pool.query(
  `UPDATE publish_requests SET next_attempt_at = now() + interval '7 days'
   WHERE status IN ('queued','retry') AND mention_key <> $1`,
  [replacementKey],
);

const store = {
  pool,
  ping: async () => true,
  migrate: noop,
  close: noop,
  switchOn: async (name) => name === "collections",
  setSwitch: noop,
  get: async () => ({
    status: "processing",
    reply_uri: null,
    root_uri: null,
    updated_at: new Date(),
    author: JEB_PUBKY,
    skip_reason: null,
    fallback_reason: null,
    notice_suppressed: false,
    quota_notice: null,
  }),
  mark: noop,
  insertPublishRequest: async () => false,
  getPublishRequestPostId: async () => null,
  claimPublish: (max) => claimPublish(pool, max),
  failExhaustedPublishes: async () => 0,
  failExhaustedArtifactTags: async () => 0,
  markPublishDone: (id) => markPublishDone(pool, id),
  markPublishRetry: (id, err, attempts) => markPublishRetry(pool, id, err, attempts),
  markPublishFailed: (id, err) => markPublishFailed(pool, id, err),
  markPublishFailedAuth: (id, err) => markPublishFailed(pool, id, err),
  markPublishScrubbed: noop,
  setPublishCategories: noop,
  clearFailFirst: noop,
  supersedePublishForReplace: noop,
  claimPendingTags: async () => null,
  markTagsDone: noop,
  markTagRetry: noop,
  insertArtifactTag: async () => true,
  claimPendingArtifactTag: async () => null,
  markArtifactTagDone: async () => 0,
  markArtifactTagRetry: noop,
  markArtifactTagDeferUnanswered: noop,
  markArtifactTagFailed: noop,
  getArtifactTag: async () => null,
  markArtifactTagRevoked: noop,
  mergeEvidencePhaseMs: noop,
  appendEvidenceSecurityEvents: noop,
  markLinkedDraftPublished: noop,
  markLinkedDraftDeclined: noop,
  upsertPublished: noop,
  botRepliedTo: async () => false,
};

const row = await store.claimPublish(5);
assert.ok(row, "claimPublish should return the recovery request");
assert.equal(row.mention_key, replacementKey);

const hooks = createRunPublishHooks(() => store);
const t = new FakeTransport();
await publishOne(store, t, { disabledEnv: false, maxPublishAttempts: 5 }, row, hooks);
assert.equal(t.puts, 1);

const after = await pool.query(
  `SELECT r.status AS rec_status, r.replacement_post_uri, w.post_uri, w.status AS weekly_status
     FROM weekly_legacy_recoveries r
     JOIN weekly_posts w ON w.series = r.series AND w.week_key = r.week_key
    WHERE r.series = 'feedback' AND r.week_key = '2026-W36'`,
);
assert.equal(after.rows[0].rec_status, "published", "P1-A: recovery must leave queued");
assert.ok(after.rows[0].replacement_post_uri, "P1-A: replacement_post_uri must be recorded");
assert.equal(after.rows[0].post_uri, after.rows[0].replacement_post_uri);
assert.notEqual(after.rows[0].post_uri, OLD_URI);
assert.equal(after.rows[0].weekly_status, "published");

await pool.query("DELETE FROM weekly_legacy_recoveries WHERE series = 'feedback' AND week_key = '2026-W36'");
await pool.query("DELETE FROM weekly_posts WHERE series = 'feedback' AND week_key = '2026-W36'");
await pool.query("DELETE FROM publish_requests WHERE id = $1 OR mention_key = $2", [oldReqId, replacementKey]);
await pool.query("DELETE FROM handled_mentions WHERE mention_key IN ($1, $2)", [ORIGIN_KEY, replacementKey]);
await pool.end();
console.log("PASS recovery integration via runPublish hooks", after.rows[0].replacement_post_uri);
