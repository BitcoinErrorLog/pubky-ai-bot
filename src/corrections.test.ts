import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { Store } from "./db.js";
import {
  correctionToEvalQuestion,
  exportUnexportedCorrections,
  insertCorrection,
  parseCorrectArgv,
} from "./corrections.js";
import { parsePostUri } from "./types.js";

const url = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const BOT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const USER = "cccccccccccccccccccccccccccccccccccccccccccccccccccc";

function uri(author: string, id: string): string {
  return `pubky://${author}/pub/pubky.app/posts/${id}`;
}

const mention = uri(USER, "CORRMENT00001");
const reply = uri(BOT, "CORRREPLY0001");
const otherReply = uri(USER, "NOTBOTREPLY01");

let store: Store;

describe("corrections", () => {
  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [mention]);
    expect(await store.claim(mention, USER, BOT)).toBe("claimed");
    await store.mark(mention, "published", { replyUri: reply, rootUri: mention });
  });
  afterAll(async () => {
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key = $1", [mention]);
    await store.close();
  });

  it("parses argv", () => {
    const a = parseCorrectArgv([
      "--reply",
      reply,
      "--reason",
      "wrong homeserver claim",
      "--by",
      "ops",
      "--correct-answer",
      "Homeserver is pkarr + HTTP",
    ]);
    expect(a.reply).toBe(reply);
    expect(a.reason).toBe("wrong homeserver claim");
    expect(a.by).toBe("ops");
    expect(a.correctAnswer).toBe("Homeserver is pkarr + HTTP");
  });

  it("rejects a reply that is not the bot", async () => {
    await expect(
      insertCorrection(store.pool, BOT, {
        replyUri: otherReply,
        reason: "nope",
        correctedBy: "ops",
      }),
    ).rejects.toThrow(/JEB_BOT_PK/);
  });

  it("rejects a bot reply that is not in handled_mentions", async () => {
    await expect(
      insertCorrection(store.pool, BOT, {
        replyUri: uri(BOT, "MISSINGREPLY1"),
        reason: "nope",
        correctedBy: "ops",
      }),
    ).rejects.toThrow(/handled_mentions/);
  });

  it("inserts a correction without editing mention history", async () => {
    const row = await insertCorrection(store.pool, BOT, {
      replyUri: reply,
      reason: "said Ring is a homeserver",
      correctedBy: "alice",
      correctAnswer: "Ring is the signer app, not the homeserver.",
    });
    expect(row.mention_key).toBe(mention);
    expect(row.reply_uri).toBe(reply);
    expect(row.exported_at).toBeNull();
    const before = await store.get(mention);
    expect(before?.status).toBe("published");
    expect(before?.reply_uri).toBe(reply);
    parsePostUri(row.reply_uri);
  });

  it("exports unexported rows as eval YAML and marks exported_at", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jeb-corr-"));
    const first = await exportUnexportedCorrections(store.pool, dir, async () => "What is Pubky Ring used for?");
    expect(first.exportedIds.length).toBeGreaterThanOrEqual(1);
    const yamlPath = first.files[0];
    expect(yamlPath).toBeDefined();
    const parsed = parseYaml(readFileSync(yamlPath!, "utf8")) as { questions: unknown[] };
    expect(parsed.questions).toHaveLength(1);
    const q = parsed.questions[0] as { id: string; category: string; question: string };
    expect(q.category).toBe("cross-product");
    expect(q.question).toContain("Ring");
    const row = await store.pool.query<{ exported_at: Date | null }>(
      "SELECT exported_at FROM corrections WHERE id = $1",
      [first.exportedIds[0]],
    );
    expect(row.rows[0]?.exported_at).toBeTruthy();
    const second = await exportUnexportedCorrections(store.pool, dir, async () => {
      throw new Error("should not fetch");
    });
    expect(second.exportedIds).toEqual([]);
  });

  it("maps a correction to an eval question schema", () => {
    const item = correctionToEvalQuestion(
      {
        id: 9,
        reply_uri: reply,
        mention_key: mention,
        reason: "stale",
        corrected_by: "ops",
        correct_answer: "Pkarr publishes records.",
        created_at: new Date(),
        exported_at: null,
      },
      "How does pkarr work on Pubky?",
    );
    expect(item.id).toBe("corr-9");
    expect(item.expected_claims).toEqual(["Pkarr publishes records."]);
    expect(item.unknown_is_correct).toBe(false);
  });
});
