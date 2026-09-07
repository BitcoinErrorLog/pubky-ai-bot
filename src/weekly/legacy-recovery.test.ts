import { describe, expect, it } from "vitest";
import { markWeeklyRecoveryPublished, recoverLegacyWeeklyPost } from "./store.js";
import { JEB_PUBKY } from "./types.js";

const oldId = "FFFFFFFFFFFFF";
const oldUri = `pubky://${JEB_PUBKY}/pub/pubky.app/posts/${oldId}`;
const mentionKey = "standalone:old";

function fakeDb(
  uri = oldUri,
  opts?: { status?: string; recoveredUri?: string | null; alreadyRecovered?: boolean },
) {
  let applied = opts?.alreadyRecovered === true;
  const queries: string[] = [];
  const weeklyStatus = opts?.status ?? "published";
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("FROM weekly_posts")) {
        return { rows: [{ post_uri: uri, mention_key: mentionKey, status: weeklyStatus }] };
      }
      if (sql.includes("FROM publish_requests WHERE mention_key")) {
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
      if (sql.includes("FROM weekly_legacy_recoveries")) {
        if (applied || opts?.alreadyRecovered) {
          return { rows: [{ replacement_post_uri: opts?.recoveredUri ?? null }] };
        }
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO weekly_legacy_recoveries")) {
        applied = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => undefined,
  };
  return {
    queries,
    db: { connect: async () => client, query: client.query },
  };
}

describe("legacy weekly recovery", () => {
  it("rejects a non-legacy URI before creating a recovery", async () => {
    const fake = fakeDb(oldUri.replace(oldId, "not-a-post-id"));
    const result = fake.db;
    await expect(recoverLegacyWeeklyPost(result as never, {
      series: "feedback",
      weekKey: "2026-W36",
      botPk: JEB_PUBKY,
      dryRun: false,
    })).rejects.toThrow(/legacy hexadecimal/);
    expect(fake.queries.some((q) => q.startsWith("INSERT INTO"))).toBe(false);
  });

  it("dry-run rolls back without inserts", async () => {
    const fake = fakeDb();
    const result = await recoverLegacyWeeklyPost(fake.db as never, {
      series: "feedback",
      weekKey: "2026-W36",
      botPk: JEB_PUBKY,
      dryRun: true,
    });
    expect(result.status).toBe("dry-run");
    expect(fake.queries.some((q) => q.startsWith("INSERT INTO"))).toBe(false);
  });

  it("apply is exactly once and repeat is a no-op", async () => {
    const fake = fakeDb();
    const first = await recoverLegacyWeeklyPost(fake.db as never, {
      series: "feedback",
      weekKey: "2026-W36",
      botPk: JEB_PUBKY,
      dryRun: false,
    });
    const second = await recoverLegacyWeeklyPost(fake.db as never, {
      series: "feedback",
      weekKey: "2026-W36",
      botPk: JEB_PUBKY,
      dryRun: false,
    });
    expect(first.status).toBe("applied");
    expect(second.status).toBe("already-recovered");
    expect(fake.queries.filter((q) => q.startsWith("INSERT INTO weekly_legacy")).length).toBe(1);
  });

  it("repeat after a successful recovery reports already-recovered even when the weekly URI is no longer hex", async () => {
    const recoveredId = "0035N8NR4ATE0";
    const recoveredUri = `pubky://${JEB_PUBKY}/pub/pubky.app/posts/${recoveredId}`;
    const fake = fakeDb(recoveredUri, { alreadyRecovered: true, recoveredUri });
    const result = await recoverLegacyWeeklyPost(fake.db as never, {
      series: "feedback",
      weekKey: "2026-W36",
      botPk: JEB_PUBKY,
      dryRun: false,
    });
    expect(result.status).toBe("already-recovered");
  });

  it("rejects a queued weekly row that was never published", async () => {
    const fake = fakeDb(oldUri, { status: "queued" });
    await expect(
      recoverLegacyWeeklyPost(fake.db as never, {
        series: "feedback",
        weekKey: "2026-W36",
        botPk: JEB_PUBKY,
        dryRun: false,
      }),
    ).rejects.toThrow(/must be published/);
  });

  it("links the actual replacement URI on successful completion", async () => {
    const fake = fakeDb();
    const uri = `pubky://${JEB_PUBKY}/pub/pubky.app/posts/0035N8NR4ATE0`;
    await markWeeklyRecoveryPublished(fake.db as never, "weekly-recovery:key", uri);
    expect(fake.queries[0]).toContain("UPDATE weekly_legacy_recoveries");
    expect(fake.queries[0]).toContain("UPDATE weekly_posts");
  });
});
