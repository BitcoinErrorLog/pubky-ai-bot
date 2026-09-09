import type { ExternalResourceInput, ResourceRun } from "./external-resources.js";
import { discoverResources, RESOURCE_RECORD_MAX, validateResourceLimit } from "./external-resources.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { fetchResourceText } from "./resource-fetch.js";
import { postTimestampMs, PUBKY_POST_ID_RE } from "./bot-kit/crockford.js";
import type { Nexus } from "./nexus.js";
import type { PostView } from "./types.js";
import type { PublicHomeserverReader } from "./pubchi/homeserver-read.js";

export type PostPool = "engaged-longform" | "human-tagged" | "hot-tags" | "incremental";
export type PostRejectionReason =
  | "reply"
  | "repost"
  | "new-author"
  | "too-young"
  | "author-muted-publisher"
  | "mute-check-failed"
  | "discovery-request-budget"
  | "invalid timestamp"
  | "future timestamp"
  | "stale timestamp"
  | "short-without-link"
  | "no-human-tag"
  | "below-engagement-floor"
  | "unsupported-post-uri"
  | "invalid-post";

export interface PostScoreComponents {
  pubky_signal: number;
  authority: number;
  durability: number;
  origin_engagement: number;
  freshness: number;
  cost_penalty: number;
}

export interface PostCandidate extends ExternalResourceInput {
  family: "stable-identifier";
  source: "pubky-posts";
  pool: PostPool;
  existingTags: string[];
  scoreComponents: PostScoreComponents & Record<string, number>;
  linkedUrl?: string;
}

export interface PostShadowRun extends ResourceRun {
  postRejections: Record<string, number>;
  candidates: PostCandidate[];
}

export interface PostAdapterOptions {
  nexus: Nexus;
  limit: number;
  now?: Date;
  minEngagement?: number;
  minLongText?: number;
  oldAuthorMs?: number;
  youngPostMs?: number;
  mutedAuthors?: ReadonlySet<string>;
  isAuthorMuted?: (author: string) => Promise<boolean>;
  publicReader?: PublicHomeserverReader;
  publisherPk?: string;
  authorCreatedAtMs?: (author: string) => Promise<number | null>;
  entityAuthors?: ReadonlySet<string>;
  fetchLinks?: boolean;
  fetchLinkText?: (url: string) => Promise<{ text: string; title?: string; description?: string } | null>;
}

const POST_URI = new RegExp(`^pubky://([a-z0-9]{52})/pub/pubky\\.app/posts/(${PUBKY_POST_ID_RE.source.slice(1, -1)})$`);
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const DISCOVERY_PAGE_SIZE = 30;
const DISCOVERY_MAX_SKIP = 300;
const DISCOVERY_MAX_HOT_TAGS = 20;
const DISCOVERY_MAX_PAGE_REQUESTS = (2 + 1 + DISCOVERY_MAX_HOT_TAGS + 1) * (DISCOVERY_MAX_SKIP / DISCOVERY_PAGE_SIZE + 1);

export function discoveryRequestCeiling(limit: number): number {
  return limit * 4 + DISCOVERY_MAX_PAGE_REQUESTS + 1;
}

class DiscoveryRequestBudgetExceeded extends Error {
  constructor() {
    super("discovery request budget exhausted");
  }
}

class DiscoveryRequestBudget {
  readonly ceiling: number;
  used = 0;

  constructor(limit: number) {
    this.ceiling = discoveryRequestCeiling(limit);
  }

  consume(): void {
    if (this.used >= this.ceiling) throw new DiscoveryRequestBudgetExceeded();
    this.used += 1;
  }
}

export function postIdentity(post: Pick<PostView, "details">): string {
  const match = POST_URI.exec(post.details.uri);
  if (!match) throw new Error("invalid Pubky post URI");
  return `pubky://${match[1]}/pub/pubky.app/posts/${match[2]}`;
}

function stripPromptControls(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, "");
}

function text(post: PostView): string {
  return stripPromptControls(post.details.content).trim();
}

function engagement(post: PostView): number {
  const counts = post.counts ?? {};
  return (counts.replies ?? 0) + (counts.reposts ?? 0) + (counts.tags ?? 0);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]!.trim().slice(0, 120);
}

