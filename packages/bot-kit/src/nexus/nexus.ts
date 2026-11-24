import { buildUri, parseUri } from "pubky-social-specs";
import { fetchJson } from "../http.js";
import { z } from "zod";
import {
  assertAuthorId,
  notificationSchema,
  postViewSchema,
  tagSearchHitSchema,
  userDetailsSchema,
  socialUserDetailsSchema,
  userTagsSchema,
  socialUserTagsSchema,
  socialPostViewSchema,
  influencersSchema,
} from "../nexus-schema.js";
import { parsePostUri, parseSocialPostUri, type Notification, type PostView, type UserDetails } from "../types.js";

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
  uri?: string;
  score: number;
}

export type Influencer = z.infer<typeof influencersSchema>[number];

/** Nexus retains the stored address for unmigrated authors, even on its v1 API. */
export function canonicalNexusPostUri(uri: string): string | null {
  if (!uri.startsWith("pubky://") || uri !== uri.trim()) return null;
  try {
    const location = parseUri(uri);
    if (location.kind === "post" && location.root === "public") {
      return buildUri(location.owner, "post", location.id);
    }
    if (location.kind === "foreign") {
      const { author, postId } = parsePostUri(uri);
      return buildUri(author, "post", postId);
    }
  } catch {
    // A malformed stored address cannot be used as evidence.
  }
  return null;
}

export class Nexus {
  constructor(
    private readonly base: string,
    readonly timeoutMs = 10_000,
    readonly version: "v0" | "v1" = "v0",
  ) {}

  private url(path: string): URL {
    return new URL(`/${this.version}/${path}`, this.base);
  }

  get postAddress(): typeof parsePostUri {
    return this.version === "v1" ? parseSocialPostUri : parsePostUri;
  }

  private postView(body: unknown): PostView | null {
    if (this.version === "v0") {
      const view = postViewSchema.safeParse(body);
      return view.success ? view.data : null;
    }
    const view = socialPostViewSchema.safeParse(body);
    if (!view.success || view.data.details.deleted) return null;
    const { details, relationships } = view.data;
    const uri = canonicalNexusPostUri(details.uri);
    if (!uri) return null;
    const { author, postId } = this.postAddress(uri);
    if (author !== details.author || postId !== details.id) return null;
    if (relationships?.replied) relationships.replied = canonicalNexusPostUri(relationships.replied);
    if (relationships?.reposted) relationships.reposted = canonicalNexusPostUri(relationships.reposted);
    return { ...view.data, details: { ...details, uri } };
  }

  private postList(body: unknown): PostView[] {
    if (!Array.isArray(body)) return [];
    const out: PostView[] = [];
    for (const item of body) {
      const post = this.postView(item);
      if (post) out.push(post);
    }
    return out;
  }

  host(): string {
    return new URL(this.base).host;
  }

