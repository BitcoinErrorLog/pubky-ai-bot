import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyAnswerFailure,
  FALLBACK_CLASSES,
  fallbackReply,
  inferFallbackContext,
} from "./fallback.js";
import { lintVoice } from "./voice.js";
import { Store } from "./db.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

describe("fallback templates", () => {
  for (const reason of FALLBACK_CLASSES) {
    it(`${reason} passes the voice linter`, () => {
      const text = fallbackReply(reason, inferFallbackContext("based on my social graph, who should I follow?"));
      const linted = lintVoice(text);
      expect(linted.violations).toEqual([]);
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/great question|as an ai|i hope this helps|happy to help/i);
    });
  }

  it("timeout with tools names the follow-graph task and a narrower ask", () => {
    const text = fallbackReply("timeout", inferFallbackContext("which accounts should I follow and stop following?"));
    expect(text).toMatch(/follow graph/i);
    expect(text).toMatch(/who do my follows follow that I don't/i);
  });

  it("classifies abort as timeout and budget errors as budget", () => {
    expect(classifyAnswerFailure(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("timeout");
    expect(classifyAnswerFailure(new Error("token budget exceeded"))).toBe("budget");
    expect(classifyAnswerFailure(new Error("graph lookup unavailable right now"))).toBe("tool_unavailable");
    expect(classifyAnswerFailure(new Error("no model key"))).toBe("model_error");
  });
});

describe("publish_requests partial unique index", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
  });
  afterAll(async () => {
    await store.close();
  });

  it("exists and a second active insert is a no-op", async () => {
    const idx = await store.pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'publish_requests_active_mention_key'`,
    );
    expect(idx.rows[0]?.indexdef ?? "").toMatch(/WHERE/i);
    expect(idx.rows[0]?.indexdef ?? "").toMatch(/queued/);
    expect(idx.rows[0]?.indexdef ?? "").toMatch(/published/);

    const key = "pubky://1111111111111111111111111111111111111111111111111111/pub/pubky.app/posts/FALLBACKIDX01";
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [key]);
    expect(await store.insertPublishRequest({ mentionKey: key, parentUri: key, content: "a", evidenceId: null })).toBe(
      true,
    );
    expect(await store.insertPublishRequest({ mentionKey: key, parentUri: key, content: "b", evidenceId: null })).toBe(
      false,
    );
    const n = await store.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM publish_requests WHERE mention_key = $1 AND status IN ('queued', 'retry', 'publishing', 'published')`,
      [key],
    );
    expect(n.rows[0]?.n).toBe(1);
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key = $1", [key]);
  });
});
