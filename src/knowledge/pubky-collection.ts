import { z } from "zod";
import { fetchJson } from "../http.js";
import { log } from "../log.js";
import { postViewSchema } from "../nexus-schema.js";
import { parsePostUri } from "../types.js";
import type { SourceEntry } from "./types.js";

export const HTTP_COLLECTION_TIMEOUT_MS = 30_000;
export const HTTP_COLLECTION_MAX_BYTES = 2 * 1024 * 1024;
export const COLLECTION_CONCURRENCY = 3;
export const COLLECTION_SOURCE_DEADLINE_MS = 5 * 60_000;
export const COLLECTION_MAX_ITEMS_DEFAULT = 200;

const collectionContentSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  items: z.array(z.string()),
});

const longBodySchema = z.object({
  title: z.string(),
  body: z.string(),
});

export interface CollectionItemDoc {
  path: string;
  title: string;
  text: string;
  sourceUrl: string;
  author: string;
  version: string;
}

export function collectionMaxItems(): number {
  const raw = process.env.JEB_COLLECTION_MAX_ITEMS?.trim();
  if (!raw) return COLLECTION_MAX_ITEMS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return COLLECTION_MAX_ITEMS_DEFAULT;
  return Math.floor(n);
}

export function defaultNexusUrl(entry: SourceEntry): string {
  const raw = entry.nexus?.trim() || process.env.JEB_NEXUS_URL?.trim() || "https://nexus.pubky.app";
  return new URL(raw).origin;
}

export function appCiteUrl(author: string, postId: string): string {
  const base = (process.env.JEB_APP_URL?.trim() || "https://pubky.app").replace(/\/$/, "");
  return `${base}/post/${author}/${postId}`;
}

/** Pin the request URL against the configured Nexus host, not a host derived from `url`. */
export function assertPinnedHost(url: URL, configuredHost: string): void {
  if (url.host !== configuredHost) throw new Error("ssrf: host not allowed");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("ssrf: bad protocol");
}

async function fetchPostView(nexusOrigin: string, uri: string, timeoutMs: number) {
  const { author, postId } = parsePostUri(uri);
  const configuredHost = new URL(nexusOrigin).host;
  const url = new URL(`/v0/post/${author}/${postId}`, nexusOrigin.endsWith("/") ? nexusOrigin : `${nexusOrigin}/`);
  assertPinnedHost(url, configuredHost);
  const { status, body } = await fetchJson(url, timeoutMs);
  if (status !== 200) throw new Error(`nexus post HTTP ${status} ${uri}`);
  const parsed = postViewSchema.safeParse(body);
  if (!parsed.success) throw new Error(`nexus post shape invalid for ${uri}`);
  return parsed.data;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R | undefined>,
): Promise<Array<R | undefined>> {
  const out: Array<R | undefined> = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function loadCollectionDocuments(
  entry: SourceEntry,
  opts?: { timeoutMs?: number; maxItems?: number; deadlineMs?: number; concurrency?: number },
): Promise<CollectionItemDoc[]> {
  const timeoutMs = opts?.timeoutMs ?? HTTP_COLLECTION_TIMEOUT_MS;
  const maxItems = opts?.maxItems ?? collectionMaxItems();
  const deadline = Date.now() + (opts?.deadlineMs ?? COLLECTION_SOURCE_DEADLINE_MS);
  const concurrency = opts?.concurrency ?? COLLECTION_CONCURRENCY;
  const nexus = defaultNexusUrl(entry);
  const collection = await fetchPostView(nexus, entry.location, timeoutMs);
  if (collection.details.kind !== "collection") {
    throw new Error(`expected collection kind, got ${collection.details.kind}`);
  }
  let items: string[] = [];
  try {
    const parsed = collectionContentSchema.parse(JSON.parse(collection.details.content) as unknown);
    items = parsed.items;
  } catch {
    throw new Error("collection content is not { items: string[] }");
  }
  if (items.length > maxItems) {
    log.warn(
      { source: entry.id, total: items.length, cap: maxItems },
      "collection item list truncated",
    );
    items = items.slice(0, maxItems);
  }
  const slots = await mapLimit(items, concurrency, async (itemUri) => {
    if (Date.now() > deadline) {
      log.warn({ source: entry.id, uri: itemUri }, "skipping collection item: source deadline");
      return undefined;
    }
    let parsedUri;
    try {
      parsedUri = parsePostUri(itemUri);
    } catch {
      log.warn({ source: entry.id, uri: itemUri, reason: "invalid URI" }, "skipping collection item");
      return undefined;
    }
    let view;
    try {
      view = await fetchPostView(nexus, itemUri, timeoutMs);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log.warn({ source: entry.id, uri: itemUri, reason }, "skipping collection item");
      return undefined;
    }
    if (view.details.kind !== "long") {
      log.warn(
        { source: entry.id, uri: itemUri, kind: view.details.kind, reason: "not long" },
        "skipping collection item",
      );
      return undefined;
    }
    let title = view.details.id;
    let body = view.details.content;
    try {
      const parsed = longBodySchema.parse(JSON.parse(view.details.content) as unknown);
      title = parsed.title;
      body = parsed.body;
    } catch {
      /* raw content fallback */
    }
    const bytes = Buffer.byteLength(body, "utf8");
    if (bytes > HTTP_COLLECTION_MAX_BYTES) {
      log.warn(
        { source: entry.id, uri: itemUri, bytes, cap: HTTP_COLLECTION_MAX_BYTES, reason: "over size cap" },
        "skipping collection item",
      );
      return undefined;
    }
    const { author, postId } = parsedUri;
    return {
      path: `${author}/${postId}`,
      title,
      text: `# ${title}\n\n${body}`,
      sourceUrl: appCiteUrl(author, postId),
      author,
      version: String(view.details.indexed_at),
    } satisfies CollectionItemDoc;
  });
  return slots.filter((d): d is CollectionItemDoc => d !== undefined);
}