function links(value: string): string[] {
  return [...new Set((value.match(URL_RE) ?? []).map((url) => url.replace(/[.,;:!?]+$/, "")))];
}

function addRejection(out: Record<string, number>, reason: string): void {
  out[reason] = (out[reason] ?? 0) + 1;
}

export function normalizePostTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const milliseconds = value > 100_000_000_000_000 ? value / 1_000 : value < 100_000_000_000 ? value * 1_000 : value;
  return Number.isFinite(milliseconds) && milliseconds > 0 && Number.isFinite(new Date(milliseconds).getTime()) ? milliseconds : null;
}

function postPublishedAtMs(post: PostView): number | null {
  return normalizePostTimestamp(post.details.created_at ?? post.details.indexed_at);
}

async function reject(
  post: PostView,
  pool: PostPool,
  opts: PostAdapterOptions,
  nowMs: number,
  budget: DiscoveryRequestBudget,
): Promise<PostRejectionReason | null> {
  if (!POST_URI.test(post.details.uri)) return "unsupported-post-uri";
  if (post.relationships?.replied) return "reply";
  if (post.relationships?.reposted) return "repost";
  const created = postTimestampMs({
    postId: post.details.id,
    indexedAt: post.details.indexed_at,
    createdAt: post.details.created_at,
  });
  const observedAt = postPublishedAtMs(post) ?? (created === null ? null : normalizePostTimestamp(created));
  if (observedAt === null) return "invalid timestamp";
  if (observedAt > nowMs) return "future timestamp";
  const freshnessWindowMs = pool === "incremental" ? 86_400_000 : 90 * 86_400_000;
  if (nowMs - observedAt > freshnessWindowMs) return "stale timestamp";
  if (nowMs - observedAt < (opts.youngPostMs ?? 15 * 60_000)) return "too-young";
  const body = text(post);
  if (post.details.kind !== "long" && post.details.kind !== "link" && !(links(body).length > 0 && body.length >= (opts.minLongText ?? 140))) {
    return "short-without-link";
  }
  if (opts.publicReader && opts.publisherPk) {
    const muteUri = `pubky://${post.details.author}/pub/pubky.app/mutes/${opts.publisherPk}`;
    try {
      const result = await opts.publicReader.getJson(muteUri);
      if (result.status === 200) return "author-muted-publisher";
      if (result.status !== 404) return "mute-check-failed";
    } catch (error) {
      if (error instanceof DiscoveryRequestBudgetExceeded) return "discovery-request-budget";
      return "mute-check-failed";
    }
  } else if (opts.isAuthorMuted ? await opts.isAuthorMuted(post.details.author) : opts.mutedAuthors?.has(post.details.author)) {
    return "author-muted-publisher";
  }
  if (opts.authorCreatedAtMs) {
    let authorCreatedAt: number | null;
    try {
      authorCreatedAt = await opts.authorCreatedAtMs(post.details.author);
    } catch (error) {
      if (error instanceof DiscoveryRequestBudgetExceeded) return "discovery-request-budget";
      authorCreatedAt = null;
    }
    if (authorCreatedAt !== null && nowMs - authorCreatedAt < (opts.oldAuthorMs ?? 7 * 86_400_000)) return "new-author";
  }
  return null;
}

function score(post: PostView, pool: PostPool, percentile: number, opts: PostAdapterOptions): PostScoreComponents {
  const tags = post.tags?.length ?? 0;
  const origin = Math.min(1, engagement(post) / 100);
  return {
    pubky_signal: Math.min(1, percentile * 0.7 + Math.min(1, tags / 5) * 0.3),
    authority: opts.entityAuthors?.has(post.details.author) ? 1 : 0,
    durability: post.details.kind === "long" ? 1 : post.details.kind === "link" ? 0.8 : 0.3,
    origin_engagement: origin,
    freshness: pool === "incremental" ? 1 : 0,
    cost_penalty: 0,
  };
}

function interest(parts: PostScoreComponents): number {
  return 3 * parts.pubky_signal + 2 * parts.authority + 2 * parts.durability + parts.origin_engagement + parts.freshness - parts.cost_penalty;
}

