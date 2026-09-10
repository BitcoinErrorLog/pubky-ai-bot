import { extractResourceText, fetchResourceText, FetchRequestBudgetExceeded, type FetchResourceResult } from "./resource-fetch.js";
import type { ExternalResourceInput, ResourceRun } from "./external-resources.js";
import { discoverResources } from "./external-resources.js";
import { isAllowedResourceLabel } from "./resource-label-policy.js";
import { NEWS_FEED_HOSTS, assertAllowedResourceReadUrl } from "./outbound-gate.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { filterOpenTags } from "./bot-kit/tags/policy.js";
import { normalizePersonToken } from "./bot-kit/tags/denylist.js";

export const NEWS_SOURCE_ID = "news";
export const NEWS_REQUEST_BUDGET = 100;
export const NEWS_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const NEWS_RECENCY_MS = 30 * 24 * 60 * 60 * 1000;
export const NEWS_MAX_SELECTION = 100;

export type NewsFeedId = "nobsbitcoin" | "the-rage" | "bitcoin-magazine" | "the-block" | "stacker-news" | "bitcoin-optech";

export type NewsFeed = {
  id: NewsFeedId;
  url: string;
  host: typeof NEWS_FEED_HOSTS[number];
  publicationHosts: readonly string[];
  format: "rss" | "atom";
  license?: "MIT";
};

export const NEWS_FEEDS: readonly NewsFeed[] = [
  { id: "nobsbitcoin", url: "https://nobsbitcoin.com/rss/", host: "nobsbitcoin.com", publicationHosts: ["nobsbitcoin.com", "www.nobsbitcoin.com"], format: "rss" },
  { id: "the-rage", url: "https://www.therage.co/rss/", host: "www.therage.co", publicationHosts: ["www.therage.co"], format: "rss" },
  { id: "bitcoin-magazine", url: "https://bitcoinmagazine.com/feed", host: "bitcoinmagazine.com", publicationHosts: ["bitcoinmagazine.com"], format: "rss" },
  { id: "the-block", url: "https://www.theblock.co/feed/", host: "www.theblock.co", publicationHosts: ["www.theblock.co"], format: "rss" },
  { id: "stacker-news", url: "https://stacker.news/rss", host: "stacker.news", publicationHosts: ["stacker.news"], format: "rss" },
  { id: "bitcoin-optech", url: "https://bitcoinops.org/feed.xml", host: "bitcoinops.org", publicationHosts: ["bitcoinops.org"], format: "atom", license: "MIT" },
] as const;

type ParsedItem = {
  title?: string;
  link?: string;
  description?: string;
  categories: string[];
  author?: string;
  authors?: string[];
  pubDate?: string;
};

export type NewsRejection = { feed: NewsFeedId; reason: string; title?: string };
export type NewsParseResult = { items: ParsedItem[]; rejected: NewsRejection[] };
class NewsFeedParseError extends Error {
  constructor(readonly rejected: NewsRejection[]) {
    super("feed contains no valid items");
  }
}

function authorPersonTokens(authors: readonly string[]): string[] {
  return [...new Set(authors.flatMap((author) => {
    const normalized = normalizePersonToken(author);
    const parts = normalized.split("-");
    return [
      author,
      normalized,
      ...parts.slice(1).map((_, index) => parts.slice(index + 1).join("-")).filter((token) => token.length >= 8),
    ];
  }))];
}

function localName(name: string): string {
  return name.toLowerCase().replace(/^.*:/, "");
}

function cleanField(value: string, max: number): string | undefined {
  const unwrapped = value.replace(/^\s*<!\[CDATA\[/i, "").replace(/\]\]>\s*$/i, "");
  const text = extractResourceText(unwrapped).text.trim().slice(0, max);
  return text || undefined;
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, "is").exec(tag);
  return match?.[2];
}

