import { fetchJson } from "./bot-kit/http.js";
import type { ResourceErrorCode } from "./resource-error-code.js";

/**
 * Post-run Nexus indexing check.
 *
 * This is deliberately separate from homeserver readback verification: the
 * homeserver answers a GET as soon as the PUT lands, but Nexus indexes
 * asynchronously, so a correct write can be invisible to Nexus for seconds.
 * The executor treats a missing or publisher-mismatched Nexus result as a
 * terminal failure. The check is bounded by the compiled resource count,
 * attempts, and backoff, and records only bounded result codes.
 */
export interface NexusVerifyResult {
  /** Distinct successfully processed written URIs probed. */
  checked: number;
  /** URIs where Nexus showed the written label within the attempt bound. */
  indexed: number;
  /** Total HTTP queries issued. */
  attempts: number;
  /** Bounded reason when one or more written URIs were not indexed. */
  failureCode?: ResourceErrorCode;
}

export const NEXUS_VERIFY_MAX_URIS = 100;
export const NEXUS_VERIFY_ATTEMPTS = 3;
export const NEXUS_VERIFY_BACKOFF_MS = 500;

export type NexusFetchJson = (url: URL, timeoutMs: number) => Promise<{ status: number; body: unknown }>;

type NexusTag = { label: string; taggers: string[] };

function tagsOf(body: unknown): NexusTag[] {
  const value = body && typeof body === "object" ? (body as { tags?: unknown }).tags : body;
  const rows = Array.isArray(value) ? value : [];
  return rows
    .flatMap((row): NexusTag[] => {
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

export async function verifyNexusIndexed(opts: {
  nexusUrl: string;
  timeoutMs: number;
  /** The tags the run successfully processed: uri, label, and immutable publisher. */
  written: Array<{ uri: string; label: string; publisherPk: string }>;
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
    return { checked: uris.length, indexed: 0, attempts: 0, failureCode: "nexus_unavailable" };
  }
  const result: NexusVerifyResult = { checked: uris.length, indexed: 0, attempts: 0 };
  for (const uri of uris) {
    const expected = byUri.get(uri)!;
    let seen = false;
    let failureCode: ResourceErrorCode | undefined;
    for (let attempt = 0; attempt < maxAttempts && !seen; attempt += 1) {
      if (attempt > 0) await sleep(backoffMs);
      try {
        const url = new URL("/v0/resource/by-uri", opts.nexusUrl);
        url.searchParams.set("uri", uri);
        url.searchParams.set("limit_tags", "20");
        url.searchParams.set("limit_taggers", "50");
        result.attempts += 1;
        const { status, body } = await fetcher(url, opts.timeoutMs);
        if (status !== 200) {
          failureCode = "nexus_unavailable";
          continue;
        }
        const tags = tagsOf(body);
        seen = [...expected.entries()].every(([label, publisherPk]) =>
          tags.some((tag) => tag.label === label && tag.taggers.includes(publisherPk)),
        );
        if (!seen) failureCode = "nexus_label_mismatch";
      } catch {
        failureCode = "nexus_unavailable";
      }
    }
    if (seen) {
      result.indexed += 1;
    } else {
      result.failureCode ??= failureCode ?? "nexus_unavailable";
    }
  }
  return result;
}
