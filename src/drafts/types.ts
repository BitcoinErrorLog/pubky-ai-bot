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

export const DRAFT_FORMAT_LABELS: Record<DraftFormat, string> = {
  what_changed: "What changed",
  thread_worth_reading: "The thread worth reading",
  the_disagreement: "The disagreement",
  new_connection: "New connection",
  pubky_explained: "Pubky explained",
  release_radar: "Release radar",
};

export const DRAFT_STATUSES = ["draft", "approved", "rejected", "published", "declined"] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export interface DraftEvidence {
  uris: string[];
  tool_trace: unknown[];
  voice_violations: VoiceViolation[];
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

/** Approved proactive posts per UTC day (approve-time cap). */
export const DEFAULT_PROACTIVE_MAX_PER_DAY = 1;

export const FORMAT_ENV: Record<DraftFormat, string> = {
  what_changed: "JEB_DRAFT_WHAT_CHANGED_ENABLED",
  thread_worth_reading: "JEB_DRAFT_THREAD_WORTH_READING_ENABLED",
  the_disagreement: "JEB_DRAFT_THE_DISAGREEMENT_ENABLED",
  new_connection: "JEB_DRAFT_NEW_CONNECTION_ENABLED",
  pubky_explained: "JEB_DRAFT_PUBKY_EXPLAINED_ENABLED",
  release_radar: "JEB_DRAFT_RELEASE_RADAR_ENABLED",
};

/** Self-tags written on approved standalone posts so collection rules can match. */
export const FORMAT_SELF_TAGS: Record<DraftFormat, readonly string[]> = {
  what_changed: ["what-changed"],
  thread_worth_reading: ["thread-worth-reading"],
  the_disagreement: ["the-disagreement"],
  new_connection: ["new-connection"],
  pubky_explained: ["pubky-explained"],
  release_radar: ["release-radar"],
};

export function parseDraftFormat(raw: string): DraftFormat {
  const v = raw.trim();
  if ((DRAFT_FORMATS as readonly string[]).includes(v)) return v as DraftFormat;
  throw new Error(`unknown draft format ${raw}`);
}