function parseItem(raw: string, feed: NewsFeedId, atom: boolean): { item?: ParsedItem; rejection?: NewsRejection } {
  const fields = new Map<string, string[]>();
  const fieldPattern = /<(?:(?:[A-Za-z0-9_-]+):)?(title|link|description|summary|category|creator|author|published|updated|pubdate)\b(?:\s[^>]*)?>([\s\S]*?)<\/(?:(?:[A-Za-z0-9_-]+):)?\1\s*>/gi;
  for (const match of raw.matchAll(fieldPattern)) {
    const name = localName(match[1]!);
    const value = name === "link" ? (attr(match[0]!, "href") ?? match[2]!) : match[2]!;
    fields.set(name, [...(fields.get(name) ?? []), value]);
  }
  if (!fields.has("link") && atom) {
    const atomLink = [...raw.matchAll(/<link\b[^>]*>/gi)]
      .map((match) => match[0]!)
      .map((tag) => ({
        tag,
        rel: attr(tag, "rel")?.trim().toLowerCase(),
        type: attr(tag, "type")?.trim().toLowerCase(),
        href: attr(tag, "href"),
      }))
      .find((link) => (!link.rel || link.rel === "alternate") && (!link.type || link.type === "text/html") && link.href);
    if (atomLink?.href) fields.set("link", [atomLink.href]);
  }
  const title = cleanField(fields.get("title")?.[0] ?? "", 512);
  const link = cleanField(fields.get("link")?.[0] ?? "", 2_048);
  const pubDate = cleanField(fields.get("pubdate")?.[0] ?? fields.get("published")?.[0] ?? fields.get("updated")?.[0] ?? "", 128);
  if (!link) return { rejection: { feed, reason: "missing-link", ...(title ? { title } : {}) } };
  if (!title) return { rejection: { feed, reason: "missing-title" } };
  if (!pubDate || !Number.isFinite(Date.parse(pubDate))) return { rejection: { feed, reason: "invalid-pubDate", title } };
  const description = cleanField(fields.get("description")?.[0] ?? fields.get("summary")?.[0] ?? "", 1_000);
  const categories = [...new Set((fields.get("category") ?? []).map((value) => cleanField(value, 64)).filter((value): value is string => Boolean(value)))];
  const authors = [...(fields.get("creator") ?? []), ...(fields.get("author") ?? [])]
    .map((value) => cleanField(value, 256))
    .filter((value): value is string => Boolean(value))
    .slice(0, 8);
  return {
    item: {
      title,
      link,
      ...(description ? { description } : {}),
      categories,
      ...(authors[0] ? { author: authors[0] } : {}),
      ...(authors.length > 0 ? { authors } : {}),
      pubDate,
    },
  };
}

export function parseNewsFeed(xml: string, feed: NewsFeed): NewsParseResult {
  if (xml.length > NEWS_MAX_BODY_BYTES) throw new Error("feed exceeds parser byte cap");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error("forbidden XML declaration");
  if (/<!\[CDATA\[/i.test(xml) && !/<!\[CDATA\[[\s\S]*?\]\]>/i.test(xml)) throw new Error("unterminated CDATA");
  const rejected: NewsRejection[] = [];
  const items: ParsedItem[] = [];
  let elementCount = 0;
  let depth = 0;
  let cursor = 0;
  let root = "";
  const tokenPattern = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>/g;
  for (const match of xml.matchAll(tokenPattern)) {
    elementCount += 1;
    if (elementCount > 20_000) throw new Error("feed element limit exceeded");
    const token = match[0]!;
    if (token.startsWith("<!--") || token.startsWith("<![CDATA[")) continue;
    if (/^<\//.test(token)) {
      depth -= 1;
      if (depth < 0) throw new Error("malformed XML depth");
    } else if (!/^<\?/.test(token) && !/^<!/.test(token) && !/\/\s*>$/.test(token)) {
      depth += 1;
      if (depth > 64) throw new Error("feed depth limit exceeded");
      const name = token.match(/^<\s*([A-Za-z][\w:.-]*)/)?.[1];
      if (!root && name) root = localName(name);
    }
  }
  if (!root || (root !== "rss" && root !== "feed")) throw new Error("unexpected feed root");
  const documentFormat = root === "feed" ? "atom" : "rss";
  if (documentFormat !== feed.format) {
    return { items: [], rejected: [{ feed: feed.id, reason: "feed-format-mismatch" }] };
  }
  const itemTag = documentFormat === "atom" ? "entry" : "item";
  const itemPattern = new RegExp(`<${itemTag}\\b[^>]*>([\\s\\S]*?)</${itemTag}\\s*>`, "gi");
  if (depth !== 0) throw new Error("unterminated XML element");
  let count = 0;
  for (const match of xml.matchAll(itemPattern)) {
    count += 1;
    if (count > 5_000) throw new Error("feed item limit exceeded");
    const parsed = parseItem(match[1]!, feed.id, documentFormat === "atom");
    if (parsed.item) items.push(parsed.item);
    else if (parsed.rejection) rejected.push(parsed.rejection);
  }
  if (count === 0) throw new Error("feed contains no items");
  return { items, rejected };
}

function canonicalItemUrl(raw: string, feed: NewsFeed): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !feed.publicationHosts.includes(url.hostname.toLowerCase())) throw new Error("item URL is outside publication host");
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|ref$|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function label(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20);
  return normalized && isAllowedResourceLabel(normalized) ? normalized : undefined;
}

