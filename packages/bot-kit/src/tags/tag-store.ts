import type { Queryable } from "../queue/ingest-store.js";
import type { SwitchName } from "../policy/switches.js";
import {
  getArtifactTag,
  insertArtifactTag,
  markArtifactTagDone,
  markArtifactTagFailed,
  markArtifactTagRetry,
  markArtifactTagRevoked,
  type ArtifactTagRow,
} from "../publish/publish-store.js";

export type { Queryable, ArtifactTagRow };
export {
  getArtifactTag,
  insertArtifactTag,
  markArtifactTagDone,
  markArtifactTagFailed,
  markArtifactTagRetry,
  markArtifactTagRevoked,
};

export type ArtifactTagListRow = {
  post_uri: string;
  label: string;
  status: string;
  tag_uri: string | null;
  approved_by: string;
};

export type TagEventKind = "suggested" | "applied";

/**
 * Kit emits `suggested` (persisted on `evidence.categories`) and names
 * `applied` for the type. Applied self-tags persist via `markSelfTagsDone`
 * (`publish_requests.tag_uris`, same column as publisher `tagOne`);
 * artifact applies persist on `artifact_tags`. `recordTagEvent` rejects
 * `kind: "applied"` so it cannot silently no-op.
 *
 * Jeb stores judgements on evidence / artifact_tags / corrections — no
 * accuracy table and no ML.
 */
export type TagEvent = {
  kind: TagEventKind;
  labels: string[];
  targetUri?: string;
  mentionKey?: string;
  uris?: string[];
};

/**
 * SQL the Tagky capability needs: artifact tag queue rows, revoke, self-tag
 * persistence, and the suggested-event write. Jeb's Store implements this.
 */
export interface TagStore {
  switchOn(name: SwitchName): Promise<boolean>;
  insertArtifactTag(row: { postUri: string; label: string; approvedBy: string }): Promise<boolean>;
  getArtifactTag(postUri: string, label: string): Promise<ArtifactTagRow | null>;
  markArtifactTagDone(id: number, tagUri: string): Promise<number>;
  markArtifactTagRetry(id: number, err: string, attempts: number): Promise<void>;
  markArtifactTagFailed(id: number, err: string): Promise<void>;
  markArtifactTagRevoked(id: number): Promise<void>;
  markSelfTagsDone(replyUri: string, tagUris: string[]): Promise<void>;
  listArtifactTags(): Promise<ArtifactTagListRow[]>;
  recordTagEvent(event: TagEvent): Promise<void>;
}

export async function listArtifactTags(db: Queryable): Promise<ArtifactTagListRow[]> {
  const r = await db.query(
    `SELECT post_uri, label, status, tag_uri, approved_by FROM artifact_tags ORDER BY id`,
  );
  return r.rows.map((row) => ({
    post_uri: String(row.post_uri),
    label: String(row.label),
    status: String(row.status),
    tag_uri: row.tag_uri === null ? null : String(row.tag_uri),
    approved_by: String(row.approved_by),
  }));
}

/**
 * Persist a suggested snapshot on the latest evidence row for the mention
 * (`evidence.categories` — same column reason already fills). Applied
 * events are operational rows: call `markSelfTagsDone` (self) or
 * `markArtifactTagDone` (artifact). Passing `kind: "applied"` throws.
 */
export async function recordTagEvent(db: Queryable, event: TagEvent): Promise<void> {
  if (event.kind === "applied") {
    throw new Error(
      "applied tag events persist via markSelfTagsDone or artifact_tags; recordTagEvent only writes suggested snapshots",
    );
  }
  if (event.kind !== "suggested" || !event.mentionKey) return;
  await db.query(
    `UPDATE evidence SET categories = $2::jsonb
       WHERE id = (SELECT id FROM evidence WHERE mention_key = $1 ORDER BY id DESC LIMIT 1)`,
    [event.mentionKey, JSON.stringify(event.labels)],
  );
}

/**
 * Same write as publisher `tagOne` → `markTagsDone`: set
 * `publish_requests.tag_uris` for the published request whose
 * `handled_mentions.reply_uri` is `replyUri`.
 */
export async function markSelfTagsDone(db: Queryable, replyUri: string, tagUris: string[]): Promise<void> {
  await db.query(
    `UPDATE publish_requests SET tag_uris = $2::jsonb, updated_at = now()
       WHERE id = (
         SELECT p.id FROM publish_requests p
         JOIN handled_mentions h ON h.mention_key = p.mention_key
         WHERE h.reply_uri = $1 AND p.status = 'published'
         ORDER BY p.id DESC LIMIT 1
       )`,
    [replyUri, JSON.stringify(tagUris)],
  );
}
