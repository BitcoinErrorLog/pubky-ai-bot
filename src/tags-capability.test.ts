import { describe, expect, it } from "vitest";
import { applyTags } from "./reply-tags.js";
import type { Transport } from "./homeserver.js";
import type { ArtifactTagListRow, ArtifactTagRow, TagEvent, TagStore } from "./bot-kit/tags/tag-store.js";
import type { SwitchName } from "./switches.js";

const BOT_PK = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SELF_URI = `pubky://${BOT_PK}/pub/pubky.app/posts/0000000000001`;
const FOREIGN_URI = "pubky://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/pub/pubky.app/posts/0000000000001";

class TagFakeTransport implements Transport {
  botPk = BOT_PK;
  tagPuts: Array<{ path: string; json: { uri?: string; label?: string } }> = [];
  deleted: string[] = [];

  async putJson(path: string, json: unknown): Promise<void> {
    this.tagPuts.push({ path, json: json as { uri?: string; label?: string } });
  }
  async putBytes(): Promise<void> {}
  async getJson(): Promise<unknown> {
    return {};
  }
  async listPosts(): Promise<Array<{ parent?: string; uri: string }>> {
    return [];
  }
  async reauth(): Promise<void> {}
  async deleteJson(path: string): Promise<void> {
    this.deleted.push(path);
  }
}

class FakeTagStore implements TagStore {
  events: TagEvent[] = [];
  queued: Array<{ postUri: string; label: string; approvedBy: string; id: number; status: string; tag_uri: string | null }> =
    [];
  nextId = 1;
  repliesOn = false;
  proactiveOn = false;
  answered = new Set<string>();
  async botRepliedTo(postUri: string): Promise<boolean> {
    return this.answered.has(postUri);
  }

  async switchOn(name: SwitchName): Promise<boolean> {
    if (name === "replies") return this.repliesOn;
    if (name === "proactive") return this.proactiveOn;
    return false;
  }
  async insertArtifactTag(row: { postUri: string; label: string; approvedBy: string }): Promise<boolean> {
    const exists = this.queued.some(
      (q) => q.postUri === row.postUri && q.label === row.label && ["queued", "retry", "publishing", "published"].includes(q.status),
    );
    if (exists) return false;
    this.queued.push({ ...row, id: this.nextId++, status: "queued", tag_uri: null });
    return true;
  }
  async getArtifactTag(postUri: string, label: string): Promise<ArtifactTagRow | null> {
    const row = [...this.queued].reverse().find((q) => q.postUri === postUri && q.label === label);
    if (!row) return null;
    return { id: row.id, status: row.status, tag_uri: row.tag_uri };
  }
  selfTagUris: Array<{ replyUri: string; tagUris: string[] }> = [];

  async markArtifactTagDone(id: number, tagUri: string): Promise<number> {
    const row = this.queued.find((q) => q.id === id);
    if (!row || row.status !== "publishing") return 0;
    row.status = "published";
    row.tag_uri = tagUri;
    return 1;
  }
  async markArtifactTagRetry(id: number): Promise<void> {
    const row = this.queued.find((q) => q.id === id);
    if (row && row.status !== "revoked") row.status = "retry";
  }
  async markArtifactTagFailed(id: number, _err: string): Promise<void> {
    const row = this.queued.find((q) => q.id === id);
    if (row && row.status !== "revoked") row.status = "failed";
  }
  async markArtifactTagRevoked(id: number): Promise<void> {
    const row = this.queued.find((q) => q.id === id);
    if (row) row.status = "revoked";
  }
  async markSelfTagsDone(replyUri: string, tagUris: string[]): Promise<void> {
    this.selfTagUris.push({ replyUri, tagUris });
  }
  async listArtifactTags(): Promise<ArtifactTagListRow[]> {
    return this.queued.map((q) => ({
      post_uri: q.postUri,
      label: q.label,
      status: q.status,
      tag_uri: q.tag_uri,
      approved_by: q.approvedBy,
    }));
  }
  async recordTagEvent(event: TagEvent): Promise<void> {
    this.events.push(event);
  }
}

