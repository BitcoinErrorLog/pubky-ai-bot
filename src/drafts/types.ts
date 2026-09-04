import type { VoiceViolation } from "../voice.js";

export const DRAFT_FORMATS = [
  "what_changed",
  "thread_worth_reading",
  "the_disagreement",
  "new_connection",
  "pubky_explained",
  "release_radar",
] as const;

export type DraftFormat = (typeof DRAFT_FORMATS)[number];

export type DraftStatus = "draft" | "approved" | "rejected" | "published";

export interface DraftEvidence {
  uris: string[];
  tool_trace: unknown[];
  voice_violations: VoiceViolation[];
}

export interface StandalonePublishInsert {
  mentionKey: string;
  parentUri: string;
  content: string;
  categories: string[];
  standalone: true;
  postJson: Record<string, unknown>;
  postPath: string;
}

export interface Draft {
  format: DraftFormat;
  title?: string;
  body: string;
  evidence: DraftEvidence;
  created_at: string;
}

export interface DraftRow {
  id: number;
  format: DraftFormat;
  body: string;
  title: string | null;
  evidence: DraftEvidence;
  status: DraftStatus;
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  reject_reason: string | null;
  publish_request_id: number | null;
  proactive_utc_day: string | null;
}

export const DRAFT_BODY_MAX = 2000;

export const FORMAT_ENV: Record<DraftFormat, string> = {
  what_changed: "JEB_DRAFT_WHAT_CHANGED_ENABLED",
  thread_worth_reading: "JEB_DRAFT_THREAD_WORTH_READING_ENABLED",
  the_disagreement: "JEB_DRAFT_THE_DISAGREEMENT_ENABLED",
  new_connection: "JEB_DRAFT_NEW_CONNECTION_ENABLED",
  pubky_explained: "JEB_DRAFT_PUBKY_EXPLAINED_ENABLED",
  release_radar: "JEB_DRAFT_RELEASE_RADAR_ENABLED",
};

export function parseDraftFormat(raw: string): DraftFormat {
  const v = raw.trim();
  if ((DRAFT_FORMATS as readonly string[]).includes(v)) return v as DraftFormat;
  throw new Error(`unknown draft format ${raw}`);
}
