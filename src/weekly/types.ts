export const FEEDBACK_KINDS = ["advice", "complaint", "feature_request", "bug_report", "praise"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_SOURCES = ["classifier", "tag"] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];

export const WEEKLY_SERIES = ["feedback", "updates"] as const;
export type WeeklySeries = (typeof WEEKLY_SERIES)[number];

export const WEEKLY_POST_STATUSES = ["queued", "published", "skipped"] as const;
export type WeeklyPostStatus = (typeof WEEKLY_POST_STATUSES)[number];

export const PROJECT_STATUSES = ["active", "candidate"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const FEEDBACK_TAG_LABELS = ["pubky-feedback", "ask-pubky", "pubky-questions"] as const;

export const WEEKLY_SERIES_TAGS = {
  feedback: ["community-feedback", "pubky-weekly"],
  updates: ["pubky-weekly"],
} as const;

/** System handle recorded on autonomous weekly publish_requests. Not a human approver. */
export const WEEKLY_APPROVED_BY = "weekly";

export const DEFAULT_WEEKLY_TZ = "Europe/London";
export const DEFAULT_WEEKLY_TOKEN_CAP = 400_000;
export const FEEDBACK_QUOTE_MAX = 280;
export const WEEKLY_FIRE_HOUR = 9;
export const TAG_COLLECT_LOOKBACK_DAYS = 8;
export const TAG_COLLECT_INTERVAL_MS = 3_600_000;
export const WEEKLY_SCHEDULER_INTERVAL_MS = 60_000;

export const WEEK_KEY_RE = /^(\d{4})-W(\d{2})$/;

export interface FeedbackItem {
  id: number;
  post_uri: string;
  author_pk: string;
  kinds: FeedbackKind[];
  quote: string;
  detected_at: Date;
  week_key: string;
  source: FeedbackSource;
  included_in_post_uri: string | null;
}

export interface WeeklyPostRow {
  series: WeeklySeries;
  week_key: string;
  post_uri: string | null;
  mention_key: string | null;
  status: WeeklyPostStatus;
  tags: string[];
}

export interface TrackedProject {
  id: string;
  name: string;
  aliases: string[];
  tags: string[];
  pubky_ids: string[];
  status: ProjectStatus;
}

/** Mirrors migration 103 seed. pubky_ids left empty (none verified from the KB). */
export const SEEDED_TRACKED_PROJECTS: TrackedProject[] = [
  { id: "pubky-app", name: "Pubky App", aliases: ["PubkyApp", "pubky-app"], tags: ["pubky-app", "pubkyapp"], pubky_ids: [], status: "active" },
  { id: "pubky-ring", name: "Pubky Ring", aliases: ["PubkyRing", "Ring"], tags: ["pubky-ring", "pubkyring"], pubky_ids: [], status: "active" },
  { id: "pubky-core", name: "Pubky Core / homeserver", aliases: ["Pubky Core", "homeserver", "pubky-core"], tags: ["pubky-core", "homeserver"], pubky_ids: [], status: "active" },
  { id: "pkarr", name: "Pkarr", aliases: ["PKARR", "pkdns", "PKDNS"], tags: ["pkarr", "pkdns"], pubky_ids: [], status: "active" },
  { id: "nexus", name: "Nexus", aliases: ["Pubky Nexus"], tags: ["nexus", "pubky-nexus"], pubky_ids: [], status: "active" },
  { id: "nexus-scout", name: "Nexus Scout", aliases: ["Scout"], tags: ["nexus-scout", "scout"], pubky_ids: [], status: "active" },
  { id: "homegate", name: "Homegate", aliases: [], tags: ["homegate"], pubky_ids: [], status: "active" },
  { id: "paykit", name: "Paykit", aliases: ["paykit-rs"], tags: ["paykit"], pubky_ids: [], status: "active" },
  { id: "locks", name: "Locks", aliases: ["Pubky Locks", "pubky-locks"], tags: ["locks", "pubky-locks"], pubky_ids: [], status: "active" },
  { id: "loopky", name: "Loopky", aliases: [], tags: ["loopky"], pubky_ids: [], status: "active" },
  { id: "hypercolor", name: "Hypercolor", aliases: [], tags: ["hypercolor"], pubky_ids: [], status: "active" },
  { id: "jeb", name: "Jeb", aliases: ["pubky-ai-bot"], tags: ["jeb"], pubky_ids: [], status: "active" },
  { id: "pubky-bot-kit", name: "Pubky Bot Kit", aliases: ["bot-kit", "bot kit"], tags: ["pubky-bot-kit", "bot-kit"], pubky_ids: [], status: "active" },
];

export function isFeedbackKind(v: string): v is FeedbackKind {
  return (FEEDBACK_KINDS as readonly string[]).includes(v);
}

export function parseWeekKey(raw: string): string {
  const m = WEEK_KEY_RE.exec(raw.trim());
  if (!m) throw new Error("week must be YYYY-Www");
  const week = Number(m[2]);
  if (week < 1 || week > 53) throw new Error("week must be YYYY-Www");
  return `${m[1]}-W${m[2]}`;
}

export function parseWeeklySeries(raw: string): WeeklySeries {
  if (raw === "feedback" || raw === "updates") return raw;
  throw new Error("series must be feedback|updates");
}
