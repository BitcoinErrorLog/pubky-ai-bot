import { z } from "zod";
import { Z32, parsePostUri } from "../types.js";
import { walkAncestors, type Nexus } from "./nexus.js";

export function assertNexusUrl(url: URL, allowedHost: string): void {
  if (url.host !== allowedHost) throw new Error("ssrf: host not allowed");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("ssrf: bad protocol");
}

export function parseUserPk(pubky: string): string {
  const id = pubky.trim();
  if (!Z32.test(id)) throw new Error("invalid pubky");
  return id;
}

export function clampLimit(n: number, max = 30): number {
  if (!Number.isFinite(n)) return 10;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

export function nexusTools(nexus: Nexus) {
  const host = nexus.host();
  const guard = (path: string) => {
    const url = new URL(path, `https://${host}`);
    assertNexusUrl(url, host);
  };
  return {
    get_post: {
      description: "Fetch a Pubky post by canonical URI",
      parameters: z.object({ uri: z.string() }),
      execute: async ({ uri }: { uri: string }) => {
        parsePostUri(uri);
        guard(`/v0/post/x/x`);
        const post = await nexus.post(uri);
        return { uri, post, provenance: "nexus" };
      },
    },
    get_thread: {
      description: "Walk ancestor thread for a post URI",
      parameters: z.object({ uri: z.string(), depth: z.number().optional() }),
      execute: async ({ uri, depth }: { uri: string; depth?: number }) => {
        parsePostUri(uri);
        const leaf = await nexus.post(uri);
        if (!leaf) return { uri, posts: [], provenance: "nexus" };
        const walked = await walkAncestors(nexus, leaf, clampLimit(depth ?? 25, 25));
        return { uri, posts: walked.chain.map((p) => p.details.uri), provenance: "nexus" };
      },
    },
    get_user: {
      description: "Fetch a Pubky user profile",
      parameters: z.object({ pubky: z.string() }),
      execute: async ({ pubky }: { pubky: string }) => {
        const id = parseUserPk(pubky);
        return { pubky: id, user: await nexus.user(id), provenance: "nexus" };
      },
    },
    get_user_tags: {
      description: "Fetch tags on a user",
      parameters: z.object({ pubky: z.string() }),
      execute: async ({ pubky }: { pubky: string }) => {
        const id = parseUserPk(pubky);
        return { pubky: id, tags: await nexus.userTags(id), provenance: "nexus" };
      },
    },
    search_posts_by_tag: {
      description: "Search posts by tag label",
      parameters: z.object({ tag: z.string(), limit: z.number().optional() }),
      execute: async ({ tag, limit }: { tag: string; limit?: number }) => {
        const cleaned = tag.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20);
        if (!cleaned) throw new Error("invalid tag");
        return {
          tag: cleaned,
          posts: await nexus.searchPostsByTag(cleaned, clampLimit(limit ?? 10)),
          provenance: "nexus",
        };
      },
    },
    get_post_replies: {
      description: "List replies to a post",
      parameters: z.object({ uri: z.string(), limit: z.number().optional() }),
      execute: async ({ uri, limit }: { uri: string; limit?: number }) => {
        const { author, postId } = parsePostUri(uri);
        return {
          uri,
          replies: await nexus.postReplies(author, postId, clampLimit(limit ?? 10)),
          provenance: "nexus",
        };
      },
    },
  };
}
