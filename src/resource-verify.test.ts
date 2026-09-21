import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RESOURCE_PILOT_BOT_PK } from "./outbound-gate.js";
import { NEXUS_VERIFY_LIMIT_TAGGERS, NEXUS_VERIFY_LIMIT_TAGS, verifyNexusIndexed } from "./resource-nexus-verify.js";
import { buildUniversalResourceTag, type ResourceTagBody } from "./resource-publish.js";
import { loadExecutedPlan, readLegacyPublishManifest, runVerifyMode, verifyExecutedPlan, type ExecutedPlanInput } from "./resource-verify.js";

const FIXTURES = new URL("./test-fixtures/", import.meta.url);
const NEXUS_URL = "https://nexus.staging.pubky.app";
const PUBKYRING = "https://pubkyring.app/";
const ORPHANED_PILOT_V1 = "ui8nw8s9do7u9k9qts4cbup9ry6agz3wxmr734ddhk6jb6zcubso";

/**
 * Rows copied verbatim from the executed P2 publish manifest
 * (`evidence/p2-publish/publish-0a35322.log`, 2026-09-14), for the one resource
 * whose live Nexus and homeserver answers are pinned as fixtures.
 */
const P2_PUBKYRING_WRITES = [
  { label: "bitcoin", tagId: "24WCH7QV0PHAZV7QD5F48GTXM0" },
  { label: "pubky-ring", tagId: "FX0MXSSEXF4YBCDDV95X1NKCKW" },
  { label: "key-management", tagId: "9Y2BA1CV28Q3AT5B8G54N52794" },
  { label: "pubky-app", tagId: "VG4ANNMJZ3Z1FSP4WR8ZG3MNGG" },
  { label: "pubky-core", tagId: "XXV5H3P4FAPJFNYP202FWYEAAR" },
  { label: "self-custody", tagId: "FPV1Z2BNMWTT1AVT5ESEPRAC6M" },
  { label: "digital-identity", tagId: "JA8N0A6JT5M920BBXNCJKD9SRM" },
  { label: "pubky", tagId: "SHX5V4Z7276AHZVTP5PPD7RVJ0" },
  { label: "synonym", tagId: "VQRJ6KN712YF80CN9VCTBTZK54" },
].map((row) => ({
  normalizedUri: PUBKYRING,
  resourceIdentity: "d58a7bd2757f75b3fa0eb232fd99ffdc",
  label: row.label,
  tagId: row.tagId,
  tagPath: `/pub/jeb.pubky.app/tags/${row.tagId}`,
}));

function legacyManifest(writes = P2_PUBKYRING_WRITES): string {
  return JSON.stringify({
    mode: "publish",
    publish: {
      configVersion: "external-resources-v3-bitcoin-canon",
      app: "jeb.pubky.app",
      target: "staging",
      written: writes.length,
      skipped_existing: 0,
      failed: 0,
      writes,
      failures: [],
    },
  });
}

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, FIXTURES), "utf8"));
}

/** Homeserver public read modelled on the live tag file: `{ created_at, label, uri }` in that key order. */
function homeserverFrom(bodies: Record<string, ResourceTagBody>): (path: string) => Promise<ResourceTagBody | null> {
  return async (path) => bodies[path] ?? null;
}

function allPubkyringBodies(): Record<string, ResourceTagBody> {
  return Object.fromEntries(
    P2_PUBKYRING_WRITES.map((row) => [row.tagPath, { created_at: 1789456954862000, label: row.label, uri: PUBKYRING }]),
  );
}

