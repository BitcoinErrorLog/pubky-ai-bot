import { postTimestampMs } from "../bot-kit/crockford.js";
import type { Config } from "../config.js";
import { log } from "../log.js";
import type { Nexus } from "../nexus.js";
import type { PostView } from "../types.js";
import { mentionKey, parsePostUri } from "../types.js";
import { isJebAuthor, isUnusableContent } from "./content.js";
import { JEB_PUBKY, type TrackedProject } from "./types.js";

export interface CandidatePost {
  uri: string;
  author: string;
  content: string;
  indexedAt: number;
  engagement: number;
  projectIds: string[];
  tags: string[];
  replyCount?: number;
  tagCount?: number;
  mentioned?: string[];
}

export function engagementScore(post: Pick<PostView, "counts" | "tags">): number {
  const c = post.counts;
  if (c) return (c.replies ?? 0) + (c.reposts ?? 0) + (c.tags ?? 0);
  const taggers = (post.tags ?? []).reduce((n, t) => n + (t.taggers_count ?? t.taggers?.length ?? 0), 0);
  return taggers;
}

export function postKeyToUri(postKey: string): string | null {
  const [author, postId] = postKey.split(":");
  if (!author || !postId) return null;
  try {
    return `pubky://${author}/pub/pubky.app/posts/${postId}`;
  } catch {
    return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word match; hyphens and spaces in the needle are interchangeable. */
export function textMentions(hay: string, needle: string): boolean {
  const n = needle.trim();
  if (n.length < 3) return false;
  const flexible = escapeRe(n).replace(/[ \-]/g, "[\\s-]");
  return new RegExp(`(?<![A-Za-z0-9])${flexible}(?![A-Za-z0-9])`, "i").test(hay);
}

export function projectsNamedByPost(opts: {
  content: string;
  tags: string[];
  author: string;
  mentioned?: string[];
  projects: TrackedProject[];
}): string[] {
  const tagSet = new Set(opts.tags.map((t) => t.toLowerCase()));
  const mentioned = new Set((opts.mentioned ?? []).map((m) => m.toLowerCase()));
  const hits: string[] = [];
  for (const p of opts.projects) {
    if (p.pubky_ids.some((id) => id === opts.author || mentioned.has(id.toLowerCase()))) {
      hits.push(p.id);
      continue;
    }
    if (p.tags.some((t) => tagSet.has(t.toLowerCase()))) {
      hits.push(p.id);
      continue;
    }
    const needles = [p.name, ...p.aliases].filter((n) => n.trim().length >= 3);
    if (needles.some((n) => textMentions(opts.content, n))) hits.push(p.id);
  }
  return hits;
}

export function viewLabels(view: PostView): string[] {
  return (view.tags ?? []).map((t) => t.label).filter(Boolean);
}

export async function mentionUrisFromNotifications(
  nexus: Nexus,
  pubky: string,
  sinceMs: number,
): Promise<string[]> {
  const uris: string[] = [];
  let end: number | null = null;
  for (let page = 0; page < 20; page++) {
    const batch = await nexus.notifications(pubky, end, 30);
    if (batch.length === 0) break;
    let oldest = Infinity;
    for (const n of batch) {
      oldest = Math.min(oldest, n.timestamp);
      const parsed = mentionKey(n);
      if (parsed) uris.push(parsed.key);
    }
    if (oldest < sinceMs) break;
    const nextEnd = Math.min(...batch.map((n) => n.timestamp));
    if (end !== null && nextEnd >= end) break;
    end = nextEnd;
  }
  return [...new Set(uris)];
}

export async function gatherProjectCandidates(opts: {
  cfg: Config;
  nexus: Nexus;
  projects: TrackedProject[];
  sinceMs: number;
  untilMs: number;
  botPk?: string;
  searchKeyword?: (query: string) => Promise<Array<{ uri: string }>>;
  mentionsOf?: (pubky: string) => Promise<Array<{ uri: string }>>;
}): Promise<CandidatePost[]> {
  const byUri = new Map<string, CandidatePost>();
  const add = (post: CandidatePost) => {
    const existing = byUri.get(post.uri);
    if (existing) {
      existing.projectIds = [...new Set([...existing.projectIds, ...post.projectIds])];
      existing.engagement = Math.max(existing.engagement, post.engagement);
      if (post.content.length > existing.content.length) existing.content = post.content;
      if ((post.tags?.length ?? 0) > (existing.tags?.length ?? 0)) existing.tags = post.tags;
      return;
    }
    byUri.set(post.uri, post);
  };

  const fromFullView = (view: PostView, extraEngagement = 0): CandidatePost | null => {
    try {
      parsePostUri(view.details.uri);
    } catch {
      return null;
    }
    if (isUnusableContent(view.details.content)) return null;
    if (isJebAuthor(view.details.author, opts.botPk)) return null;
    const details = view.details as typeof view.details & { created_at?: number };
    const ts = postTimestampMs({
      postId: view.details.id,
      indexedAt: view.details.indexed_at,
      createdAt: details.created_at,
    });
    if (ts === null || ts < opts.sinceMs || ts > opts.untilMs) return null;
    const tags = viewLabels(view);
    const mentioned = view.relationships?.mentioned ?? [];
    const projectIds = projectsNamedByPost({
      content: view.details.content,
      tags,
      author: view.details.author,
      mentioned,
      projects: opts.projects,
    });
    if (projectIds.length === 0) return null;
    return {
      uri: view.details.uri,
      author: view.details.author,
      content: view.details.content,
      indexedAt: ts,
      engagement: Math.max(engagementScore(view), extraEngagement),
      projectIds,
      tags,
      replyCount: view.counts?.replies,
      tagCount: view.counts?.tags ?? view.counts?.unique_tags,
      mentioned,
    };
  };

  const ingestUri = async (uri: string, extraEngagement = 0) => {
    try {
      parsePostUri(uri);
    } catch {
      return;
    }
    try {
      const view = await opts.nexus.post(uri);
      if (!view) return;
      const cand = fromFullView(view, extraEngagement);
      if (cand) add(cand);
    } catch (e) {
      log.warn({ err: String(e), uri }, "weekly full post fetch failed");
    }
  };

  const active = opts.projects.filter((p) => p.status === "active");
  const jebPks = new Set<string>([JEB_PUBKY]);
  if (opts.botPk) jebPks.add(opts.botPk);
  for (const p of active) {
    for (const id of p.pubky_ids) {
      if (p.id === "jeb") jebPks.add(id);
    }
  }

  for (const project of active) {
    const labels = [...new Set(project.tags.map((t) => t.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20)).filter(Boolean))];
    for (const tag of labels) {
      try {
        const hits = await opts.nexus.searchPostsByTag(tag, 30, {
          end: opts.sinceMs,
          start: opts.untilMs,
          sorting: "total_engagement",
        });
        for (const hit of hits) {
          const uri = postKeyToUri(hit.post_key);
          if (uri) await ingestUri(uri, hit.score);
        }
      } catch (e) {
        log.warn({ err: String(e), tag, project: project.id }, "weekly tag search failed");
      }
    }
    for (const pk of project.pubky_ids) {
      if (jebPks.has(pk)) continue;
      try {
        const posts = await opts.nexus.streamPosts({
          source: "author",
          authorId: pk,
          end: opts.sinceMs,
          start: opts.untilMs,
          limit: 30,
        });
        for (const view of posts) {
          await ingestUri(view.details.uri);
        }
      } catch (e) {
        log.warn({ err: String(e), author: pk, project: project.id }, "weekly author stream failed");
      }
    }
    for (const pk of project.pubky_ids) {
      if (opts.mentionsOf) {
        try {
          const rows = await opts.mentionsOf(pk);
          for (const row of rows) await ingestUri(row.uri);
        } catch (e) {
          log.warn({ err: String(e), pubky: pk, project: project.id }, "weekly mentions_of failed");
        }
      }
      try {
        const uris = await mentionUrisFromNotifications(opts.nexus, pk, opts.sinceMs);
        for (const uri of uris) await ingestUri(uri);
      } catch (e) {
        log.warn({ err: String(e), pubky: pk, project: project.id }, "weekly notifications failed");
      }
    }
    if (opts.searchKeyword) {
      for (const q of [project.name, ...project.aliases].filter((s) => s.length >= 6).slice(0, 3)) {
        try {
          const rows = await opts.searchKeyword(q);
          for (const row of rows) await ingestUri(row.uri);
        } catch (e) {
          log.warn({ err: String(e), q, project: project.id }, "weekly keyword search failed");
        }
      }
    }
  }

  return [...byUri.values()].sort((a, b) => b.engagement - a.engagement || b.indexedAt - a.indexedAt);
}
