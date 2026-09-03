import { parsePostUri, type Notification, type PostView, type UserDetails } from "./types.js";

export class Nexus {
  constructor(private readonly base: string) {}

  host(): string {
    return new URL(this.base).host;
  }

  async notifications(botPk: string, end: number | null, limit = 20): Promise<Notification[]> {
    const url = new URL(`/v0/user/${botPk}/notifications`, this.base);
    url.searchParams.set("limit", String(limit));
    if (end !== null && end > 0) url.searchParams.set("end", String(end));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`notifications ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return [];
    return body as Notification[];
  }

  async post(uri: string): Promise<PostView | null> {
    let parsed;
    try {
      parsed = parsePostUri(uri);
    } catch {
      return null;
    }
    const url = new URL(`/v0/post/${parsed.author}/${parsed.postId}`, this.base);
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`post ${res.status}`);
    return (await res.json()) as PostView;
  }

  async userDetails(id: string): Promise<UserDetails | null> {
    const url = new URL(`/v0/user/${id}/details`, this.base);
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as UserDetails;
  }

  async user(id: string): Promise<unknown | null> {
    const url = new URL(`/v0/user/${id}`, this.base);
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`user ${res.status}`);
    return res.json();
  }

  async userTags(id: string): Promise<unknown> {
    const url = new URL(`/v0/user/${id}/tags`, this.base);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`user tags ${res.status}`);
    return res.json();
  }

  async postReplies(author: string, postId: string, limit: number): Promise<unknown> {
    const url = new URL(`/v0/stream/posts`, this.base);
    url.searchParams.set("source", "post_replies");
    url.searchParams.set("author_id", author);
    url.searchParams.set("post_id", postId);
    url.searchParams.set("limit", String(limit));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`replies ${res.status}`);
    return res.json();
  }

  async searchPostsByTag(tag: string, limit: number): Promise<unknown> {
    const url = new URL(`/v0/search/posts/by_tag/${encodeURIComponent(tag)}`, this.base);
    url.searchParams.set("limit", String(limit));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`tag search ${res.status}`);
    return res.json();
  }
}

export async function walkAncestors(nexus: Nexus, leaf: PostView, max = 25): Promise<PostView[]> {
  const chain: PostView[] = [leaf];
  const seen = new Set<string>([leaf.details.uri]);
  let current = leaf;
  while (chain.length < max) {
    const parent = current.relationships?.replied;
    if (!parent) break;
    if (seen.has(parent)) break;
    const next = await nexus.post(parent);
    if (!next) break;
    chain.push(next);
    seen.add(next.details.uri);
    current = next;
  }
  return chain;
}
