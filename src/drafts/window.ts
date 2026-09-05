import { POST_ID, parsePostUri } from "../types.js";

/** Crockford base32 (no I, L, O, U). Pubky 13-char post ids encode a microsecond timestamp. */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const DEFAULT_WINDOW_DAYS = 7;

export interface TimeWindow {
  sinceMs: number;
  untilMs: number;
  windowDays: number;
}

export interface WindowPost {
  uri?: string;
  author_id?: string;
  post_id?: string;
  content?: string;
  content_preview?: string;
  indexed_at?: number;
  created_at?: number;
  kind?: string;
  deleted?: boolean;
}

export function draftWindow(nowMs = Date.now(), windowDays = DEFAULT_WINDOW_DAYS): TimeWindow {
  const days = Number.isFinite(windowDays) && windowDays > 0 ? Math.floor(windowDays) : DEFAULT_WINDOW_DAYS;
  return { sinceMs: nowMs - days * 24 * 60 * 60 * 1000, untilMs: nowMs, windowDays: days };
}

function crockfordValue(ch: string): number {
  const c = ch.toUpperCase();
  if (c === "O") return 0;
  if (c === "I" || c === "L") return 1;
  return CROCKFORD.indexOf(c);
}

/** Normalize epoch seconds / ms / µs to milliseconds. */
export function asUnixMs(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (raw > 1e14) return Math.floor(raw / 1000);
  if (raw > 1e12) return Math.floor(raw);
  if (raw > 1e9) return Math.floor(raw * 1000);
  return null;
}

/**
 * Encode a millisecond timestamp as a 13-char Pubky post id
 * (Crockford of the 8-byte big-endian microsecond timestamp).
 */
export function encodePostIdMs(ms: number): string {
  const micros = BigInt(Math.floor(ms)) * 1000n;
  const bytes = new Uint8Array(8);
  let n = micros;
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.slice(0, 13);
}

/** Decode a 13-char Crockford post id to milliseconds, or null if not a time id. */
export function decodePostIdMs(postId: string): number | null {
  const id = postId.trim().toUpperCase();
  if (!POST_ID.test(id) || id.length !== 13) return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of id) {
    const v = crockfordValue(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (bytes.length !== 8) return null;
  let micros = 0n;
  for (const b of bytes) micros = (micros << 8n) + BigInt(b);
  const ms = Number(micros / 1000n);
  if (!Number.isFinite(ms)) return null;
  // Spec: timestamp IDs are after 2024-10-01 and not far-future junk.
  if (ms < Date.parse("2024-10-01T00:00:00Z") || ms > Date.parse("2100-01-01T00:00:00Z")) return null;
  return Math.floor(ms);
}

export function postIdFromUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  try {
    return parsePostUri(uri).postId;
  } catch {
    const m = /\/posts\/([A-Z0-9]{13})$/i.exec(uri.trim());
    return m?.[1]?.toUpperCase();
  }
}

/**
 * Real post time: id-decoded Crockford timestamp when the id is a time id,
 * otherwise Nexus `created_at` / `indexed_at` (seconds, ms, or µs).
 */
export function postTimeMs(post: WindowPost): number | null {
  const id = (post.post_id ?? postIdFromUri(post.uri) ?? "").toUpperCase();
  const fromId = id ? decodePostIdMs(id) : null;
  if (fromId !== null) return fromId;
  for (const raw of [post.created_at, post.indexed_at]) {
    if (typeof raw === "number") {
      const ms = asUnixMs(raw);
      if (ms !== null) return ms;
    }
  }
  return null;
}

export function inWindow(post: WindowPost, window: TimeWindow): boolean {
  const t = postTimeMs(post);
  if (t === null) return false;
  return t >= window.sinceMs && t <= window.untilMs;
}

export function isEmptyOrDeleted(post: WindowPost): boolean {
  if (post.deleted === true) return true;
  const kind = (post.kind ?? "").toLowerCase();
  if (kind === "deleted") return true;
  const text = (post.content ?? post.content_preview ?? "").trim();
  return text.length === 0;
}

export function isOwnPost(post: WindowPost, botPk: string | undefined): boolean {
  if (!botPk) return false;
  const author = (post.author_id ?? "").toLowerCase();
  if (author && author === botPk.toLowerCase()) return true;
  if (post.uri) {
    try {
      return parsePostUri(post.uri).author.toLowerCase() === botPk.toLowerCase();
    } catch {
      return false;
    }
  }
  return false;
}

export function filterWindowPosts<T extends WindowPost>(
  posts: T[],
  opts: { window: TimeWindow; botPk?: string },
): T[] {
  return posts.filter((p) => inWindow(p, opts.window) && !isEmptyOrDeleted(p) && !isOwnPost(p, opts.botPk));
}