async function enrich(post: PostView, pool: PostPool, percentile: number, opts: PostAdapterOptions, budget: DiscoveryRequestBudget): Promise<PostCandidate | null> {
  const uri = postIdentity(post);
  const body = text(post);
  const linkedUrl = post.details.kind === "link" ? links(body)[0] : undefined;
  let description = body;
  let title = firstLine(body);
  if (linkedUrl && opts.fetchLinks) {
    budget.consume();
    const fetched = await (opts.fetchLinkText ?? (async (url) => {
      const result = await fetchResourceText(url);
      return result.ok ? { text: result.text, title: result.title, description: result.description } : null;
    }))(linkedUrl).catch(() => null);
    if (fetched) description = stripPromptControls(`${body}\n\n${fetched.description ?? fetched.text}`);
    if (fetched?.title) title = stripPromptControls(fetched.title);
  }
  const scoreComponents = score(post, pool, percentile, opts);
  return {
    family: "stable-identifier",
    value: uri,
    source: "pubky-posts",
    labels: [],
    title,
    description,
    authors: [post.details.author],
    identifierType: "pubky-post",
    pool,
    existingTags: [...new Set((post.tags ?? []).map((tag) => tag.label).filter(Boolean))],
    scoreComponents: { ...scoreComponents },
    ...(linkedUrl ? { linkedUrl } : {}),
    sourcePriority: interest(scoreComponents),
    observedAt: new Date(postPublishedAtMs(post) ?? 0).toISOString(),
    publishedAt: new Date(postPublishedAtMs(post) ?? 0).toISOString(),
    freshnessWindowMs: pool === "incremental" ? 24 * 60 * 60 * 1000 : 90 * 24 * 60 * 60 * 1000,
  };
}

async function poolPosts(
  opts: PostAdapterOptions,
  budget: DiscoveryRequestBudget,
): Promise<{ pools: Array<{ pool: PostPool; posts: PostView[] }>; exhausted: boolean }> {
  const now = (opts.now ?? new Date()).getTime();
  const ninetyDays = now - 90 * 86_400_000;
  const yesterday = now - 86_400_000;
  const page = async (pool: PostPool, kind: "long" | "link" | undefined, lowerBound: number, sorting: "timeline" | "total_engagement", tags?: string[]) => {
    const posts: PostView[] = [];
    for (let skip = 0; skip <= DISCOVERY_MAX_SKIP; skip += DISCOVERY_PAGE_SIZE) {
      let batch: PostView[];
      try {
        budget.consume();
        batch = await opts.nexus.streamPosts({
        ...(pool === "incremental" ? { start: now, end: lowerBound } : {}),
        skip,
        limit: 30,
        sorting,
        tags,
        ...(kind ? { kind } : {}),
        });
      } catch (error) {
        if (error instanceof DiscoveryRequestBudgetExceeded) return { pool, posts, exhausted: true };
        throw error;
      }
      posts.push(...batch);
      if (batch.length < 30) break;
    }
    return { pool, posts, exhausted: false };
  };
  const result: Array<{ pool: PostPool; posts: PostView[] }> = [];
  for (const entry of [
    await page("engaged-longform", "long", ninetyDays, "total_engagement"),
    await page("engaged-longform", "link", ninetyDays, "total_engagement"),
    await page("human-tagged", undefined, ninetyDays, "total_engagement"),
  ]) {
    result.push({ pool: entry.pool, posts: entry.posts });
    if (entry.exhausted) return { pools: result, exhausted: true };
  }
  let hot: string[];
  try {
    budget.consume();
    hot = await opts.nexus.hotTags(DISCOVERY_MAX_HOT_TAGS);
  } catch (error) {
    if (error instanceof DiscoveryRequestBudgetExceeded) return { pools: result, exhausted: true };
    throw error;
  }
  for (const tag of hot.slice(0, DISCOVERY_MAX_HOT_TAGS)) {
    const entry = await page("hot-tags", undefined, ninetyDays, "total_engagement", [tag]);
    result.push({ pool: entry.pool, posts: entry.posts });
    if (entry.exhausted) return { pools: result, exhausted: true };
  }
  const incremental = await page("incremental", undefined, yesterday, "timeline");
  result.push({ pool: incremental.pool, posts: incremental.posts });
  return { pools: result, exhausted: incremental.exhausted };
}

