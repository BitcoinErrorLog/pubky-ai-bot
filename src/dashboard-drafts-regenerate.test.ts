import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import { draftsGenerateCli, handleDraftsPost } from "./dashboard-drafts.js";
import { generateFormat } from "./drafts/generate.js";
import type { Draft } from "./drafts/types.js";

vi.mock("./drafts/generate.js", () => ({
  generateFormat: vi.fn(async () => {
    throw new Error("generateFormat must not run in the publisher process");
  }),
}));

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

describe("dashboard regenerate stays off the signing-key process", () => {
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

  it("rejects the draft and tells the operator to generate from the drafts CLI", async () => {
    const out = await handleDraftsPost({ store, action: "regenerate", id: draftId, fields: {} });
    expect(out.status).toBe(200);
    expect(out.body).toContain("regenerate requested");
    expect(out.body).toContain(draftsGenerateCli("what_changed"));
    expect(out.body).toContain("npm run drafts -- generate --format what_changed");
    const row = await store.getDraft(draftId);
    expect(row?.status).toBe("rejected");
    expect(row?.decided_by).toBe("dashboard");
    expect(row?.reject_reason).toBe("regenerate requested");
    expect(generateFormat).not.toHaveBeenCalled();
  });
});
