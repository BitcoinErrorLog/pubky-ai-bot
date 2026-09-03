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

export interface ContractEnv {
  nexusUrl: string;
  homeserverPk: string;
  signupToken: string;
  secretKeyHex: string;
  pgUrl?: string;
  cannedReply: string;
  modelDelayMs: number;
  maxRepliesPerThread: number;
  testnet: boolean;
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
  const m = /^pubky:\/\/([a-z0-9]{52})\/pub\/pubky\.app\/posts\/([A-Z0-9]{13})$/i.exec(uri.trim());
  if (!m?.[1] || !m[2]) throw new Error(`Not a canonical post URI`);
  return { author: m[1], postId: m[2] };
}

export function extractPubkey(input: string): string {
  const s = input.trim();
  if (s.startsWith("pk:")) return s.slice(3);
  if (s.startsWith("pubky://")) return s.slice("pubky://".length).split("/")[0] ?? s;
  if (s.startsWith("pubky") && !s.startsWith("pubky://")) return s.slice(5).split("/")[0] ?? s;
  return s;
}

export function mentionKey(n: Notification): { key: string; kind: MentionKind; author: string } | null {
  const t = n.body?.type;
  if (t === "mention") {
    const postUri = typeof n.body.post_uri === "string" ? n.body.post_uri : "";
    const author = typeof n.body.mentioned_by === "string" ? n.body.mentioned_by : "";
    if (!postUri || !author) return null;
    try {
      parsePostUri(postUri);
    } catch {
      return null;
    }
    return { key: postUri, kind: "mention", author: extractPubkey(author) };
  }
  if (t === "reply") {
    const replyUri = typeof n.body.reply_uri === "string" ? n.body.reply_uri : "";
    const author = typeof n.body.replied_by === "string" ? n.body.replied_by : "";
    if (!replyUri || !author) return null;
    try {
      parsePostUri(replyUri);
    } catch {
      return null;
    }
    return { key: replyUri, kind: "reply", author: extractPubkey(author) };
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