function inputFromItem(item: ParsedItem, feed: NewsFeed, now: Date, rejected: NewsRejection[]): ExternalResourceInput | undefined {
  if (!item.pubDate || now.getTime() - Date.parse(item.pubDate) > NEWS_RECENCY_MS || Date.parse(item.pubDate) > now.getTime()) {
    rejected.push({ feed: feed.id, reason: "outside-30-day-window", ...(item.title ? { title: item.title } : {}) });
    return undefined;
  }
  let value: string;
  try {
    value = canonicalItemUrl(item.link!, feed);
  } catch (error) {
    rejected.push({ feed: feed.id, reason: error instanceof Error ? error.message : "unsafe-item-url", title: item.title });
    return undefined;
  }
  const labels = filterOpenTags([...new Set([
    "news",
    label(feed.id),
    ...(feed.license ? ["newsletter"] : []),
    ...item.categories.map(label).filter((value): value is string => Boolean(value)),
  ].filter((value): value is string => Boolean(value)))], {
    personTokens: authorPersonTokens(item.authors ?? []),
    max: 10,
  });
  return {
    family: "url",
    value,
    source: NEWS_SOURCE_ID,
    labels,
    title: item.title,
    description: item.description,
    authors: item.authors,
    publishedAt: new Date(Date.parse(item.pubDate)).toISOString(),
    observedAt: new Date(Date.parse(item.pubDate)).toISOString(),
    tagHints: labels,
    taxonomy: { domain: ["news"], type: ["article"], subject: ["news"] },
    metadata: {
      feed: feed.id,
      categories: item.categories,
      publishedAt: new Date(Date.parse(item.pubDate)).toISOString(),
      ...(feed.license ? { license: feed.license } : {}),
    },
    scoreComponents: { pubky_signal: 0, authority: 4, durability: 2, origin_engagement: 0, freshness: 10, cost_penalty: 0 },
  };
}

export type NewsDiscoverOptions = {
  limit: number;
  now?: Date;
  feeds?: readonly NewsFeed[];
  requestBudget?: number;
  fixtures?: Partial<Record<NewsFeedId, string>>;
  fetchImpl?: typeof fetch;
  cacheDir?: string;
  configVersion?: string;
};