export async function discoverPubkyPosts(opts: PostAdapterOptions): Promise<PostShadowRun> {
  const limit = validateResourceLimit(opts.limit);
  const rejectionCounts: Record<string, number> = {};
  const byUri = new Map<string, PostCandidate>();
  const acceptedByPool = new Map<PostPool, number>();
  const poolQuota = Math.max(1, Math.ceil(limit / 4));
  const budget = new DiscoveryRequestBudget(limit);
  const muteCache = new Map<string, Promise<{ status: number; body: unknown }>>();
  const authorCache = new Map<string, Promise<number | null>>();
  const effectiveOpts: PostAdapterOptions = opts.publicReader
    ? {
        ...opts,
        publicReader: {
          getJson: (uri) => {
            const author = uri.split("/")[2] ?? uri;
            const cached = muteCache.get(author);
            if (cached) return cached;
            budget.consume();
            const request = opts.publicReader!.getJson(uri);
            muteCache.set(author, request);
            return request;
          },
        },
      }
    : opts;
  if (effectiveOpts.authorCreatedAtMs) {
    const authorCreatedAtMs = effectiveOpts.authorCreatedAtMs;
    effectiveOpts.authorCreatedAtMs = (author) => {
      const cached = authorCache.get(author);
      if (cached) return cached;
      budget.consume();
      const request = authorCreatedAtMs(author);
      authorCache.set(author, request);
      return request;
    };
  }
  const pooled = await poolPosts(effectiveOpts, budget);
  if (pooled.exhausted) addRejection(rejectionCounts, "discovery-request-budget");
  let budgetStopped = pooled.exhausted;
  poolLoop: for (const { pool, posts } of pooled.pools) {
    if (budgetStopped) break;
    if ((acceptedByPool.get(pool) ?? 0) >= poolQuota) continue;
    const ranked = [...posts].sort((a, b) => engagement(b) - engagement(a));
    for (let index = 0; index < ranked.length && byUri.size < RESOURCE_RECORD_MAX; index += 1) {
      if ((acceptedByPool.get(pool) ?? 0) >= poolQuota) break;
      if (pool === "human-tagged" && (ranked[index]!.tags?.length ?? 0) === 0) {
        addRejection(rejectionCounts, "no-human-tag");
        continue;
      }
      if (pool === "incremental" && engagement(ranked[index]!) < (opts.minEngagement ?? 1)) {
        addRejection(rejectionCounts, "below-engagement-floor");
        continue;
      }
      if (POST_URI.test(ranked[index]!.details.uri)) {
        if (byUri.has(postIdentity(ranked[index]!))) continue;
        const authorCount = [...byUri.values()].filter((item) => item.authors?.[0] === ranked[index]!.details.author).length;
        if (authorCount >= Math.max(1, Math.ceil(limit * 0.2))) {
          addRejection(rejectionCounts, "author-quota");
          continue;
        }
      }
      const reason = await reject(ranked[index]!, pool, effectiveOpts, (opts.now ?? new Date()).getTime(), budget);
      if (reason) {
        addRejection(rejectionCounts, reason);
        if (reason === "discovery-request-budget") {
          budgetStopped = true;
          break poolLoop;
        }
        continue;
      }
      let candidate: PostCandidate | null;
      try {
        candidate = await enrich(ranked[index]!, pool, ranked.length <= 1 ? 1 : 1 - index / (ranked.length - 1), effectiveOpts, budget);
      } catch (error) {
        if (error instanceof DiscoveryRequestBudgetExceeded) {
          addRejection(rejectionCounts, "discovery-request-budget");
          break poolLoop;
        }
        throw error;
      }
      if (!candidate) continue;
      byUri.set(candidate.value, candidate);
      acceptedByPool.set(pool, (acceptedByPool.get(pool) ?? 0) + 1);
      if (byUri.size >= limit) break;
    }
    if (byUri.size >= limit) break;
  }
  // DMs are not on Nexus and therefore cannot enter any pool.
  const run = discoverResources([...byUri.values()], {
    category: "pubky",
    limit,
    configVersion: RESOURCE_CONFIG_VERSION,
    now: opts.now,
  });
  return { ...run, candidates: [...byUri.values()], postRejections: rejectionCounts };
}
