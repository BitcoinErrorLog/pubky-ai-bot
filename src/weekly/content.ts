import { parsePostUri } from "../types.js";
import { postTimestampMs } from "../bot-kit/crockford.js";
import { JEB_PUBKY } from "./types.js";
import type { FeedbackItem } from "./types.js";

export function isUnusableContent(raw: string | null | undefined): boolean {
  if (raw == null) return true;
  const t = raw.trim();
  if (!t) return true;
  return /^\[deleted\]$/i.test(t);
}

export function jebSourcePks(botPk?: string): Set<string> {
  const out = new Set<string>([JEB_PUBKY]);
  if (botPk) out.add(botPk);
  return out;
}

export function isJebAuthor(author: string, botPk?: string): boolean {
  return jebSourcePks(botPk).has(author);
}

export function timestampFromPostUri(uri: string, fallbackMs?: number): number | null {
  try {
    const { postId } = parsePostUri(uri);
    return postTimestampMs({ postId, indexedAt: fallbackMs ?? null });
  } catch {
    return fallbackMs && fallbackMs > 0 ? fallbackMs : null;
  }
}

export function feedbackItemInWindow(
  item: FeedbackItem,
  sinceMs: number,
  untilMs: number,
  botPk?: string,
): boolean {
  if (isJebAuthor(item.author_pk, botPk)) return false;
  if (isUnusableContent(item.quote)) return false;
  const ts = timestampFromPostUri(item.post_uri, item.detected_at.getTime());
  if (ts === null) return false;
  return ts >= sinceMs && ts <= untilMs;
}
