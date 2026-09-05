import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import { configFromProcessEnv } from "./config.js";
import { handleDraftsPost } from "./dashboard-drafts.js";
import { DraftRejectedError } from "./drafts/finish.js";
import type { Draft } from "./drafts/types.js";

vi.mock("./drafts/generate.js", () => ({
  generateFormat: vi.fn(async () => {
    throw new DraftRejectedError("what_changed", "none: evidence source unavailable");
  }),
}));

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

describe("dashboard regenerate evidence failure", () => {
  let store: Store;
  let draftId: number;

  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
    draftId = await store.insertDraft({
      format: "what_changed",
      title: "regen reject",
      body: "stale draft body that must be rejected",
      evidence: { uris: ["https://pubky.org/Glossary.md"], tool_trace: [], voice_violations: [] },
      created_at: new Date().toISOString(),
    } satisfies Draft);
  });

  afterAll(async () => {
    await store.pool.query("DELETE FROM drafts WHERE title = 'regen reject'");
    await store.close();
  });

  it("rejects the stale draft like the CLI when evidence is unavailable", async () => {
    const cfg = configFromProcessEnv({ requireSecret: false });
    const out = await handleDraftsPost({ store, cfg, action: "regenerate", id: draftId, fields: {} });
    expect(out.status).toBe(400);
    expect(out.body).toMatch(/evidence source unavailable/);
    const row = await store.getDraft(draftId);
    expect(row?.status).toBe("rejected");
  });
});
