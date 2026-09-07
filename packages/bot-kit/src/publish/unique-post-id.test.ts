import { describe, expect, it } from "vitest";
import { PubkyAppPostKind, PubkySpecsBuilder } from "pubky-app-specs";
import { allocateUniquePostId, timestampMsFromPostId } from "../crockford.js";
import { buildCollectionPost, buildStandalonePost } from "./post.js";
import type { PublishStore, PublishRequestInsert } from "./publish-store.js";
import { enqueueCollectionUpsert, enqueueStandalonePost } from "./publisher.js";

function stubStore(): PublishStore & { ids: string[] } {
  const ids: string[] = [];
  const store = {
    ids,
    ping: async () => true,
    migrate: async () => undefined,
    close: async () => undefined,
    switchOn: async () => false,
    setSwitch: async () => undefined,
    get: async () => null,
    mark: async () => undefined,
    supersedePublishForReplace: async () => undefined,
    claimPublish: async () => null,
    failExhaustedPublishes: async () => 0,
    failExhaustedArtifactTags: async () => 0,
    markPublishDone: async () => undefined,
    markPublishRetry: async () => undefined,
    markPublishFailed: async () => undefined,
    markPublishFailedAuth: async () => undefined,
    markPublishScrubbed: async () => undefined,
    setPublishCategories: async () => undefined,
    clearFailFirst: async () => undefined,
    claimPendingTags: async () => null,
    markTagsDone: async () => undefined,
    markTagRetry: async () => undefined,
    insertArtifactTag: async () => true,
    claimPendingArtifactTag: async () => null,
    markArtifactTagDone: async () => 0,
    markArtifactTagRetry: async () => undefined,
    markArtifactTagDeferUnanswered: async () => undefined,
    markArtifactTagFailed: async () => undefined,
    getArtifactTag: async () => null,
    markArtifactTagRevoked: async () => undefined,
    mergeEvidencePhaseMs: async () => undefined,
    appendEvidenceSecurityEvents: async () => undefined,
    markLinkedDraftPublished: async () => undefined,
    markLinkedDraftDeclined: async () => undefined,
    getPublishRequestPostId: async () => null,
    insertPublishRequest: async (row: PublishRequestInsert) => {
      if (row.replacePostId) ids.push(row.replacePostId);
      return true;
    },
  };
  return store as PublishStore & { ids: string[] };
}

describe("same-millisecond post id allocation", () => {
  it("documents that PubkySpecsBuilder.createPost collides in a tight loop", () => {
    const specs = new PubkySpecsBuilder("a".repeat(52));
    const ids = Array.from(
      { length: 50 },
      (_, i) => specs.createPost("content " + i, PubkyAppPostKind.Short, null, null, null).meta.id,
    );
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  it("buildStandalonePost assigns a unique spec id for every call in a tight loop", () => {
    const bot = "a".repeat(52);
    const ids = Array.from({ length: 50 }, (_, i) => buildStandalonePost(bot, "body " + i, "short").id);
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) expect(timestampMsFromPostId(id)).not.toBeNull();
  });

  it("two consecutive collection builds with different titles get different ids", () => {
    const bot = "a".repeat(52);
    const a = buildCollectionPost(bot, { title: "A", description: "d", itemUris: [] }).id;
    const b = buildCollectionPost(bot, { title: "B", description: "d", itemUris: [] }).id;
    expect(a).not.toBe(b);
    expect(timestampMsFromPostId(a)).not.toBeNull();
    expect(timestampMsFromPostId(b)).not.toBeNull();
  });

  it("enqueueStandalonePost does not share replace_post_id across distinct payloads", async () => {
    const store = stubStore();
    const first = await enqueueStandalonePost(store, { content: "first unique body", kind: "short", approvedBy: "op" });
    const second = await enqueueStandalonePost(store, { content: "second unique body", kind: "short", approvedBy: "op" });
    expect(first.postId).not.toBe(second.postId);
    expect(store.ids).toEqual([first.postId, second.postId]);
  });

  it("enqueueCollectionUpsert for two new titles does not share replace_post_id", async () => {
    const store = stubStore();
    const first = await enqueueCollectionUpsert(store, {
      title: "Recurring: homeservers",
      description: "a",
      itemUris: [],
      approvedBy: "op",
    });
    const second = await enqueueCollectionUpsert(store, {
      title: "Recurring: keys",
      description: "b",
      itemUris: [],
      approvedBy: "op",
    });
    expect(first.postId).not.toBe(second.postId);
  });

  it("allocateUniquePostId stays unique when the clock is frozen", () => {
    const frozen = Date.now();
    const ids = Array.from({ length: 200 }, () => allocateUniquePostId(frozen));
    expect(new Set(ids).size).toBe(200);
    for (const id of ids) expect(timestampMsFromPostId(id, frozen)).not.toBeNull();
  });
});
