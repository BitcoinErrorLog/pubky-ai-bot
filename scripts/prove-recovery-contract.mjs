/**
 * Contract proofs for recoverLegacyWeeklyPost check order / published status.
 * Run: node --experimental-strip-types --import ./scripts/register-shims.mjs scripts/prove-recovery-contract.mjs
 */
import assert from "node:assert/strict";
import { recoverLegacyWeeklyPost } from "../.prove-emit/weekly/store.js";
import { JEB_PUBKY } from "../.prove-emit/weekly/types.js";

const oldId = "FFFFFFFFFFFFF";
const oldUri = `pubky://${JEB_PUBKY}/pub/pubky.app/posts/${oldId}`;
const mentionKey = "standalone:old";

function fakePool(opts) {
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("FROM weekly_posts")) {
        return { rows: [{ post_uri: opts.uri, mention_key: mentionKey, status: opts.status }] };
      }
      if (sql.includes("FROM weekly_legacy_recoveries")) {
        return opts.recovery ? { rows: [{ replacement_post_uri: opts.recovery }] } : { rows: [] };
      }
      if (sql.includes("FROM publish_requests")) {
        return {
          rows: [{
            id: "7",
            content: JSON.stringify({ title: "W36", body: "body" }),
            approved_by: "weekly",
            standalone: true,
            post_kind: "long",
            replace_post_id: oldId,
          }],
        };
      }
      if (sql.includes("FROM handled_mentions")) return { rows: [{ author: JEB_PUBKY, bot_id: JEB_PUBKY }] };
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  return { connect: async () => client, query: client.query, queries };
}

{
  const recoveredUri = `pubky://${JEB_PUBKY}/pub/pubky.app/posts/0035N8NR4ATE0`;
  const db = fakePool({ uri: recoveredUri, status: "published", recovery: recoveredUri });
  const result = await recoverLegacyWeeklyPost(db, {
    series: "feedback",
    weekKey: "2026-W36",
    botPk: JEB_PUBKY,
    dryRun: false,
  });
  assert.equal(result.status, "already-recovered");
  console.log("PASS already-recovered after successful replacement URI");
}

{
  const db = fakePool({ uri: oldUri, status: "queued", recovery: null });
  await assert.rejects(
    () => recoverLegacyWeeklyPost(db, { series: "feedback", weekKey: "2026-W36", botPk: JEB_PUBKY, dryRun: false }),
    /must be published/,
  );
  console.log("PASS queued weekly row rejected");
}