  async notifications(botPk: string, end: number | null, limit = 20): Promise<Notification[]> {
    const id = assertAuthorId(botPk);
    const url = this.url(`user/${id}/notifications`);
    url.searchParams.set("limit", String(limit));
    if (end !== null && end > 0) url.searchParams.set("end", String(end));
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status !== 200) throw new Error(`notifications ${status}`);
    if (!Array.isArray(body)) return [];
    const out: Notification[] = [];
    for (const item of body) {
      const parsed = notificationSchema.safeParse(item);
      if (!parsed.success) continue;
      if (this.version === "v1") {
        for (const [key, value] of Object.entries(parsed.data.body)) {
          if (key.endsWith("_uri") && typeof value === "string") {
            parsed.data.body[key] = canonicalNexusPostUri(value);
          }
        }
      }
      out.push(parsed.data);
    }
    return out;
  }

  async post(uri: string): Promise<PostView | null> {
    const parseAddress = this.postAddress;
    let parsed;
    try {
      parsed = parseAddress(uri);
    } catch {
      return null;
    }
    assertAuthorId(parsed.author);
    const url = this.url(`post/${parsed.author}/${parsed.postId}`);
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`post ${status}`);
    const view = this.postView(body);
    return this.version === "v1" && view?.details.uri !== uri ? null : view;
  }

  async userDetails(id: string, signal?: AbortSignal): Promise<UserDetails | null> {
    if (!/^[a-z0-9]{52}$/.test(id)) return null;
    const url = this.url(`user/${id}/details`);
    const { status, body } = await fetchJson(url, this.timeoutMs, undefined, signal);
    if (status !== 200) return null;
    if (this.version === "v1") {
      const parsed = socialUserDetailsSchema.safeParse(body);
      return parsed.success && !parsed.data.deleted && parsed.data.id === id ? parsed.data : null;
    }
    const parsed = userDetailsSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  }

  async user(id: string): Promise<unknown | null> {
    const pk = assertAuthorId(id);
    const url = this.url(`user/${pk}`);
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status === 404) return null;
    if (status !== 200) throw new Error(`user ${status}`);
    return body;
  }

  async userTags(id: string): Promise<z.infer<typeof userTagsSchema> | null> {
    const pk = assertAuthorId(id);
    const url = this.url(`user/${pk}/tags`);
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status === 404) return null;
    if (status !== 200) {
      const error = new Error(`user tags ${status}`) as Error & { status?: number };
      error.status = status;
      throw error;
    }
    const schema = this.version === "v1" ? socialUserTagsSchema : userTagsSchema;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const error = new Error("user tags schema mismatch") as Error & { zodIssueCount?: number };
      error.zodIssueCount = parsed.error.issues.length;
      throw error;
    }
    return parsed.data;
  }

  async postReplies(author: string, postId: string, limit: number): Promise<unknown> {
    const pk = assertAuthorId(author);
    const url = this.url("stream/posts");
    url.searchParams.set("source", "post_replies");
    url.searchParams.set("author_id", pk);
    url.searchParams.set("post_id", postId);
    url.searchParams.set("limit", String(limit));
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status !== 200) throw new Error(`replies ${status}`);
    return this.version === "v1" ? this.postList(body) : body;
  }

  async searchPostsByTag(tag: string, limit: number, opts?: TagSearchOpts): Promise<TagSearchHit[]> {
    if (this.version === "v1" && (tag === "." || tag === "..")) return [];
    const url = this.url(`search/posts/by_tag/${encodeURIComponent(tag)}`);
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
      if (!parsed.success) continue;
      const hit: TagSearchHit = { post_key: parsed.data.post_key, score: parsed.data.score ?? 0 };
      if (this.version === "v1") {
        const [author, id, ...rest] = hit.post_key.split(":");
        if (!author || !id || rest.length) continue;
        try {
          hit.uri = buildUri(author, "post", id);
        } catch {
          continue;
        }
      }
      out.push(hit);
    }
    return out;
  }

  async streamPosts(opts: StreamPostsOpts = {}): Promise<PostView[]> {
    const url = this.url("stream/posts");
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
    return this.postList(body);
  }

  /** Global hot tags. 404/empty → []. */
  async hotTags(limit = 40): Promise<string[]> {
    const url = this.url("tags/hot");
    url.searchParams.set("limit", String(limit));
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status === 404) return [];
    if (status !== 200) return [];
    return labelsFromUnknown(body, this.version);
  }

  /** Prefix search for existing tags. 404/empty → []. */
  async searchTags(prefix: string, limit = 20): Promise<string[]> {
    const q = this.version === "v1" ? prefix.trim() : prefix.trim().toLowerCase();
    if (!q || (this.version === "v1" && (q === "." || q === ".."))) return [];
    const url = this.url(`search/tags/by_prefix/${encodeURIComponent(q)}`);
    url.searchParams.set("limit", String(limit));
    const { status, body } = await fetchJson(url, this.timeoutMs);
    if (status === 404) return [];
    if (status !== 200) return [];
    return labelsFromUnknown(body, this.version);
  }

  async influencers(limit = 10, timeframe = "all_time"): Promise<Influencer[]> {
    const url = this.url("stream/users");
    url.searchParams.set("source", "influencers");
    url.searchParams.set("limit", String(Math.min(50, Math.max(1, Math.floor(limit)))));
    url.searchParams.set("timeframe", timeframe);
    const { status, body } = await fetchJson(url, Math.min(this.timeoutMs, 5_000));
    if (status !== 200) throw new Error(`influencers ${status}`);
    const parsed = influencersSchema.safeParse(body);
    if (!parsed.success) {
      const error = new Error("influencers schema mismatch") as Error & { zodIssueCount?: number };
      error.zodIssueCount = parsed.error.issues.length;
      throw error;
    }
    return parsed.data;
  }
}

function labelsFromUnknown(body: unknown, version: "v0" | "v1"): string[] {
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
    const n = version === "v1" ? label.trim() : label.trim().toLowerCase();
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
