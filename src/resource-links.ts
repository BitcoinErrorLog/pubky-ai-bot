import type { ExternalResourceInput, ResourceRun } from "./external-resources.js";
import { discoverResources, RESOURCE_RECORD_MAX, validateResourceLimit } from "./external-resources.js";
import { getDomain } from "tldts";
import { fetchResourceText, type FetchResourceResult } from "./resource-fetch.js";
import {
  DiscoveryRequestBudget,
  DiscoveryRequestBudgetExceeded,
  discoverPubkyPosts,
  extractPostUrls,
  type PostAdapterOptions,
  type PostCandidate,
} from "./resource-posts.js";
import { normalizeUri } from "./resource-identity.js";
import type { Nexus } from "./nexus.js";
import type { PostView } from "./types.js";
import type { PublicHomeserverReader } from "./pubchi/homeserver-read.js";

export type LinkRejectionReason =
  | "non-http-url"
  | "pubky-url"
  | "duplicate-link"
  | "already-jeb-tagged"
  | "nexus-unavailable"
  | "fetch-failed"
  | "host-quota"
  | "discovery-request-budget"
  | "invalid-url";

export type LinkAdapterOptions = Omit<PostAdapterOptions, "requestBudget"> & {
  configVersion?: string;
  fetchPage?: (url: string) => Promise<FetchResourceResult>;
  alreadyJebTagged?: (url: string) => Promise<boolean>;
  requestBudget?: DiscoveryRequestBudget;
};

export interface LinkCandidate extends ExternalResourceInput {
  family: "url";
  source: "pubky-links";
  sharingPostUris: string[];
}

export interface LinkShadowRun extends ResourceRun {
  bySharingPost: Record<string, string[]>;
  linkHostHistogram: Record<string, number>;
  linkRejections: Record<string, number>;
  postRejections: Record<string, number>;
}

function count(out: Record<string, number>, reason: string): void {
  out[reason] = (out[reason] ?? 0) + 1;
}

function postText(post: PostView): string {
  return post.details.content.trim();
}

function attachmentUrls(post: PostView): string[] {
  return (post.details.attachments ?? []).filter((value): value is string => typeof value === "string");
}

function candidateUrls(post: PostView): string[] {
  const dynamic = post.details as PostView["details"] & { links?: unknown; embeds?: unknown };
  const embedded = [...(Array.isArray(dynamic.links) ? dynamic.links : []), ...(Array.isArray(dynamic.embeds) ? dynamic.embeds : [])]
    .filter((value): value is string => typeof value === "string");
  return [...new Set([...extractPostUrls(post.details.content), ...attachmentUrls(post), ...embedded])];
}

function scoreForSharing(candidate: PostCandidate, sharingCount: number): Record<string, number> {
  const source = candidate.scoreComponents;
  return {
    pubky_signal: Math.min(1, (source.pubky_signal ?? 0) * Math.max(1, sharingCount)),
    authority: source.authority ?? 0,
    durability: source.durability ?? 0,
    origin_engagement: source.origin_engagement ?? 0,
    freshness: source.freshness ?? 0,
    cost_penalty: source.cost_penalty ?? 0,
  };
}

function linkScore(score: Record<string, number>): number {
  return 3 * score.pubky_signal + 2 * score.authority + 2 * score.durability +
    score.origin_engagement + score.freshness - score.cost_penalty;
}

function rejectionInput(url: string): ExternalResourceInput {
  return { family: "url", value: url, source: "pubky-links", labels: [] };
}

function quotaDomain(value: string): string {
  const hostname = new URL(value).hostname.toLowerCase();
  return getDomain(hostname) ?? hostname;
}

function priorityThenValue(a: LinkCandidate, b: LinkCandidate): number {
  return (a.sourcePriority ?? 0) - (b.sourcePriority ?? 0) || a.value.localeCompare(b.value);
}

