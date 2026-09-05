import { describe, expect, it } from "vitest";
import { postIdFromUnixMs } from "../bot-kit/crockford.js";
import type { Config } from "../config.js";
import type { Store } from "../db.js";
import type { Nexus } from "../nexus.js";
import type { Notification, PostView } from "../types.js";
import { classifyJebMentions, formatClassifierCounts } from "./classify-mentions.js";
import { JEB_PUBKY } from "./types.js";
import { feedbackWindow } from "./week-key.js";

const AUTHOR = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("classifyJebMentions", () => {
  it("classifies an in-window mention and skips deleted / Jeb / August posts", async () => {
    const win = feedbackWindow("2026-W36", "Europe/London");
    const inId = postIdFromUnixMs(Date.parse("2026-09-02T12:00:00Z"));
    const outId = postIdFromUnixMs(Date.parse("2026-08-20T12:00:00Z"));
    const delId = postIdFromUnixMs(Date.parse("2026-09-03T12:00:00Z"));
    const jebId = postIdFromUnixMs(Date.parse("2026-09-03T13:00:00Z"));
    const posts: Record<string, PostView> = {
      [`pubky://${AUTHOR}/pub/pubky.app/posts/${inId}`]: {
        details: {
          content: "Jeb replies are too slow",
          id: inId,
          indexed_at: Date.parse("2026-09-02T12:00:00Z"),
          author: AUTHOR,
          kind: "short",
          uri: `pubky://${AUTHOR}/pub/pubky.app/posts/${inId}`,
        },
      },
      [`pubky://${AUTHOR}/pub/pubky.app/posts/${outId}`]: {
        details: {
          content: "old complaint",
          id: outId,
          indexed_at: Date.parse("2026-08-20T12:00:00Z"),
          author: AUTHOR,
          kind: "short",
          uri: `pubky://${AUTHOR}/pub/pubky.app/posts/${outId}`,
        },
      },
      [`pubky://${AUTHOR}/pub/pubky.app/posts/${delId}`]: {
        details: {
          content: "[DELETED]",
          id: delId,
          indexed_at: Date.parse("2026-09-03T12:00:00Z"),
          author: AUTHOR,
          kind: "short",
          uri: `pubky://${AUTHOR}/pub/pubky.app/posts/${delId}`,
        },
      },
      [`pubky://${JEB_PUBKY}/pub/pubky.app/posts/${jebId}`]: {
        details: {
          content: "I am Jeb",
          id: jebId,
          indexed_at: Date.parse("2026-09-03T13:00:00Z"),
          author: JEB_PUBKY,
          kind: "short",
          uri: `pubky://${JEB_PUBKY}/pub/pubky.app/posts/${jebId}`,
        },
      },
    };
    const notes: Notification[] = Object.keys(posts).map((uri, i) => ({
      timestamp: Date.parse("2026-09-02T12:00:00Z") + i,
      body: { type: "mention", post_uri: uri, mentioned_by: AUTHOR },
    }));
    const nexus = {
      notifications: async () => notes,
      post: async (uri: string) => posts[uri] ?? null,
    } as unknown as Nexus;
    const store = { recordUsage: async () => undefined } as unknown as Store;
    const cfg = {
      cannedReply: undefined,
      modelApiKey: undefined,
      botPk: JEB_PUBKY,
      weeklyTz: "Europe/London",
      model: "test",
    } as Config;
    const out = await classifyJebMentions({
      cfg,
      store,
      nexus,
      sinceMs: win.sinceMs,
      untilMs: win.untilMs,
      persist: false,
    });
    expect(out.seen).toBe(4);
    expect(out.items).toEqual([]);
    expect(out.counts.none).toBe(1);
    expect(formatClassifierCounts(out.counts)).toContain("none=1");
  });

  it("skips URIs already in feedback_items and stops when the daily budget is exhausted", async () => {
    const win = feedbackWindow("2026-W36", "Europe/London");
    const inId = postIdFromUnixMs(Date.parse("2026-09-02T12:00:00Z"));
    const uri = `pubky://${AUTHOR}/pub/pubky.app/posts/${inId}`;
    const notes: Notification[] = [
      { timestamp: Date.parse("2026-09-02T12:00:00Z"), body: { type: "mention", post_uri: uri, mentioned_by: AUTHOR } },
    ];
    const nexus = {
      notifications: async () => notes,
      post: async () => {
        throw new Error("should not fetch an already-stored uri");
      },
    } as unknown as Nexus;
    const store = {
      pool: {
        query: async (sql: string) => {
          if (sql.includes("FROM feedback_items")) return { rows: [{ post_uri: uri }] };
          return { rows: [{ total: "0" }] };
        },
      },
      recordUsage: async () => undefined,
      globalDailyTokens: async () => 0,
    } as unknown as Store;
    const cfg = {
      cannedReply: undefined,
      modelApiKey: undefined,
      botPk: JEB_PUBKY,
      weeklyTz: "Europe/London",
      model: "test",
      dailyTokenBudget: 1_000_000,
      weeklyTokenCap: 400_000,
    } as Config;
    const skipped = await classifyJebMentions({
      cfg,
      store,
      nexus,
      sinceMs: win.sinceMs,
      untilMs: win.untilMs,
      persist: false,
    });
    expect(skipped.seen).toBe(1);
    expect(skipped.items).toEqual([]);
    expect(skipped.counts.none).toBe(0);

    const capped = await classifyJebMentions({
      cfg: { ...cfg, dailyTokenBudget: 100 } as Config,
      store: { ...store, globalDailyTokens: async () => 100_000 } as unknown as Store,
      nexus: {
        notifications: async () => notes,
        post: async () => {
          throw new Error("should not classify when the daily budget is gone");
        },
      } as unknown as Nexus,
      sinceMs: win.sinceMs,
      untilMs: win.untilMs,
      persist: false,
    });
    expect(capped.seen).toBe(0);
    expect(capped.items).toEqual([]);
  });
});
