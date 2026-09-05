import type { Config } from "../config.js";
import { log } from "../log.js";
import type { Nexus } from "../nexus.js";
import type { PostView } from "../types.js";
import { parsePostUri } from "../types.js";
import { sanitizeFeedbackQuote } from "./sanitize-quote.js";
import type { TrackedProject } from "./types.js";

export interface CandidatePost {
  uri: string;
  author: string;
  content: string;
  indexedAt: number;
  engagement: number;
  projectIds: string[];
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

function textMentions(hay: string, needle: string): boolean {
  if (needle.length < 3) return false;
  return new RegExp(`\\b${escapeRe(needle)}\\b`, "i").test(hay);
}

function assignProjects(text: string, projects: TrackedProject[]): string[] {
  const hits: string[] = [];
  for (const p of projects) {
    const needles = [p.name, p.id, ...p.aliases, ...p.tags].filter(Boolean);
    if (needles.some((n) => textMentions(text, n))) hits.push(p.id);
  }
  return hits;
}

export async function gatherProjectCandidates(opts: {
  cfg: Config;
  nexus: Nexus;
  projects: TrackedProject[];
  sinceMs: number;
  untilMs: number;
  botPk?: string;
  searchKeyword?: (query: string) => Promise<Array<{ uri: string; author: string; content: string; indexedAt: number }>>;
}): Promise<CandidatePost[]> {
  const byUri = new Map<string, CandidatePost>();
  const add = (post: CandidatePost) => {
    if (opts.botPk && post.author === opts.botPk) return;
    if (post.indexedAt < opts.sinceMs || post.indexedAt > opts.untilMs) return;
    const existing = byUri.get(post.uri);
    if (existing) {
      existing.projectIds = [...new Set([...existing.projectIds, ...post.projectIds])];
      existing.engagement = Math.max(existing.engagement, post.engagement);
      return;
    }
    byUri.set(post.uri, post);
  };

  const fromView = (view: PostView, projectIds: string[]): CandidatePost | null => {
    try {
      parsePostUri(view.details.uri);
    } catch {
      return null;
    }
    return {
      uri: view.details.uri,
      author: view.details.author,
      content: sanitizeFeedbackQuote(view.details.content),
      indexedAt: view.details.indexed_at,
      engagement: engagementScore(view),
      projectIds,
    };
  };

  for (const project of opts.projects.filter((p) => p.status === "active")) {
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
          if (!uri) continue;
          const view = await opts.nexus.post(uri);
          if (!view) continue;
          const cand = fromView(view, [project.id]);
          if (cand) add({ ...cand, engagement: Math.max(cand.engagement, hit.score) });
        }
      } catch (e) {
        log.warn({ err: String(e), tag, project: project.id }, "weekly tag search failed");
      }
    }
    for (const pk of project.pubky_ids) {
      try {
        const posts = await opts.nexus.streamPosts({
          source: "author",
          authorId: pk,
          end: opts.sinceMs,
          start: opts.untilMs,
          limit: 30,
        });
        for (const view of posts) {
          const cand = fromView(view, [project.id]);
          if (cand) add(cand);
        }
      } catch (e) {
        log.warn({ err: String(e), author: pk, project: project.id }, "weekly author stream failed");
      }
    }
    if (opts.searchKeyword) {
      for (const q of [project.name, ...project.aliases].filter((s) => s.length >= 6).slice(0, 3)) {
        try {
          const rows = await opts.searchKeyword(q);
          for (const row of rows) {
            try {
              parsePostUri(row.uri);
            } catch {
              continue;
            }
            add({
              uri: row.uri,
              author: row.author,
              content: sanitizeFeedbackQuote(row.content),
              indexedAt: row.indexedAt,
              engagement: 0,
              projectIds: assignProjects(`${row.content} ${q}`, opts.projects).length
                ? assignProjects(`${row.content} ${q}`, opts.projects)
                : [project.id],
            });
          }
        } catch (e) {
          log.warn({ err: String(e), q, project: project.id }, "weekly keyword search failed");
        }
      }
    }
  }

  return [...byUri.values()].sort((a, b) => b.engagement - a.engagement || b.indexedAt - a.indexedAt);
}