export async function discoverPubkyLinks(opts: LinkAdapterOptions): Promise<LinkShadowRun> {
  const limit = validateResourceLimit(opts.limit);
  const budget = opts.requestBudget ?? new DiscoveryRequestBudget(limit);
  const linkRejections: Record<string, number> = {};
  const byUrl = new Map<string, LinkCandidate>();
  const checkedUrls = new Set<string>();
  const hostQuota = Math.max(1, Math.ceil(limit * 0.2));
  const bySharingPost: Record<string, string[]> = Object.create(null);
  const fetchPage = opts.fetchPage ?? ((url: string) => fetchResourceText(url));
  const alreadyJebTagged = opts.alreadyJebTagged ?? (async () => false);
  const postRun = await discoverPubkyPosts({
    ...opts,
    fetchLinks: false,
    requestBudget: budget,
  });
  for (const postCandidate of postRun.candidates) {
    const post = postCandidate.post;
    for (const rawUrl of candidateUrls(post)) {
      if (!/^https?:\/\//i.test(rawUrl)) {
        count(linkRejections, rawUrl.toLowerCase().startsWith("pubky://") ? "pubky-url" : "non-http-url");
        continue;
      }
      if (!/^https:\/\//i.test(rawUrl)) {
        count(linkRejections, "invalid-url");
        continue;
      }
      let canonical: string;
      try {
        canonical = normalizeUri(rawUrl);
      } catch {
        count(linkRejections, "invalid-url");
        continue;
      }
      if (byUrl.has(canonical)) {
        const existing = byUrl.get(canonical)!;
        if (!existing.sharingPostUris.includes(post.details.uri)) existing.sharingPostUris.push(post.details.uri);
        bySharingPost[canonical] = existing.sharingPostUris;
        existing.scoreComponents = scoreForSharing(postCandidate, existing.sharingPostUris.length);
        existing.sourcePriority = linkScore(existing.scoreComponents);
        continue;
      }
      if (checkedUrls.has(canonical)) continue;
      checkedUrls.add(canonical);
      try {
        budget.consume();
      } catch (error) {
        if (error instanceof DiscoveryRequestBudgetExceeded) {
          count(linkRejections, "discovery-request-budget");
          break;
        }
        throw error;
      }
      try {
        if (await alreadyJebTagged(canonical)) {
          count(linkRejections, "already-jeb-tagged");
          continue;
        }
      } catch {
        count(linkRejections, "nexus-unavailable");
        continue;
      }
      const fetched = await fetchPage(canonical).catch(() => ({ ok: false, reason: "network" } as const));
      if (!fetched.ok) {
        count(linkRejections, fetched.reason === "content_type" ? "content_type" : "fetch-failed");
        continue;
      }
      const scoreComponents = scoreForSharing(postCandidate, 1);
      const link: LinkCandidate = {
        family: "url",
        value: canonical,
        source: "pubky-links",
        labels: [],
        title: fetched.title,
        description: fetched.description,
        bodyText: fetched.text,
        authors: fetched.authors,
        tagHints: postCandidate.existingTags,
        metadata: { sharedPostText: postText(post) },
        scoreComponents,
        sourcePriority: linkScore(scoreComponents),
        sharingPostUris: [post.details.uri],
      };
      const domain = quotaDomain(canonical);
      const sameDomain = [...byUrl.values()].filter((item) => quotaDomain(item.value) === domain);
      if (sameDomain.length >= hostQuota) {
        const lowest = sameDomain.sort(priorityThenValue)[0];
        if (!lowest || priorityThenValue(link, lowest) >= 0) {
          count(linkRejections, "host-quota");
          continue;
        }
        byUrl.delete(lowest.value);
        delete bySharingPost[lowest.value];
      }
      byUrl.set(canonical, link);
      bySharingPost[canonical] = link.sharingPostUris;
      if (byUrl.size > RESOURCE_RECORD_MAX) {
        const lowest = [...byUrl.values()].sort((a, b) => priorityThenValue(b, a)).at(-1);
        if (lowest) {
          byUrl.delete(lowest.value);
          delete bySharingPost[lowest.value];
        }
      }
    }
  }
  const hostCounts = new Map<string, number>();
  const selected = [...byUrl.values()]
    .sort((a, b) => priorityThenValue(b, a))
    .filter((link) => {
      const host = quotaDomain(link.value);
      const countForHost = hostCounts.get(host) ?? 0;
      if (countForHost >= hostQuota) {
        count(linkRejections, "host-quota");
        return false;
      }
      hostCounts.set(host, countForHost + 1);
      return true;
    });
  const result = discoverResources(selected, {
    category: "pubky",
    limit,
    configVersion: opts.configVersion ?? "external-resources-v3-bitcoin-canon",
  });
  const linkHostHistogram: Record<string, number> = Object.create(null);
  for (const accepted of result.accepted) {
    const host = new URL(accepted.canonicalValue).hostname.toLowerCase();
    count(linkHostHistogram, host);
  }
  return { ...result, bySharingPost, linkHostHistogram, linkRejections, postRejections: postRun.postRejections };
}

