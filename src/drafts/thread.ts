import { walkAncestors, type Nexus } from "../nexus.js";
import { postViewSchema } from "../nexus-schema.js";
import { parsePostUri, type PostView } from "../types.js";
import { isAllowedEvidenceUri } from "./evidence-uri.js";
import { postLink } from "./scout-util.js";
import { sanitizeUntrustedDraftText } from "./finish.js";
import { filterWindowPosts, type TimeWindow } from "./window.js";

export interface ThreadPost {
  uri: string;
  author_id: string;
  post_id: string;
  content: string;
  indexed_at?: number;
  tags: string[];
  parent_uri?: string | null;
}

export interface ScoredThread {
  root: ThreadPost;
  posts: ThreadPost[];
  distinctAuthors: number;
  replies: number;
  tags: number;
  score: number;
}

export function threadPostFromView(view: PostView): ThreadPost | null {
  const content = view.details.content?.trim() ?? "";
  if (!content) return null;
  let author = view.details.author;
  let postId = view.details.id.toUpperCase();
  try {
    const parsed = parsePostUri(view.details.uri);
    author = parsed.author;
    postId = parsed.postId;
  } catch {
    return null;
  }
  return {
    uri: view.details.uri,
    author_id: author,
    post_id: postId,
    content,
    indexed_at: view.details.indexed_at,
    tags: (view.tags ?? []).map((t) => t.label).filter(Boolean),
    parent_uri: view.relationships?.replied ?? null,
  };
}

function asPostViews(body: unknown): PostView[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { posts?: unknown }).posts)
      ? (body as { posts: unknown[] }).posts
      : [];
  const out: PostView[] = [];
  for (const item of rows) {
    const parsed = postViewSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data as PostView);
  }
  return out;
}

export async function fetchFullThread(
  nexus: Nexus,
  uri: string,
  replyLimit = 40,
): Promise<ThreadPost[]> {
  const leaf = await nexus.post(uri);
  if (!leaf) return [];
  const walked = await walkAncestors(nexus, leaf, 25);
  const chain = walked.chain;
  const root = chain[chain.length - 1] ?? leaf;
  let replies: PostView[] = [];
  try {
    replies = asPostViews(await nexus.postReplies(root.details.author, root.details.id, replyLimit));
  } catch {
    replies = [];
  }
  const seen = new Set<string>();
  const posts: ThreadPost[] = [];
  for (const view of [...chain].reverse().concat(replies)) {
    const p = threadPostFromView(view);
    if (!p || seen.has(p.uri)) continue;
    seen.add(p.uri);
    posts.push(p);
  }
  return posts;
}

export function scoreThread(posts: ThreadPost[], window: TimeWindow, botPk?: string): ScoredThread | null {
  const usable = filterWindowPosts(posts, { window, botPk });
  if (usable.length === 0) return null;
  const root = usable.find((p) => !p.parent_uri) ?? usable[0];
  if (!root) return null;
  const authors = new Set(usable.map((p) => p.author_id).filter(Boolean));
  const tagSet = new Set(usable.flatMap((p) => p.tags));
  const replies = Math.max(0, usable.length - 1);
  const distinctAuthors = authors.size;
  const tags = tagSet.size;
  return {
    root,
    posts: usable,
    distinctAuthors,
    replies,
    tags,
    score: distinctAuthors * 4 + replies * 2 + tags,
  };
}

export function formatThreadForPrompt(thread: ScoredThread, appUrl: string): string {
  const lines = [
    `Root: ${postLink(thread.root.uri, appUrl) || thread.root.uri}`,
    `Authors: ${thread.distinctAuthors}; replies: ${thread.replies}; distinct tags: ${thread.tags}`,
    "",
  ];
  for (const p of thread.posts.slice(0, 16)) {
    const link = postLink(p.uri, appUrl) || p.uri;
    lines.push(`- ${p.author_id.slice(0, 8)}… ${link}`);
    lines.push(`  ${sanitizeUntrustedDraftText(p.content).slice(0, 400)}`);
  }
  return lines.join("\n");
}

export function threadEvidenceUris(thread: ScoredThread): string[] {
  const uris = thread.posts.map((p) => p.uri);
  for (const p of thread.posts) {
    if (p.author_id) uris.push(`pubky://${p.author_id}`);
  }
  return uris.filter((u) => isAllowedEvidenceUri(u));
}

export function candidateUri(post: { uri?: string; author_id?: string; post_id?: string }): string | undefined {
  if (post.uri) return post.uri;
  if (post.author_id && post.post_id) {
    return `pubky://${post.author_id}/pub/pubky.app/posts/${post.post_id.toUpperCase()}`;
  }
  return undefined;
}
