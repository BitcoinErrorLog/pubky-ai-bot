import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  NEXUS_VERIFY_ATTEMPTS,
  NEXUS_VERIFY_MAX_URIS,
  verifyNexusIndexed,
  type NexusFetchJson,
} from "./resource-nexus-verify.js";

const PUBLISHER = "ui8nw8s9do7u9k9qts4cbup9ry6agz3wxmr734ddhk6jb6zcubso";
const OTHER_PUBLISHER = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WRITTEN = [{ uri: "https://example.test/docs", label: "release", publisherPk: PUBLISHER }];
const LIVE_NEXUS_FIXTURE_SHA256 = "3631e3bfec7813a1234a3888903bde794941252a53d0cd786a4d1a5df53e6f53";
const LIVE_NEXUS_404_FIXTURE_SHA256 = "be5809879b7a924d19a59f264bdc83f0f11b07b6e84afc8e98f9bf8a080db416";

async function readFixture(name: string, sha256: string): Promise<unknown> {
  const raw = await readFile(new URL(`./test-fixtures/nexus/${name}.json`, import.meta.url));
  expect(createHash("sha256").update(raw).digest("hex")).toBe(sha256);
  return JSON.parse(raw.toString()) as unknown;
}

async function readProvenance(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(`./test-fixtures/nexus/${name}.provenance.json`, import.meta.url), "utf8")) as Record<string, unknown>;
}

function taggedFixtureCopy(body: unknown, label: string, taggers: unknown): unknown {
  const copy = structuredClone(body) as { tags?: Array<{ label?: unknown; taggers?: unknown }> };
  const tag = copy.tags?.find((row) => row.label === label);
  if (!tag) throw new Error(`fixture did not contain ${label}`);
  tag.taggers = taggers;
  return copy;
}

function fetcher(sequence: Array<{ status: number; body: unknown }>, seen: string[] = []): NexusFetchJson {
  let calls = 0;
  return async (url) => {
    calls += 1;
    seen.push(url.toString());
    return sequence[Math.min(calls - 1, sequence.length - 1)]!;
  };
}

