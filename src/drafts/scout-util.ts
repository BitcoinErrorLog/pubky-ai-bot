import { postAppUrl } from "../links.js";
import type { createScoutTools } from "../scout/tools.js";

export type ScoutTools = ReturnType<typeof createScoutTools>;

export function asPosts(out: unknown): Array<{ uri?: string; author_id?: string; post_id?: string; content_preview?: string; score?: number; indexed_at?: number }> {
  if (!out || typeof out !== "object") return [];
  const posts = (out as { posts?: unknown }).posts;
  if (!Array.isArray(posts)) return [];
  return posts.filter((p) => p && typeof p === "object") as Array<{
    uri?: string;
    author_id?: string;
    post_id?: string;
    content_preview?: string;
    score?: number;
    indexed_at?: number;
  }>;
}

export function postLink(uri: string, appUrl: string): string {
  const m = /^pubky:\/\/([a-z0-9]{52})\/pub\/pubky\.app\/posts\/([A-Z0-9]{13})$/i.exec(uri.trim());
  if (!m) return uri;
  return postAppUrl(m[1], m[2].toUpperCase(), appUrl);
}

export function sinceYesterdayMs(now = Date.now()): number {
  return now - 24 * 60 * 60 * 1000;
}
