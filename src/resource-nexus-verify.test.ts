import { describe, expect, it } from "vitest";
import {
  NEXUS_VERIFY_ATTEMPTS,
  NEXUS_VERIFY_MAX_URIS,
  verifyNexusIndexed,
  type NexusFetchJson,
} from "./resource-nexus-verify.js";

const WRITTEN = [{ uri: "https://example.test/docs", label: "release" }];

function fetcher(sequence: Array<{ status: number; body: unknown }>, seen: string[] = []): NexusFetchJson {
  let calls = 0;
  return async (url) => {
    calls += 1;
    seen.push(url.toString());
    return sequence[Math.min(calls - 1, sequence.length - 1)]!;
  };
}

describe("bounded Nexus indexing check", () => {
  it("counts a URI as indexed once every written label appears", async () => {
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: WRITTEN,
      backoffMs: 1,
      fetchJson: fetcher([{ status: 200, body: { tags: [{ label: "release" }] } }]),
    });
    expect(result).toEqual({ checked: 1, indexed: 1, attempts: 1 });
  });

  // Nexus indexes asynchronously: a correct write is invisible at first, so
  // the check retries with backoff instead of failing on the first 404.
  it("retries with backoff until the write is indexed", async () => {
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: WRITTEN,
      backoffMs: 1,
      fetchJson: fetcher([
        { status: 404, body: null },
        { status: 200, body: { tags: [{ label: "release" }] } },
      ]),
    });
    expect(result).toEqual({ checked: 1, indexed: 1, attempts: 2 });
  });

  // The check is bounded: a URI that never indexes costs exactly N queries
  // and is recorded as not indexed — it never fails the run.
  it("stops after the attempt bound and reports not indexed", async () => {
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: WRITTEN,
      backoffMs: 1,
      fetchJson: fetcher([{ status: 404, body: null }]),
    });
    expect(result).toEqual({ checked: 1, indexed: 0, attempts: NEXUS_VERIFY_ATTEMPTS, failureCode: "nexus_unavailable" });
  });

  it("treats query errors as not-yet-indexed, never as a failure", async () => {
    const throwing: NexusFetchJson = async () => {
      throw new Error("connection refused");
    };
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: WRITTEN,
      backoffMs: 1,
      fetchJson: throwing,
    });
    expect(result.indexed).toBe(0);
    expect(result.failureCode).toBe("nexus_unavailable");
    expect(result.attempts).toBe(NEXUS_VERIFY_ATTEMPTS);
  });

  it("returns a bounded failure when indexing is missing", async () => {
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: WRITTEN,
      backoffMs: 1,
      fetchJson: fetcher([{ status: 500, body: null }]),
    });
    expect(result.failureCode).toBe("nexus_unavailable");
  });

  it("requires every written label for the URI, not just any label", async () => {
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: [
        { uri: "https://example.test/docs", label: "release" },
        { uri: "https://example.test/docs", label: "bitcoin" },
      ],
      backoffMs: 1,
      fetchJson: fetcher([{ status: 200, body: { tags: [{ label: "release" }] } }]),
    });
    expect(result).toEqual({ checked: 1, indexed: 0, attempts: NEXUS_VERIFY_ATTEMPTS, failureCode: "nexus_unavailable" });
  });

  it("caps the number of probed URIs and queries the by-uri endpoint with limit_tags=20", async () => {
    const seen: string[] = [];
    const written = Array.from({ length: NEXUS_VERIFY_MAX_URIS + 10 }, (_, i) => ({
      uri: `https://example.test/${i}`,
      label: "release",
    }));
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written,
      attempts: 1,
      backoffMs: 1,
      fetchJson: fetcher([{ status: 200, body: { tags: [{ label: "release" }] } }], seen),
    });
    expect(result.checked).toBe(NEXUS_VERIFY_MAX_URIS);
    expect(result.attempts).toBe(NEXUS_VERIFY_MAX_URIS);
    for (const url of seen) {
      expect(url).toContain("/v0/resource/by-uri?");
      expect(url).toContain("limit_tags=20");
      expect(url.startsWith("https://nexus.staging.pubky.app/")).toBe(true);
    }
  });
});
