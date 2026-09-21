import { fetchJson } from "./bot-kit/http.js";
import type { ResourceErrorCode } from "./resource-error-code.js";

/**
 * Post-run Nexus indexing check.
 *
 * Separate from homeserver readback: the homeserver answers a GET as soon as
 * the PUT lands, but Nexus indexes asynchronously, so a correct write can be
 * invisible to Nexus for seconds. Read-only: one `by-uri` query per resource,
 * bounded by URI count, attempts, and backoff; only bounded reason codes are
 * recorded. Fixture captured live from staging on 2026-09-21:
 * `src/test-fixtures/nexus/by-uri-pubkyring-2026-09-21.json` (200) and
 * `src/test-fixtures/nexus/by-uri-missing-2026-09-21.json` (404).
 */
export interface NexusVerifyMiss {
  uri: string;
  label: string;
  reason: Extract<ResourceErrorCode, "nexus_label_mismatch" | "nexus_unavailable">;
}

export interface NexusVerifyResult {
  /** Distinct URIs probed. */
  checked: number;
  /** URIs where Nexus showed every expected label with the publisher as tagger. */
  indexed: number;
  /** Total HTTP queries issued. */
  attempts: number;
  /** One row per expected (uri, label) that did not verify. */
  misses: NexusVerifyMiss[];
  /** Bounded reason when one or more URIs were not indexed. */
  failureCode?: ResourceErrorCode;
}

export const NEXUS_VERIFY_MAX_URIS = 100;
export const NEXUS_VERIFY_ATTEMPTS = 3;
export const NEXUS_VERIFY_BACKOFF_MS = 500;
/** Explicit on every read; a Jeb resource carries at most 10 Jeb labels plus orphaned pilot-v1 edges. */
export const NEXUS_VERIFY_LIMIT_TAGS = 50;
export const NEXUS_VERIFY_LIMIT_TAGGERS = 50;

export type NexusFetchJson = (url: URL, timeoutMs: number) => Promise<{ status: number; body: unknown }>;

type NexusTag = { label: string; taggers: string[] };

/** Shape of `GET /v0/resource/by-uri` (nexus-webapi 0.4.1, staging `9e20cbff`): `{ resource, tags: [{ label, taggers, taggers_count, relationship }] }`. */
function tagsOf(body: unknown): NexusTag[] {
  const value = body && typeof body === "object" ? (body as { tags?: unknown }).tags : body;
  const rows = Array.isArray(value) ? value : [];
  return rows.flatMap((row): NexusTag[] => {
    if (typeof row === "string") return [{ label: row, taggers: [] }];
    if (!row || typeof row !== "object") return [];
    const label = (row as { label?: unknown }).label;
    if (typeof label !== "string" || !label) return [];
    const taggers = (row as { taggers?: unknown }).taggers;
    return [{ label, taggers: Array.isArray(taggers) ? taggers.filter((tagger): tagger is string => typeof tagger === "string") : [] }];
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nexusByUriUrl(nexusUrl: string, uri: string): URL {
  const url = new URL("/v0/resource/by-uri", nexusUrl);
  url.searchParams.set("uri", uri);
  url.searchParams.set("limit_tags", String(NEXUS_VERIFY_LIMIT_TAGS));
  url.searchParams.set("limit_taggers", String(NEXUS_VERIFY_LIMIT_TAGGERS));
  return url;
}

export async function verifyNexusIndexed(opts: {
  nexusUrl: string;
  timeoutMs: number;
  /** The tags the executed plan carries: uri, label, and the immutable publisher. */
  written: ReadonlyArray<{ uri: string; label: string; publisherPk: string }>;
  attempts?: number;
  backoffMs?: number;
  maxUris?: number;
  fetchJson?: NexusFetchJson;
}): Promise<NexusVerifyResult> {
  const fetcher = opts.fetchJson ?? fetchJson;
  const maxAttempts = opts.attempts ?? NEXUS_VERIFY_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? NEXUS_VERIFY_BACKOFF_MS;
  const byUri = new Map<string, Map<string, string>>();
  for (const tag of opts.written) {
    let labels = byUri.get(tag.uri);
    if (!labels) byUri.set(tag.uri, (labels = new Map()));
    labels.set(tag.label, tag.publisherPk);
  }
  const uris = [...byUri.keys()];
  const maxUris = opts.maxUris ?? NEXUS_VERIFY_MAX_URIS;
  if (uris.length > maxUris) {
    throw new Error(`nexus verify refused: ${uris.length} URIs exceeds the cap of ${maxUris}`);
  }
  const result: NexusVerifyResult = { checked: uris.length, indexed: 0, attempts: 0, misses: [] };
  for (const uri of uris) {
    const expected = byUri.get(uri)!;
    let seen = false;
    let unavailable = false;
    let tags: NexusTag[] = [];
    for (let attempt = 0; attempt < maxAttempts && !seen; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs);
      result.attempts += 1;
      try {
        const { status, body } = await fetcher(nexusByUriUrl(opts.nexusUrl, uri), opts.timeoutMs);
        if (status === 404) {
          // `{"error":"Resource not found: <id>"}`: the resource is not indexed at all.
          unavailable = false;
          tags = [];
          continue;
        }
        if (status !== 200) {
          unavailable = true;
          continue;
        }
        unavailable = false;
        tags = tagsOf(body);
        seen = [...expected.entries()].every(([label, publisherPk]) =>
          tags.some((tag) => tag.label === label && tag.taggers.includes(publisherPk)),
        );
      } catch {
        unavailable = true;
      }
    }
    if (seen) {
      result.indexed += 1;
      continue;
    }
    for (const [label, publisherPk] of expected) {
      const present = tags.some((tag) => tag.label === label && tag.taggers.includes(publisherPk));
      if (present) continue;
      const reason = unavailable ? "nexus_unavailable" : "nexus_label_mismatch";
      result.misses.push({ uri, label, reason });
      result.failureCode ??= reason;
    }
  }
  return result;
}