describe("applyTags capability gates", () => {
  it("self mode on a non-bot-authored URI is refused", async () => {
    const t = new TagFakeTransport();
    const store = new FakeTagStore();
    await expect(
      applyTags({ targetUri: FOREIGN_URI, labels: ["answer"], mode: "self" }, { store, transport: t }),
    ).rejects.toThrow(/not authored by the bot key/);
    expect(t.tagPuts).toHaveLength(0);
  });

  it("artifact mode without approvedBy is refused", async () => {
    const t = new TagFakeTransport();
    const store = new FakeTagStore();
    await expect(
      applyTags({ targetUri: FOREIGN_URI, labels: ["debate"], mode: "artifact" }, { store, transport: t }),
    ).rejects.toThrow(/approvedBy is required/);
    expect(t.tagPuts).toHaveLength(0);
    expect(store.queued).toHaveLength(0);
  });

  it("artifact mode with empty approvedBy is refused", async () => {
    const store = new FakeTagStore();
    await expect(
      applyTags(
        { targetUri: FOREIGN_URI, labels: ["debate"], mode: "artifact", approvedBy: "   " },
        { store },
      ),
    ).rejects.toThrow(/approvedBy is required/);
    expect(store.queued).toHaveLength(0);
  });

  it("style-invalid label is refused (self)", async () => {
    const t = new TagFakeTransport();
    const store = new FakeTagStore();
    await expect(
      applyTags({ targetUri: SELF_URI, labels: ["Hello"], mode: "self" }, { store, transport: t }),
    ).rejects.toThrow(/invalid tag label/);
    expect(t.tagPuts).toHaveLength(0);
  });

  it("denylisted person label is refused (artifact)", async () => {
    const store = new FakeTagStore();
    await expect(
      applyTags(
        { targetUri: FOREIGN_URI, labels: ["john-carvalho"], mode: "artifact", approvedBy: "op" },
        { store },
      ),
    ).rejects.toThrow(/invalid tag label/);
    expect(store.queued).toHaveLength(0);
  });

  it("artifact mode without approvedBy succeeds when Jeb already answered", async () => {
    const store = new FakeTagStore();
    store.answered.add(FOREIGN_URI);
    const out = await applyTags({ targetUri: FOREIGN_URI, labels: ["homeserver"], mode: "artifact" }, { store });
    expect(out.inserted).toBe(true);
    expect(store.queued[0]?.approvedBy).toBe("jeb-answered");
  });

  it("self mode persist via markSelfTagsDone", async () => {
    const t = new TagFakeTransport();
    const store = new FakeTagStore();
    const out = await applyTags({ targetUri: SELF_URI, labels: ["answer"], mode: "self" }, { store, transport: t });
    expect(out.uris).toHaveLength(1);
    expect(store.selfTagUris).toEqual([{ replyUri: SELF_URI, tagUris: out.uris }]);
  });

  it("kill switch on → no PUT (self)", async () => {
    const t = new TagFakeTransport();
    const store = new FakeTagStore();
    store.repliesOn = true;
    const out = await applyTags({ targetUri: SELF_URI, labels: ["answer"], mode: "self" }, { store, transport: t });
    expect(out.uris).toEqual([]);
    expect(t.tagPuts).toHaveLength(0);
  });

  it("kill switch on → no PUT (artifact)", async () => {
    const t = new TagFakeTransport();
    const store = new FakeTagStore();
    store.repliesOn = true;
    const out = await applyTags(
      { targetUri: FOREIGN_URI, labels: ["debate"], mode: "artifact", approvedBy: "op" },
      { store, transport: t },
    );
    expect(out.inserted).toBe(true);
    expect(out.uris).toEqual([]);
    expect(t.tagPuts).toHaveLength(0);
  });

  it("applyTags rolls back a PUT when the artifact row is revoked before done", async () => {
    const t = new TagFakeTransport();
    const store = new FakeTagStore();
    const origGet = store.getArtifactTag.bind(store);
    store.getArtifactTag = async (postUri, label) => {
      const row = await origGet(postUri, label);
      if (!row) return null;
      return { ...row, status: "revoked" };
    };
    const out = await applyTags(
      { targetUri: FOREIGN_URI, labels: ["debate"], mode: "artifact", approvedBy: "op" },
      { store, transport: t },
    );
    expect(t.tagPuts).toHaveLength(1);
    expect(t.deleted).toHaveLength(1);
    expect(out.uris).toEqual([]);
  });

  it("artifact applyTags with a transport leaves the row queued (F-N3)", async () => {
    const t = new TagFakeTransport();
    const store = new FakeTagStore();
    const out = await applyTags(
      { targetUri: FOREIGN_URI, labels: ["debate"], mode: "artifact", approvedBy: "op" },
      { store, transport: t },
    );
    expect(t.tagPuts).toHaveLength(1);
    expect(out.uris).toHaveLength(1);
    expect(store.queued[0]?.status).toBe("queued");
  });

  it("applyTags rollback DELETE failure does not throw (F-N1)", async () => {
    const t = new TagFakeTransport();
    const store = new FakeTagStore();
    const origGet = store.getArtifactTag.bind(store);
    store.getArtifactTag = async (postUri, label) => {
      const row = await origGet(postUri, label);
      if (!row) return null;
      return { ...row, status: "revoked" };
    };
    t.deleteJson = async () => {
      throw new Error("homeserver delete failed");
    };
    const out = await applyTags(
      { targetUri: FOREIGN_URI, labels: ["debate"], mode: "artifact", approvedBy: "op" },
      { store, transport: t },
    );
    expect(t.tagPuts).toHaveLength(1);
    expect(out.uris).toEqual([]);
    expect(store.queued[0]?.status).toBe("queued");
  });

  it("proactive kill switch on → no artifact PUT", async () => {
    const t = new TagFakeTransport();
    const store = new FakeTagStore();
    store.proactiveOn = true;
    const out = await applyTags(
      { targetUri: FOREIGN_URI, labels: ["debate"], mode: "artifact", approvedBy: "op" },
      { store, transport: t },
    );
    expect(out.inserted).toBe(true);
    expect(t.tagPuts).toHaveLength(0);
  });
});
