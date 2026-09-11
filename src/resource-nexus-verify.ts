import { fetchJson } from "./bot-kit/http.js";
import { resourceErrorCode, type ResourceErrorCode } from "./resource-error-code.js";

/**
 * Post-run Nexus indexing check.
 *
 * This is deliberately separate from homeserver readback verification: the
 * homeserver answers a GET as soon as the PUT lands, but Nexus indexes
 * asynchronously, so a correct write can be invisible to Nexus for seconds.
 * Failing the run on that lag would produce false failures; claiming Nexus
 * state without looking would produce false confidence. Instead the check is
 * bounded (a cap on URIs, attempts, and backoff), non-blocking (its result
 * never changes the run's verified flag or exit code), and recorded as
 * `nexusVerified` counts in the manifest for the operator to watch.
 */
export interface NexusVerifyResult {
  /** Distinct written URIs probed (capped). */
  checked: number;
  /** URIs where Nexus showed the written label within the attempt bound. */
  indexed: number;
  /** Total HTTP queries issued. */
  attempts: number;
  /** Bounded reason when one or more written URIs were not indexed. */
  failureCode?: ResourceErrorCode;
}

export const NEXUS_VERIFY_MAX_URIS = 20;
export const NEXUS_VERIFY_ATTEMPTS = 3;
export const NEXUS_VERIFY_BACKOFF_MS = 500;

export type NexusFetchJson = (url: URL, timeoutMs: number) => Promise<{ status: number; body: unknown }>;

function labelsOf(body: unknown): string[] {
  const value = body && typeof body === "object" ? (body as { tags?: unknown }).tags : body;
  const rows = Array.isArray(value) ? value : [];
  return rows
    .map((row) =>
      typeof row === "string"
        ? row
        : row && typeof row === "object" && typeof (row as { label?: unknown }).label === "string"
          ? (row as { label: string }).label
          : "",
    )
    .filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function verifyNexusIndexed(opts: {
  nexusUrl: string;
  timeoutMs: number;
  /** The tags the run actually wrote: uri plus label. */
  written: Array<{ uri: string; label: string }>;
  attempts?: number;
  backoffMs?: number;
  maxUris?: number;
  fetchJson?: NexusFetchJson;
}): Promise<NexusVerifyResult> {
  const fetcher = opts.fetchJson ?? fetchJson;
  const maxAttempts = opts.attempts ?? NEXUS_VERIFY_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? NEXUS_VERIFY_BACKOFF_MS;
  const byUri = new Map<string, Set<string>>();
  for (const tag of opts.written) {
    let labels = byUri.get(tag.uri);
    if (!labels) byUri.set(tag.uri, (labels = new Set()));
    labels.add(tag.label);
  }
  const uris = [...byUri.keys()].slice(0, opts.maxUris ?? NEXUS_VERIFY_MAX_URIS);
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
        result.attempts += 1;
        const { status, body } = await fetcher(url, opts.timeoutMs);
        if (status !== 200) {
          failureCode = "nexus_unavailable";
          continue;
        }
        const labels = new Set(labelsOf(body));
        seen = [...expected].every((label) => labels.has(label));
      } catch (error) {
        failureCode = resourceErrorCode(error, "nexus_unavailable");
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
