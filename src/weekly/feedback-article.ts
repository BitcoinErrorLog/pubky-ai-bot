import { postAppUrl, profileAppUrl } from "../links.js";
import { listCorrectionsSinceSafe, listUnincludedFeedbackSinceSafe } from "./store.js";
import type { WeeklyQueryable } from "./store.js";
import { feedbackItemInWindow } from "./content.js";
import type { FeedbackItem, FeedbackKind } from "./types.js";
import { formatWeekOfDate } from "./week-key.js";

const KIND_HEADINGS: Array<{ kind: FeedbackKind | "tagged"; title: string }> = [
  { kind: "advice", title: "Advice" },
  { kind: "complaint", title: "Complaints" },
  { kind: "feature_request", title: "Feature requests" },
  { kind: "bug_report", title: "Bugs" },
  { kind: "praise", title: "Praise" },
  { kind: "tagged", title: "Tagged questions and feedback" },
];

const KIND_ALSO_LABEL: Record<FeedbackKind, string> = {
  advice: "advice",
  complaint: "complaint",
  feature_request: "feature request",
  bug_report: "bug",
  praise: "praise",
};

/** First listed kind wins; remaining kinds are noted inline. */
export function primaryFeedbackKind(kinds: readonly FeedbackKind[]): FeedbackKind | null {
  for (const heading of KIND_HEADINGS) {
    if (heading.kind === "tagged") continue;
    if (kinds.includes(heading.kind)) return heading.kind;
  }
  return null;
}

export function sundayFeedbackUris(items: readonly FeedbackItem[]): Set<string> {
  return new Set(items.filter((i) => i.kinds.length > 0).map((i) => i.post_uri));
}

export interface FeedbackArticle {
  title: string;
  body: string;
  itemIds: number[];
}

function itemLine(item: FeedbackItem, appUrl: string, alsoKinds: FeedbackKind[] = []): string {
  const { author, postId } = splitUri(item.post_uri);
  const authorLink = profileAppUrl(author, appUrl);
  const postLink = postAppUrl(author, postId, appUrl);
  const also = alsoKinds.length
    ? ` *(also: ${alsoKinds.map((k) => KIND_ALSO_LABEL[k]).join(", ")})*`
    : "";
  return `- “${item.quote}” — [pk:${author.slice(0, 8)}](${authorLink}) · [post](${postLink})${also}`;
}

function splitUri(uri: string): { author: string; postId: string } {
  const m = /^pubky:\/\/([a-z0-9]{52})\/pub\/pubky\.app\/posts\/([A-Za-z0-9._~-]+)$/i.exec(uri);
  if (!m?.[1] || !m[2]) return { author: "a".repeat(52), postId: "0000000000000" };
  return { author: m[1], postId: m[2] };
}

export function renderFeedbackArticle(opts: {
  weekKey: string;
  items: FeedbackItem[];
  corrections: Array<{ reply_uri: string; reason: string }>;
  appUrl: string;
}): FeedbackArticle {
  const title = `Community feedback, week of ${formatWeekOfDate(opts.weekKey)}`;
  const intro =
    "Public notes people left for Jeb this week — advice, complaints, requests, bugs, praise, and tagged questions. Quotes are excerpts, not verdicts.";
  const sections: string[] = [intro, ""];
  const used = new Set<number>();
  for (const heading of KIND_HEADINGS) {
    const rows =
      heading.kind === "tagged"
        ? opts.items.filter((i) => i.source === "tag" && i.kinds.length === 0 && !used.has(i.id))
        : opts.items.filter((i) => !used.has(i.id) && primaryFeedbackKind(i.kinds) === heading.kind);
    if (rows.length === 0) continue;
    sections.push(`## ${heading.title}`, "");
    for (const item of rows) {
      const primary = heading.kind === "tagged" ? null : heading.kind;
      const also = primary ? item.kinds.filter((k) => k !== primary) : [];
      sections.push(itemLine(item, opts.appUrl, also));
      used.add(item.id);
    }
    sections.push("");
  }
  if (opts.corrections.length > 0) {
    sections.push("## What Jeb changed this week", "");
    for (const c of opts.corrections) {
      const { author, postId } = splitUri(c.reply_uri);
      sections.push(`- ${c.reason} ([reply](${postAppUrl(author, postId, opts.appUrl)}))`);
    }
    sections.push("");
  }
  return { title, body: sections.join("\n").trim() + "\n", itemIds: [...used] };
}

export async function buildFeedbackArticle(
  db: WeeklyQueryable,
  opts: { weekKey: string; since: Date; until: Date; appUrl: string; extra?: FeedbackItem[]; botPk?: string },
): Promise<FeedbackArticle | null> {
  const fromDb = await listUnincludedFeedbackSinceSafe(db, opts.since, opts.until);
  const seen = new Set(fromDb.map((i) => i.post_uri));
  const items: FeedbackItem[] = [];
  const sinceMs = opts.since.getTime();
  const untilMs = opts.until.getTime();
  for (const row of fromDb) {
    if (feedbackItemInWindow(row, sinceMs, untilMs, opts.botPk)) items.push(row);
  }
  for (const extra of opts.extra ?? []) {
    if (seen.has(extra.post_uri)) continue;
    if (!feedbackItemInWindow(extra, sinceMs, untilMs, opts.botPk)) continue;
    seen.add(extra.post_uri);
    items.push(extra);
  }
  if (items.length === 0) return null;
  const corrections = await listCorrectionsSinceSafe(db, opts.since);
  return renderFeedbackArticle({
    weekKey: opts.weekKey,
    items,
    corrections,
    appUrl: opts.appUrl,
  });
}
