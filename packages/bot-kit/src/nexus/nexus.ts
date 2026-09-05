import { fetchJson } from "../http.js";
import {
  assertAuthorId,
  notificationSchema,
  postViewSchema,
  tagSearchHitSchema,
  userDetailsSchema,
} from "../nexus-schema.js";
import { parsePostUri, type Notification, type PostView, type UserDetails } from "../types.js";

export type StreamSorting = "timeline" | "total_engagement";

export interface StreamPostsOpts {
  tags?: string[];
  source?: "author" | "all";
  authorId?: string;
  start?: number;
  end?: number;
  skip?: number;
  limit?: number;
  sorting?: StreamSorting;
}

export interface TagSearchOpts {
  start?: number;
  end?: number;
  skip?: number;
  sorting?: StreamSorting;
}

export interface TagSearchHit {
  post_key: string;
  score: number;
}

export class Nexus {
  constructor(
    private readonly base: string,
    readonly timeoutMs = 10_000,
  ) {}

  host(): string {
    return new URL(this.base).host;
  }

  async notifications(botPk: string, end: number | null, limit = 20): Promise<Notification[]> {
    const id = assertAuthorId(botPk);
    const url = new URL(`/v0/user/${id}/notifications`, this.base);
    url.searchParams.set("limit", String(limit));
    if (end !== null && end > 0) url.searchParams.set("end", String(end));
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status !== 200) throw new Error(`notifications ${status}`);
    if (!Array.isArray(body)) return [];
    const out: Notification[] = [];
    for (const item of body) {
      const parsed = notificationSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data as Notification);
    }
    return out;
  }

  async post(uri: string): Promise<PostView | null> {
    let parsed;
    try {
      parsed = parsePostUri(uri);
    } catch {
      return null;
    }
    assertAuthorId(parsed.author);
    const url = new URL(`/v0/post/${parsed.author}/${parsed.postId}`, this.base);
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`post ${status}`);
    const view = postViewSchema.safeParse(body);
    return view.success ? (view.data as PostView) : null;
  }

  async userDetails(id: string): Promise<UserDetails | null> {
    if (!/^[a-z0-9]{52}$/.test(id)) return null;
    const url = new URL(`/v0/user/${id}/details`, this.base);
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status !== 200) return null;
    const parsed = userDetailsSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  }

  async user(id: string): Promise<unknown | null> {
    const pk = assertAuthorId(id);
    const url = new URL(`/v0/user/${pk}`, this.base);
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`user ${status}`);
    return body;
  }

  async userTags(id: string): Promise<unknown> {
    const pk = assertAuthorId(id);
    const url = new URL(`/v0/user/${pk}/tags`, this.base);
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status !== 200) throw new Error(`user tags ${status}`);
    return body;
  }

  async postReplies(author: string, postId: string, limit: number): Promise<unknown> {
    const pk = assertAuthorId(author);
    const url = new URL(`/v0/stream/posts`, this.base);
    url.searchParams.set("source", "post_replies");
    url.searchParams.set("author_id", pk);
    url.searchParams.set("post_id", postId);
    url.searchParams.set("limit", String(limit));
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status !== 200) throw new Error(`replies ${status}`);
    return body;
  }

  async searchPostsByTag(tag: string, limit: number, opts?: TagSearchOpts): Promise<TagSearchHit[]> {
    const url = new URL(`/v0/search/posts/by_tag/${encodeURIComponent(tag)}`, this.base);
    url.searchParams.set("limit", String(limit));
    if (opts?.start !== undefined) url.searchParams.set("start", String(opts.start));
    if (opts?.end !== undefined) url.searchParams.set("end", String(opts.end));
    if (opts?.skip !== undefined) url.searchParams.set("skip", String(opts.skip));
    if (opts?.sorting) url.searchParams.set("sorting", opts.sorting);
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status !== 200) throw new Error(`tag search ${status}`);
    if (!Array.isArray(body)) return [];
    const out: TagSearchHit[] = [];
    for (const item of body) {
      const parsed = tagSearchHitSchema.safeParse(item);
      if (parsed.success) out.push({ post_key: parsed.data.post_key, score: parsed.data.score ?? 0 });
    }
    return out;
  }

  async streamPosts(opts: StreamPostsOpts = {}): Promise<PostView[]> {
    const url = new URL(`/v0/stream/posts`, this.base);
    if (opts.source) url.searchParams.set("source", opts.source);
    if (opts.authorId) {
      assertAuthorId(opts.authorId);
      url.searchParams.set("author_id", opts.authorId);
    }
    if (opts.tags && opts.tags.length > 0) url.searchParams.set("tags", opts.tags.slice(0, 5).join(","));
    if (opts.start !== undefined) url.searchParams.set("start", String(opts.start));
    if (opts.end !== undefined) url.searchParams.set("end", String(opts.end));
    if (opts.skip !== undefined) url.searchParams.set("skip", String(opts.skip));
    url.searchParams.set("limit", String(Math.min(30, Math.max(1, opts.limit ?? 20))));
    if (opts.sorting) url.searchParams.set("sorting", opts.sorting);
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status !== 200) throw new Error(`stream posts ${status}`);
    if (!Array.isArray(body)) return [];
    const out: PostView[] = [];
    for (const item of body) {
      const view = postViewSchema.safeParse(item);
      if (view.success) out.push(view.data as PostView);
    }
    return out;
  }

  /** Global hot tags. 404/empty → []. */
  async hotTags(limit = 40): Promise<string[]> {
    const url = new URL(`/v0/tags/hot`, this.base);
    url.searchParams.set("limit", String(limit));
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status === 404) return [];
    if (status !== 200) return [];
    return labelsFromUnknown(body);
  }

  /** Prefix search for existing tags. 404/empty → []. */
  async searchTags(prefix: string, limit = 20): Promise<string[]> {
    const q = prefix.trim().toLowerCase();
    if (!q) return [];
    const url = new URL(`/v0/search/tags/by_prefix/${encodeURIComponent(q)}`, this.base);
    url.searchParams.set("limit", String(limit));
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status === 404) return [];
    if (status !== 200) return [];
    return labelsFromUnknown(body);
  }
}

function labelsFromUnknown(body: unknown): string[] {
  const rows = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { tags?: unknown }).tags)
    ? (body as { tags: unknown[] }).tags
    : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    const label =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as { label?: unknown }).label === "string"
          ? (item as { label: string }).label
          : null;
    if (!label) continue;
    const n = label.trim().toLowerCase();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export async function walkAncestors(
  nexus: Nexus,
  leaf: PostView,
  max = 25,
): Promise<{ chain: PostView[]; unresolvedParent: boolean }> {
  const chain: PostView[] = [leaf];
  const seen = new Set<string>([leaf.details.uri]);
  let current = leaf;
  while (chain.length < max) {
    const parent = current.relationships?.replied;
    if (!parent) return { chain, unresolvedParent: false };
    if (seen.has(parent)) break;
    const next = await nexus.post(parent);
    if (!next) return { chain, unresolvedParent: true };
    chain.push(next);
    seen.add(next.details.uri);
    current = next;
  }
  return { chain, unresolvedParent: false };
}
