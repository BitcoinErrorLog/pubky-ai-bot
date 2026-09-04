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
 * Kit emits suggested/applied only. Jeb stores judgements on evidence /
 * artifact_tags / corrections — no accuracy table and no ML.
 */
export type TagEvent = {
  kind: TagEventKind;
  labels: string[];
  targetUri?: string;
  mentionKey?: string;
  uris?: string[];
};

/**
 * SQL the Tagky capability needs: artifact tag queue rows, revoke, and the
 * suggested/applied event write. Jeb's Store implements this.
 */
export interface TagStore {
  switchOn(name: SwitchName): Promise<boolean>;
  insertArtifactTag(row: { postUri: string; label: string; approvedBy: string }): Promise<boolean>;
  getArtifactTag(postUri: string, label: string): Promise<ArtifactTagRow | null>;
  markArtifactTagDone(id: number, tagUri: string): Promise<void>;
  markArtifactTagRetry(id: number, err: string, attempts: number): Promise<void>;
  markArtifactTagFailed(id: number, err: string): Promise<void>;
  markArtifactTagRevoked(id: number): Promise<void>;
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
 * (`evidence.categories` — same column reason already fills). Applied events
 * are the operational rows: `publish_requests.tag_uris` and `artifact_tags`.
 */
export async function recordTagEvent(db: Queryable, event: TagEvent): Promise<void> {
  if (event.kind !== "suggested" || !event.mentionKey) return;
  await db.query(
    `UPDATE evidence SET categories = $2::jsonb
       WHERE id = (SELECT id FROM evidence WHERE mention_key = $1 ORDER BY id DESC LIMIT 1)`,
    [event.mentionKey, JSON.stringify(event.labels)],
  );
}