const tempDirs: string[] = [];
afterEach(async () => {
  delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function writeTemp(name: string, contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jeb-verify-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, contents, "utf8");
  return path;
}

describe("live fixtures", () => {
  it("the executed P2 manifest rows re-derive their tag paths under the pinned publisher", () => {
    for (const row of P2_PUBKYRING_WRITES) {
      const built = buildUniversalResourceTag(RESOURCE_PILOT_BOT_PK, "jeb.pubky.app", PUBKYRING, row.label);
      expect(built.path).toBe(row.tagPath);
      expect(built.tagId).toBe(row.tagId);
    }
  });

  it("the live homeserver tag file matches the manifest row for `bitcoin`", async () => {
    const body = (await fixture("homeserver/tag-24WCH7QV0PHAZV7QD5F48GTXM0-2026-09-21.json")) as ResourceTagBody;
    expect(body).toEqual({ created_at: 1789456954862000, label: "bitcoin", uri: PUBKYRING });
  });

  it("the live Nexus by-uri answer lists every P2 label with pilot v2 as tagger", async () => {
    const body = (await fixture("nexus/by-uri-pubkyring-2026-09-21.json")) as { tags: Array<{ label: string; taggers: string[] }> };
    const labels = new Set(body.tags.map((tag) => tag.label));
    for (const row of P2_PUBKYRING_WRITES) expect(labels.has(row.label)).toBe(true);
    for (const tag of body.tags) expect(tag.taggers).toContain(RESOURCE_PILOT_BOT_PK);
  });
});

describe("readLegacyPublishManifest", () => {
  it("accepts the executed manifest shape and prints the sha256 of the file bytes", async () => {
    const raw = legacyManifest();
    const path = await writeTemp("publish.json", raw);
    const manifest = await readLegacyPublishManifest(path);
    expect(manifest.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(manifest.publisherPk).toBe(RESOURCE_PILOT_BOT_PK);
    expect(manifest.app).toBe("jeb.pubky.app");
    expect(manifest.expected).toHaveLength(9);
    expect(manifest.expected.map((tag) => tag.path).sort()).toEqual(P2_PUBKYRING_WRITES.map((row) => row.tagPath).sort());
  });

  it("refuses a row whose label was edited (tag path no longer derives)", async () => {
    const edited = P2_PUBKYRING_WRITES.map((row, i) => (i === 0 ? { ...row, label: "ethereum" } : row));
    const path = await writeTemp("publish.json", legacyManifest(edited));
    await expect(readLegacyPublishManifest(path)).rejects.toThrow("tag path does not derive");
  });

  it("refuses a manifest for another app, a non-staging target, or a non-normalized uri", async () => {
    const other = JSON.parse(legacyManifest()) as { publish: Record<string, unknown> };
    other.publish.app = "pubky.app";
    await expect(readLegacyPublishManifest(await writeTemp("a.json", JSON.stringify(other)))).rejects.toThrow("pubky.app");
    const prod = JSON.parse(legacyManifest()) as { publish: Record<string, unknown> };
    prod.publish.target = "production";
    await expect(readLegacyPublishManifest(await writeTemp("b.json", JSON.stringify(prod)))).rejects.toThrow("not staging");
    const upper = P2_PUBKYRING_WRITES.map((row, i) => (i === 0 ? { ...row, normalizedUri: "HTTPS://pubkyring.app/" } : row));
    await expect(readLegacyPublishManifest(await writeTemp("c.json", legacyManifest(upper)))).rejects.toThrow("not normalized");
  });

  it("refuses more than the record cap of distinct resources", async () => {
    const writes = Array.from({ length: 101 }, (_, i) => {
      const uri = `https://example.com/${i}`;
      const built = buildUniversalResourceTag(RESOURCE_PILOT_BOT_PK, "jeb.pubky.app", uri, "bitcoin");
      return { normalizedUri: uri, label: "bitcoin", tagId: built.tagId, tagPath: built.path };
    });
    await expect(readLegacyPublishManifest(await writeTemp("d.json", legacyManifest(writes)))).rejects.toThrow("101 resources");
  });

  it("refuses malformed, empty, oversized, or non-JSON files", async () => {
    await expect(readLegacyPublishManifest(await writeTemp("e.json", ""))).rejects.toThrow("size");
    await expect(readLegacyPublishManifest(await writeTemp("f.json", "{"))).rejects.toThrow("not valid JSON");
    await expect(readLegacyPublishManifest(await writeTemp("g.json", "[]"))).rejects.toThrow("not an object");
    await expect(readLegacyPublishManifest(await writeTemp("h.json", JSON.stringify({ publish: { app: "jeb.pubky.app" } })))).rejects.toThrow("missing app, configVersion, or writes");
    await expect(readLegacyPublishManifest(join(tmpdir(), "does-not-exist-jeb-verify.json"))).rejects.toThrow("cannot be read");
  });
});

describe("loadExecutedPlan argv", () => {
  it("requires exactly one of --plan or --manifest", async () => {
    await expect(loadExecutedPlan([])).rejects.toThrow("exactly one of --plan");
    await expect(loadExecutedPlan(["--plan", "a", "--manifest", "b"])).rejects.toThrow("exactly one of --plan");
  });

  it("pins the manifest sha when --confirm-plan is given", async () => {
    const raw = legacyManifest();
    const path = await writeTemp("publish.json", raw);
    const sha = createHash("sha256").update(raw).digest("hex");
    await expect(loadExecutedPlan(["--manifest", path, "--confirm-plan", "0".repeat(64)])).rejects.toThrow("does not match the publish manifest");
    const loaded = await loadExecutedPlan(["--manifest", path, "--confirm-plan", sha]);
    expect(loaded.input).toEqual({ kind: "manifest", path, sha256: sha });
  });
});

describe("verifyNexusIndexed", () => {
  it("uses explicit limit_tags/limit_taggers and reads the live 200 shape", async () => {
    const live = await fixture("nexus/by-uri-pubkyring-2026-09-21.json");
    const urls: string[] = [];
    const result = await verifyNexusIndexed({
      nexusUrl: NEXUS_URL,
      timeoutMs: 1000,
      written: P2_PUBKYRING_WRITES.map((row) => ({ uri: PUBKYRING, label: row.label, publisherPk: RESOURCE_PILOT_BOT_PK })),
      fetchJson: async (url) => {
        urls.push(url.toString());
        return { status: 200, body: live };
      },
    });
    expect(result).toEqual({ checked: 1, indexed: 1, attempts: 1, misses: [] });
    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    expect(url.pathname).toBe("/v0/resource/by-uri");
    expect(url.searchParams.get("uri")).toBe(PUBKYRING);
    expect(url.searchParams.get("limit_tags")).toBe(String(NEXUS_VERIFY_LIMIT_TAGS));
    expect(url.searchParams.get("limit_taggers")).toBe(String(NEXUS_VERIFY_LIMIT_TAGGERS));
  });

  it("reports nexus_label_mismatch per label on the live 404 shape after every attempt", async () => {
    const missing = await fixture("nexus/by-uri-missing-2026-09-21.json");
    const result = await verifyNexusIndexed({
      nexusUrl: NEXUS_URL,
      timeoutMs: 1000,
      written: [{ uri: "https://example.invalid/not-indexed-2026-09-21", label: "bitcoin", publisherPk: RESOURCE_PILOT_BOT_PK }],
      attempts: 3,
      backoffMs: 0,
      fetchJson: async () => ({ status: 404, body: missing }),
    });
    expect(result.attempts).toBe(3);
    expect(result.indexed).toBe(0);
    expect(result.misses).toEqual([{ uri: "https://example.invalid/not-indexed-2026-09-21", label: "bitcoin", reason: "nexus_label_mismatch" }]);
    expect(result.failureCode).toBe("nexus_label_mismatch");
  });

  it("a label tagged only by the orphaned pilot v1 does not verify for pilot v2", async () => {
    const result = await verifyNexusIndexed({
      nexusUrl: NEXUS_URL,
      timeoutMs: 1000,
      written: [{ uri: PUBKYRING, label: "bitcoin", publisherPk: RESOURCE_PILOT_BOT_PK }],
      attempts: 1,
      backoffMs: 0,
      fetchJson: async () => ({ status: 200, body: { tags: [{ label: "bitcoin", taggers: [ORPHANED_PILOT_V1], taggers_count: 1, relationship: false }] } }),
    });
    expect(result.misses).toEqual([{ uri: PUBKYRING, label: "bitcoin", reason: "nexus_label_mismatch" }]);
  });

  it("reports nexus_unavailable on non-200/404 answers and thrown fetches", async () => {
    for (const fetchJson of [async () => ({ status: 503, body: null }), async () => { throw new Error("boom"); }]) {
      const result = await verifyNexusIndexed({
        nexusUrl: NEXUS_URL,
        timeoutMs: 1000,
        written: [{ uri: PUBKYRING, label: "bitcoin", publisherPk: RESOURCE_PILOT_BOT_PK }],
        attempts: 2,
        backoffMs: 0,
        fetchJson,
      });
      expect(result.attempts).toBe(2);
      expect(result.misses).toEqual([{ uri: PUBKYRING, label: "bitcoin", reason: "nexus_unavailable" }]);
    }
  });

  it("refuses more URIs than the cap", async () => {
    await expect(verifyNexusIndexed({
      nexusUrl: NEXUS_URL,
      timeoutMs: 1000,
      written: Array.from({ length: 101 }, (_, i) => ({ uri: `https://example.com/${i}`, label: "bitcoin", publisherPk: RESOURCE_PILOT_BOT_PK })),
      fetchJson: async () => ({ status: 200, body: { tags: [] } }),
    })).rejects.toThrow("exceeds the cap");
  });
});

describe("verifyExecutedPlan", () => {
  async function p2Input(): Promise<ExecutedPlanInput> {
    const raw = legacyManifest();
    const path = await writeTemp("publish.json", raw);
    return loadExecutedPlan(["--manifest", path]);
  }

  it("reports 1/1 resources and 9/9 tags when homeserver and Nexus both hold the executed set", async () => {
    const live = await fixture("nexus/by-uri-pubkyring-2026-09-21.json");
    const result = await verifyExecutedPlan(await p2Input(), { nexusUrl: NEXUS_URL, timeoutMs: 1000, testnet: false }, {
      homeserverRead: homeserverFrom(allPubkyringBodies()),
      fetchJson: async () => ({ status: 200, body: live }),
    });
    expect(result.verified).toBe(true);
    expect(result.resources_total).toBe(1);
    expect(result.resources_verified).toBe(1);
    expect(result.tags_total).toBe(9);
    expect(result.tags_homeserver_ok).toBe(9);
    expect(result.tags_nexus_ok).toBe(9);
    expect(result.misses).toEqual([]);
    expect(result.publisher).toBe(RESOURCE_PILOT_BOT_PK);
  });

  it("a tag missing on the homeserver fails the resource even when Nexus still lists it", async () => {
    const live = await fixture("nexus/by-uri-pubkyring-2026-09-21.json");
    const bodies = allPubkyringBodies();
    delete bodies["/pub/jeb.pubky.app/tags/24WCH7QV0PHAZV7QD5F48GTXM0"];
    const result = await verifyExecutedPlan(await p2Input(), { nexusUrl: NEXUS_URL, timeoutMs: 1000, testnet: false }, {
      homeserverRead: homeserverFrom(bodies),
      fetchJson: async () => ({ status: 200, body: live }),
    });
    expect(result.verified).toBe(false);
    expect(result.resources_verified).toBe(0);
    expect(result.tags_homeserver_ok).toBe(8);
    expect(result.tags_nexus_ok).toBe(9);
    expect(result.misses).toEqual([{ uri: PUBKYRING, label: "bitcoin", reason: "missing_on_homeserver" }]);
  });

  it("a homeserver body with a different uri/label is a mismatch, and a read error is unavailable", async () => {
    const live = await fixture("nexus/by-uri-pubkyring-2026-09-21.json");
    const bodies = allPubkyringBodies();
    bodies["/pub/jeb.pubky.app/tags/24WCH7QV0PHAZV7QD5F48GTXM0"] = { created_at: 1, label: "ethereum", uri: PUBKYRING };
    const result = await verifyExecutedPlan(await p2Input(), { nexusUrl: NEXUS_URL, timeoutMs: 1000, testnet: false }, {
      homeserverRead: async (path) => {
        if (path.endsWith("FX0MXSSEXF4YBCDDV95X1NKCKW")) throw new Error("timeout");
        return bodies[path] ?? null;
      },
      fetchJson: async () => ({ status: 200, body: live }),
    });
    expect(result.misses).toEqual([
      { uri: PUBKYRING, label: "bitcoin", reason: "homeserver_body_mismatch" },
      { uri: PUBKYRING, label: "pubky-ring", reason: "homeserver_unavailable" },
    ]);
    expect(result.verified).toBe(false);
  });

  it("a resource Nexus has not indexed fails every expected label with nexus_label_mismatch", async () => {
    const missing = await fixture("nexus/by-uri-missing-2026-09-21.json");
    const result = await verifyExecutedPlan(await p2Input(), { nexusUrl: NEXUS_URL, timeoutMs: 1000, testnet: false }, {
      homeserverRead: homeserverFrom(allPubkyringBodies()),
      fetchJson: async () => ({ status: 404, body: missing }),
      nexusAttempts: 1,
      nexusBackoffMs: 0,
    });
    expect(result.tags_homeserver_ok).toBe(9);
    expect(result.tags_nexus_ok).toBe(0);
    expect(result.misses).toHaveLength(9);
    expect(new Set(result.misses.map((miss) => miss.reason))).toEqual(new Set(["nexus_label_mismatch"]));
    expect(result.verified).toBe(false);
  });

  it("an empty expected set is never verified", async () => {
    const result = await verifyExecutedPlan(
      { input: { kind: "manifest", path: "x", sha256: "0".repeat(64) }, publisherPk: RESOURCE_PILOT_BOT_PK, app: "jeb.pubky.app", configVersion: "v", expected: [] },
      { nexusUrl: NEXUS_URL, timeoutMs: 1000, testnet: false },
      { homeserverRead: async () => null, fetchJson: async () => ({ status: 200, body: { tags: [] } }) },
    );
    expect(result.verified).toBe(false);
    expect(result.tags_total).toBe(0);
  });
});

describe("runVerifyMode", () => {
  it("refuses when key material is present in the process and never reads anything", async () => {
    process.env.PUBKY_BOT_SECRET_KEY_HEX = "00";
    let reads = 0;
    await expect(runVerifyMode(
      { nexusUrl: NEXUS_URL, nexusTimeoutMs: 1000, testnet: false, resourceTarget: "staging" },
      ["--manifest", "x"],
      { homeserverRead: async () => { reads += 1; return null; }, fetchJson: async () => { reads += 1; return { status: 200, body: null }; } },
    )).rejects.toThrow("key material must not be present");
    expect(reads).toBe(0);
  });

  it("refuses a non-staging target", async () => {
    await expect(runVerifyMode(
      { nexusUrl: NEXUS_URL, nexusTimeoutMs: 1000, testnet: false, resourceTarget: "production" },
      ["--manifest", "x"],
    )).rejects.toThrow("staging-only");
  });

  it("prints one JSON document and ok follows verified", async () => {
    const live = await fixture("nexus/by-uri-pubkyring-2026-09-21.json");
    const path = await writeTemp("publish.json", legacyManifest());
    const result = await runVerifyMode(
      { nexusUrl: NEXUS_URL, nexusTimeoutMs: 1000, testnet: false, resourceTarget: "staging" },
      ["--role", "resources", "--mode", "verify", "--manifest", path],
      { homeserverRead: homeserverFrom(allPubkyringBodies()), fetchJson: async () => ({ status: 200, body: live }) },
    );
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.lines[0]!) as { mode: string; resources_verified: number; tags_total: number; verified: boolean };
    expect(parsed).toMatchObject({ mode: "verify", resources_verified: 1, tags_total: 9, verified: true });
  });
});
