import { describe, expect, it } from "vitest";
import type { PublishStore, PublishRequestInsert } from "./publish-store.js";
import { enqueueCollectionUpsert, enqueueStandalonePost, PersistedPostIdError } from "./publisher.js";
import { postIdFromUnixMs, timestampMsFromPostId } from "../crockford.js";

/** Captured from the production incident: 13-char SHA-256 hex prefix. */
const LEGACY_HEX_ID = "528D628C576EC";

function stubStore(
  overrides: Partial<PublishStore> & Pick<PublishStore, "getPublishRequestPostId" | "insertPublishRequest">,
): PublishStore {
  return {
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
    ...overrides,
  };
}

describe("enqueue post-id reuse", () => {
  it("rejects the incident hex prefix as a timestamp id", () => {
    expect(timestampMsFromPostId(LEGACY_HEX_ID)).toBeNull();
  });

  it("collection upsert falls back to the builder id when persisted id is legacy hex", async () => {
    let replaced: string | null | undefined;
    const store = stubStore({
      getPublishRequestPostId: async () => LEGACY_HEX_ID,
      insertPublishRequest: async (row: PublishRequestInsert) => {
        replaced = row.replacePostId ?? null;
        return true;
      },
    });
    const queued = await enqueueCollectionUpsert(store, {
      title: "Recurring: homeservers",
      description: "notes",
      itemUris: ["pubky://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/pub/pubky.app/posts/00000000000TG"],
      approvedBy: "op",
    });
    expect(queued.postId).not.toBe(LEGACY_HEX_ID);
    expect(timestampMsFromPostId(queued.postId)).not.toBeNull();
    expect(replaced).toBe(queued.postId);
  });

  it("collection upsert reuses a timestamp-decodable persisted id", async () => {
    const good = postIdFromUnixMs(Date.UTC(2025, 5, 1));
    expect(timestampMsFromPostId(good)).not.toBeNull();
    const store = stubStore({
      getPublishRequestPostId: async () => good,
      insertPublishRequest: async () => true,
    });
    const queued = await enqueueCollectionUpsert(store, {
      title: "Keep same collection path",
      description: "v2",
      itemUris: [],
      approvedBy: "op",
    });
    expect(queued.postId).toBe(good);
  });

  it("standalone duplicate with invalid persisted id throws PersistedPostIdError", async () => {
    const store = stubStore({
      getPublishRequestPostId: async () => LEGACY_HEX_ID,
      insertPublishRequest: async () => false,
    });
    await expect(
      enqueueStandalonePost(store, { content: "same payload twice", kind: "short", approvedBy: "op" }),
    ).rejects.toBeInstanceOf(PersistedPostIdError);
  });

  it("standalone duplicate with missing persisted id throws PersistedPostIdError", async () => {
    const store = stubStore({
      getPublishRequestPostId: async () => null,
      insertPublishRequest: async () => false,
    });
    await expect(
      enqueueStandalonePost(store, { content: "missing persisted id", kind: "short", approvedBy: "op" }),
    ).rejects.toBeInstanceOf(PersistedPostIdError);
  });

  it("standalone duplicate reuses a valid persisted id when inserted is false", async () => {
    const good = postIdFromUnixMs(Date.UTC(2025, 5, 1));
    const store = stubStore({
      getPublishRequestPostId: async () => good,
      insertPublishRequest: async () => false,
    });
    const queued = await enqueueStandalonePost(store, {
      content: "already queued",
      kind: "short",
      approvedBy: "op",
    });
    expect(queued.inserted).toBe(false);
    expect(queued.postId).toBe(good);
  });
});
