import { log } from "./log.js";

export const POSTS_PREFIX = "/pub/pubky.app/posts/";

export type MentionKind = "mention" | "reply";

export interface Notification {
  timestamp: number;
  body: Record<string, unknown> & { type?: string };
}

export interface PostView {
  details: {
    content: string;
    id: string;
    indexed_at: number;
    author: string;
    kind: string;
    uri: string;
  };
  relationships?: {
    replied?: string | null;
    reposted?: string | null;
    mentioned?: string[];
  };
  tags?: Array<{ label: string; taggers_count?: number; taggers?: string[] }>;
}

export interface UserDetails {
  name: string;
  bio?: string | null;
  id: string;
}

export interface AncestorContextEntry {
  uri: string;
  createdAt: number;
}

export interface DebugLastContext {
  ancestors: AncestorContextEntry[];
}

export const Z32 = /^[a-z0-9]{52}$/;
export const POST_ID = /^[A-Z0-9]{13}$/i;

export function parsePostUri(uri: string): { author: string; postId: string } {
  // Case-sensitive scheme + author (reject `PUBKY://` / uppercase z32). Post id stays uppercase.
  const m = /^pubky:\/\/([a-z0-9]{52})\/pub\/pubky\.app\/posts\/([A-Z0-9]{13})$/.exec(uri.trim());
  if (!m?.[1] || !m[2]) throw new Error(`Not a canonical post URI`);
  return { author: m[1].toLowerCase(), postId: m[2] };
}

export function extractPubkey(input: string): string {
  const s = input.trim();
  if (s.startsWith("pk:")) return s.slice(3);
  if (s.startsWith("pubky://")) return s.slice("pubky://".length).split("/")[0] ?? s;
  if (s.startsWith("pubky") && !s.startsWith("pubky://")) return s.slice(5).split("/")[0] ?? s;
  return s;
}

/**
 * The acting author is the canonical author segment of the post URI, never
 * the notification body's mentioned_by/replied_by field (audit F-D). Nexus
 * derives that field from the post, so the two must agree; a disagreement
 * is logged at warn and the URI author wins.
 */
function authorFromUri(uri: string, claimedRaw: string): string {
  const author = parsePostUri(uri).author;
  const claimed = extractPubkey(claimedRaw);
  if (claimed && claimed.toLowerCase() !== author.toLowerCase()) {
    log.warn(
      { uri_author: author, claimed_author: claimed },
      "notification author disagrees with post URI; using the URI author",
    );
  }
  return author;
}

export function mentionKey(n: Notification): { key: string; kind: MentionKind; author: string; parentUri?: string } | null {
  const t = n.body?.type;
  if (t === "mention") {
    const postUri = typeof n.body.post_uri === "string" ? n.body.post_uri : "";
    const claimed = typeof n.body.mentioned_by === "string" ? n.body.mentioned_by : "";
    if (!postUri || !claimed) return null;
    let author: string;
    try {
      author = authorFromUri(postUri, claimed);
    } catch {
      return null;
    }
    return { key: postUri, kind: "mention", author };
  }
  if (t === "reply") {
    const replyUri = typeof n.body.reply_uri === "string" ? n.body.reply_uri : "";
    const claimed = typeof n.body.replied_by === "string" ? n.body.replied_by : "";
    if (!replyUri || !claimed) return null;
    let author: string;
    try {
      author = authorFromUri(replyUri, claimed);
    } catch {
      return null;
    }
    // A reply notification names its parent; when present it must be a
    // canonical post URI. The reason step walks the ancestor chain from the
    // reply, so a parent authored by the bot key continues the conversation.
    let parentUri: string | undefined;
    const parent = typeof n.body.parent_post_uri === "string" ? n.body.parent_post_uri : "";
    if (parent) {
      try {
        parsePostUri(parent);
        parentUri = parent;
      } catch {
        return null;
      }
    }
    return { key: replyUri, kind: "reply", author, parentUri };
  }
  return null;
}

export function filterNewer(items: Notification[], end: number | null): Notification[] {
  if (end === null) return items;
  return items.filter((n) => n.timestamp >= end);
}

export function skipStaleFirstBoot(items: Notification[], nowMs: number, maxAgeMinutes: number): Notification[] {
  if (maxAgeMinutes <= 0) return items;
  const cutoff = nowMs - maxAgeMinutes * 60_000;
  return items.filter((n) => n.timestamp >= cutoff);
}

export function nextCursor(items: Notification[], prev: number): number {
  if (items.length === 0) return prev;
  return Math.max(prev, ...items.map((n) => n.timestamp));
}
