import { describe, expect, it, vi } from "vitest";
import type { Store } from "./db.js";
import { createRunPublishHooks, storePublishHooks } from "./publish.js";
import { markWeeklyPublished, markWeeklyRecoveryPublished } from "./weekly/store.js";

vi.mock("./collections-maintain.js", () => ({
  recordPublishedStandalone: vi.fn(async () => undefined),
  appendPublishedToCollections: vi.fn(async () => undefined),
  reconcileCollections: vi.fn(async () => ({ created: [], skipped: [] })),
}));

vi.mock("./weekly/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./weekly/store.js")>();
  return {
    ...actual,
    markWeeklyPublished: vi.fn(async () => 1),
    markWeeklyRecoveryPublished: vi.fn(async () => undefined),
    listTrackedProjectsSafe: vi.fn(async () => []),
  };
});

const info = {
  uri: "pubky://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pub/pubky.app/posts/0035N8NR4ATE0",
  postId: "0035N8NR4ATE0",
  kind: "long" as const,
  content: "body",
  categories: [] as string[],
  requestId: 1,
  mentionKey: "weekly-recovery:standalone:abc",
};

function fakeStore(): Store {
  return {
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    botRepliedTo: async () => false,
  } as unknown as Store;
}

describe("standalone publish weekly hooks", () => {
  it("storePublishHooks and createRunPublishHooks both mark recovery rows published", async () => {
    vi.mocked(markWeeklyPublished).mockClear();
    vi.mocked(markWeeklyRecoveryPublished).mockClear();
    const store = fakeStore();

    await storePublishHooks(store).onStandalonePublished!(info);
    expect(vi.mocked(markWeeklyRecoveryPublished).mock.calls.length).toBe(1);
    expect(vi.mocked(markWeeklyPublished).mock.calls.length).toBe(1);
    expect(vi.mocked(markWeeklyRecoveryPublished).mock.calls[0]?.[1]).toBe(info.mentionKey);
    expect(vi.mocked(markWeeklyRecoveryPublished).mock.calls[0]?.[2]).toBe(info.uri);

    await createRunPublishHooks(() => store).onStandalonePublished!(info);
    expect(vi.mocked(markWeeklyRecoveryPublished).mock.calls.length).toBe(2);
    expect(vi.mocked(markWeeklyPublished).mock.calls.length).toBe(2);
    expect(vi.mocked(markWeeklyRecoveryPublished).mock.calls[1]?.[1]).toBe(info.mentionKey);
    expect(vi.mocked(markWeeklyRecoveryPublished).mock.calls[1]?.[2]).toBe(info.uri);
  });
});
