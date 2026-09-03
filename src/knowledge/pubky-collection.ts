import { z } from "zod";
import { fetchJson } from "../http.js";
import { log } from "../log.js";
import { postViewSchema } from "../nexus-schema.js";
import { parsePostUri } from "../types.js";
import type { SourceEntry } from "./types.js";

export const HTTP_COLLECTION_TIMEOUT_MS = 30_000;
export const HTTP_COLLECTION_MAX_BYTES = 2 * 1024 * 1024;

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

export function defaultNexusUrl(entry: SourceEntry): string {
  const raw = entry.nexus?.trim() || process.env.JEB_NEXUS_URL?.trim() || "https://nexus.pubky.app";
  return new URL(raw).origin;
}

export function appCiteUrl(author: string, postId: string): string {
  const base = (process.env.JEB_APP_URL?.trim() || "https://pubky.app").replace(/\/$/, "");
  return `${base}/post/${author}/${postId}`;
}

function assertHost(url: URL, allowedHost: string): void {
  if (url.host !== allowedHost) throw new Error("ssrf: host not allowed");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("ssrf: bad protocol");
}

async function fetchPostView(nexusOrigin: string, uri: string, timeoutMs: number) {
  const { author, postId } = parsePostUri(uri);
  const allowedHost = new URL(nexusOrigin).host;
  const url = new URL(`/v0/post/${author}/${postId}`, nexusOrigin.endsWith("/") ? nexusOrigin : `${nexusOrigin}/`);
  assertHost(url, allowedHost);
  const { status, body } = await fetchJson(url, timeoutMs);
  if (status !== 200) throw new Error(`nexus post HTTP ${status} ${uri}`);
  const parsed = postViewSchema.safeParse(body);
  if (!parsed.success) throw new Error(`nexus post shape invalid for ${uri}`);
  return parsed.data;
}

export async function loadCollectionDocuments(
  entry: SourceEntry,
  opts?: { timeoutMs?: number },
): Promise<CollectionItemDoc[]> {
  const timeoutMs = opts?.timeoutMs ?? HTTP_COLLECTION_TIMEOUT_MS;
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
  const docs: CollectionItemDoc[] = [];
  for (const itemUri of items) {
    let parsedUri;
    try {
      parsedUri = parsePostUri(itemUri);
    } catch {
      log.warn({ source: entry.id, uri: itemUri }, "skipping invalid collection item URI");
      continue;
    }
    const view = await fetchPostView(nexus, itemUri, timeoutMs);
    if (view.details.kind !== "long") {
      log.warn(
        { source: entry.id, uri: itemUri, kind: view.details.kind },
        "skipping non-long collection item",
      );
      continue;
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
    if (body.length > HTTP_COLLECTION_MAX_BYTES) {
      throw new Error(`collection item too large (> ${HTTP_COLLECTION_MAX_BYTES} bytes)`);
    }
    const { author, postId } = parsedUri;
    docs.push({
      path: `${author}/${postId}`,
      title,
      text: `# ${title}\n\n${body}`,
      sourceUrl: appCiteUrl(author, postId),
      author,
      version: String(view.details.indexed_at),
    });
  }
  return docs;
}