export async function discoverNews(options: NewsDiscoverOptions): Promise<ResourceRun> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > NEWS_MAX_SELECTION) {
    throw new Error("news limit must be an integer from 1 to 100");
  }
  const now = options.now ?? new Date();
  const rejected: NewsRejection[] = [];
  const byFeed: ExternalResourceInput[][] = [];
  const feeds = options.feeds ?? NEWS_FEEDS;
  let requests = 0;
  let halt: { reason: string } | undefined;
  const unavailableFeeds: Array<{ id: string; reason: string }> = [];
  const request = (url: string): void => {
    requests += 1;
    if (requests > (options.requestBudget ?? NEWS_REQUEST_BUDGET)) throw new FetchRequestBudgetExceeded(url);
  };
  for (const feed of feeds) {
    let xml: string;
    try {
      assertAllowedResourceReadUrl(feed.url);
      const supplied = options.fixtures?.[feed.id];
      const result: FetchResourceResult = supplied !== undefined
        ? { ok: true, text: supplied, finalUrl: feed.url, bytes: Buffer.byteLength(supplied), truncated: false, fromCache: false }
        : await fetchResourceText(feed.url, {
          rawBody: true,
          rawBodyMaxChars: NEWS_MAX_BODY_BYTES,
          cacheDir: options.cacheDir,
          maxBodyBytes: NEWS_MAX_BODY_BYTES,
          allowedHosts: NEWS_FEED_HOSTS,
          allowedContentTypes: ["application/rss+xml", "application/atom+xml", "application/xml", "text/xml", "text/rss", "text/atom"],
          onRequest: request,
          fetchImpl: options.fetchImpl,
        });
      if (!result.ok) {
        const reason = result.status === 429 ? "http_429" : result.reason === "too_large" ? "truncated" : result.reason;
        throw new Error(reason);
      }
      if (result.truncated) throw new Error("truncated");
      xml = result.text;
      const parsed = parseNewsFeed(xml, feed);
      if (parsed.items.length === 0) throw new NewsFeedParseError(parsed.rejected);
      const feedRejected = [...parsed.rejected];
      const values = parsed.items.flatMap((item) => {
        const value = inputFromItem(item, feed, now, feedRejected);
        return value ? [value] : [];
      });
      rejected.push(...feedRejected);
      byFeed.push(values.sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!)));
    } catch (error) {
      if (error instanceof NewsFeedParseError) rejected.push(...error.rejected);
      const reason = error instanceof FetchRequestBudgetExceeded || (error instanceof Error && error.name === "FetchRequestBudgetExceeded")
        ? "request-budget-exhausted"
        : error instanceof Error && error.message === "truncated" ? `${feed.id}-truncated` : "source-unavailable";
      const detail = error instanceof Error && ["robots_unavailable", "http_429", "truncated"].includes(error.message)
        ? error.message
        : reason === "request-budget-exhausted" ? reason : "source-unavailable";
      unavailableFeeds.push({ id: feed.id, reason: detail });
      halt ??= { reason };
      if (reason === "request-budget-exhausted") break;
      byFeed.push([]);
    }
  }
  const selected: ExternalResourceInput[] = [];
  const cursors = feeds.map(() => 0);
  while (selected.length < NEWS_MAX_SELECTION) {
    let added = false;
    for (let index = 0; index < byFeed.length && selected.length < NEWS_MAX_SELECTION; index += 1) {
      const value = byFeed[index]?.[cursors[index] ?? 0];
      if (!value) continue;
      selected.push(value);
      cursors[index] = (cursors[index] ?? 0) + 1;
      added = true;
    }
    if (!added) break;
  }
  const ordered = selected.map((item, index) => ({ ...item, sourcePriority: NEWS_MAX_SELECTION - index }));
  const run = discoverResources(ordered, {
    category: "news",
    limit: options.limit,
    configVersion: options.configVersion ?? RESOURCE_CONFIG_VERSION,
    now,
  });
  run.rejected.push(...rejected.map((item) => ({
    input: { family: "url" as const, value: item.title ?? "", source: NEWS_SOURCE_ID, labels: [] },
    reason: `${item.feed}:${item.reason}`,
    provenance: { source: NEWS_SOURCE_ID, configVersion: options.configVersion ?? RESOURCE_CONFIG_VERSION, decision: "rejected" as const, timestamp: now.toISOString() },
  })));
  run.shadowReport.requests = requests;
  run.shadowReport.rejectionHistogram = rejected.reduce<Record<string, number>>((out, item) => {
    const key = `${item.feed}:${item.reason}`;
    out[key] = (out[key] ?? 0) + 1;
    return out;
  }, {});
  run.shadowReport.poolSize = selected.length + rejected.length;
  run.shadowReport.unavailableFeeds = unavailableFeeds;
  if (halt) run.shadowReport.halt = halt;
  return run;
}