describe("bounded Nexus indexing check", () => {
  it("pins the captured live by-uri response and verifies its publisher-scoped labels", async () => {
    const body = await readFixture("known-bitcoin-org", LIVE_NEXUS_FIXTURE_SHA256);
    expect(await readProvenance("known-bitcoin-org")).toMatchObject({
      capturedAt: "2026-09-11T14:30:31Z",
      endpoint: "GET https://nexus.staging.pubky.app/v0/resource/by-uri?uri=https://bitcoin.org/&limit_tags=20&limit_taggers=50",
      httpStatus: 200,
      limits: { limit_tags: 20, limit_taggers: 50 },
      originalSha256: LIVE_NEXUS_FIXTURE_SHA256,
      rawBody: "known-bitcoin-org.json",
    });
    const seen: string[] = [];
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: [
        { uri: "https://bitcoin.org/", label: "white-paper", publisherPk: PUBLISHER },
        { uri: "https://bitcoin.org/", label: "bitcoin", publisherPk: PUBLISHER },
      ],
      attempts: 1,
      fetchJson: fetcher([{ status: 200, body }], seen),
    });

    expect(result).toEqual({ checked: 1, indexed: 1, attempts: 1 });
    expect(seen).toEqual([
      "https://nexus.staging.pubky.app/v0/resource/by-uri?uri=https%3A%2F%2Fbitcoin.org%2F&limit_tags=20&limit_taggers=50",
    ]);
  });

  it("rejects the live response when the publisher is removed from one expected label", async () => {
    const body = taggedFixtureCopy(await readFixture("known-bitcoin-org", LIVE_NEXUS_FIXTURE_SHA256), "white-paper", []);
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: [{ uri: "https://bitcoin.org/", label: "white-paper", publisherPk: PUBLISHER }],
      attempts: 1,
      fetchJson: fetcher([{ status: 200, body }]),
    });

    expect(result).toEqual({ checked: 1, indexed: 0, attempts: 1, failureCode: "nexus_label_mismatch" });
  });

  it("rejects another publisher attached to an expected label in the live response", async () => {
    const body = taggedFixtureCopy(
      await readFixture("known-bitcoin-org", LIVE_NEXUS_FIXTURE_SHA256),
      "white-paper",
      [OTHER_PUBLISHER],
    );
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: [{ uri: "https://bitcoin.org/", label: "white-paper", publisherPk: PUBLISHER }],
      attempts: 1,
      fetchJson: fetcher([{ status: 200, body }]),
    });

    expect(result).toEqual({ checked: 1, indexed: 0, attempts: 1, failureCode: "nexus_label_mismatch" });
  });

  it("fails closed when the live response's taggers field is malformed", async () => {
    const body = taggedFixtureCopy(
      await readFixture("known-bitcoin-org", LIVE_NEXUS_FIXTURE_SHA256),
      "white-paper",
      PUBLISHER,
    );
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: [{ uri: "https://bitcoin.org/", label: "white-paper", publisherPk: PUBLISHER }],
      attempts: 1,
      fetchJson: fetcher([{ status: 200, body }]),
    });

    expect(result).toEqual({ checked: 1, indexed: 0, attempts: 1, failureCode: "nexus_label_mismatch" });
  });

  it("treats the captured 404 response as bounded unavailable indexing", async () => {
    const body = await readFixture("negative-unknown", LIVE_NEXUS_404_FIXTURE_SHA256);
    expect(await readProvenance("negative-unknown")).toMatchObject({
      capturedAt: "2026-09-11T14:30:31Z",
      endpoint: "GET https://nexus.staging.pubky.app/v0/resource/by-uri?uri=https://this-domain-definitely-does-not-exist-9f3a.example/nowhere&limit_tags=20&limit_taggers=50",
      httpStatus: 404,
      limits: { limit_tags: 20, limit_taggers: 50 },
      originalSha256: LIVE_NEXUS_404_FIXTURE_SHA256,
      rawBody: "negative-unknown.json",
    });
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: WRITTEN,
      attempts: 1,
      fetchJson: fetcher([{ status: 404, body }]),
    });

    expect(result).toEqual({ checked: 1, indexed: 0, attempts: 1, failureCode: "nexus_unavailable" });
  });

  it("counts a URI as indexed once every written label appears", async () => {
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: WRITTEN,
      backoffMs: 1,
      fetchJson: fetcher([{ status: 200, body: { tags: [{ label: "release", taggers: [PUBLISHER] }] } }]),
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
        { status: 200, body: { tags: [{ label: "release", taggers: [PUBLISHER] }] } },
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
      fetchJson: fetcher([{ status: 200, body: { tags: [{ label: "release", taggers: [PUBLISHER] }] } }]),
    });
    expect(result).toEqual({ checked: 1, indexed: 0, attempts: NEXUS_VERIFY_ATTEMPTS, failureCode: "nexus_label_mismatch" });
  });

  it("checks every distinct URI and sends both bounded Nexus limits", async () => {
    const seen: string[] = [];
    const written = Array.from({ length: 21 }, (_, i) => ({
      uri: `https://example.test/${i}`,
      label: "release",
      publisherPk: PUBLISHER,
    }));
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written,
      attempts: 1,
      backoffMs: 1,
      fetchJson: fetcher([{ status: 200, body: { tags: [{ label: "release", taggers: [PUBLISHER] }] } }], seen),
    });
    expect(result.checked).toBe(21);
    expect(result.indexed).toBe(21);
    expect(result.attempts).toBe(21);
    for (const url of seen) {
      expect(url).toContain("/v0/resource/by-uri?");
      expect(url).toContain("limit_tags=20");
      expect(url).toContain("limit_taggers=50");
      expect(url.startsWith("https://nexus.staging.pubky.app/")).toBe(true);
    }
  });

  it("rejects a same-label tag owned only by another publisher", async () => {
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written: WRITTEN,
      attempts: 1,
      backoffMs: 1,
      fetchJson: fetcher([{ status: 200, body: { tags: [{ label: "release", taggers: [OTHER_PUBLISHER] }] } }]),
    });
    expect(result).toEqual({ checked: 1, indexed: 0, attempts: 1, failureCode: "nexus_label_mismatch" });
  });

  it("fails closed instead of truncating above the internal URI ceiling", async () => {
    const written = Array.from({ length: NEXUS_VERIFY_MAX_URIS + 1 }, (_, i) => ({
      uri: `https://example.test/overflow/${i}`,
      label: "release",
      publisherPk: PUBLISHER,
    }));
    const fetchJson: NexusFetchJson = async () => {
      throw new Error("must not probe after overflow");
    };
    const result = await verifyNexusIndexed({
      nexusUrl: "https://nexus.staging.pubky.app",
      timeoutMs: 500,
      written,
      fetchJson,
    });
    expect(result).toEqual({
      checked: NEXUS_VERIFY_MAX_URIS + 1,
      indexed: 0,
      attempts: 0,
      failureCode: "nexus_unavailable",
    });
  });
});
