import { PubkyAppTag } from "pubky-app-specs";
import { describe, expect, it } from "vitest";
import { discoverResources, RESOURCE_RECORD_MAX, type ExternalResource } from "./external-resources.js";
import type { Transport } from "./homeserver.js";
import {
  DEFAULT_RESOURCE_APP,
  assertDeletedFromHomeserver,
  deletePrecondition,
  requireReconcileTransport,
  RESOURCE_DELETE_MAX,
  RESOURCE_WRITE_MAX,
  assertResourceAppName,
  buildUniversalResourceTag,
  gatedResourceTransport,
  isUniversalTagHomeserverPath,
  publishResourceTags,
  readExisting,
  reconcileResourceTags,
  reconcilePlanSha256,
  resourceTagHomeserverPath,
} from "./resource-publish.js";
import {
  RESOURCE_PILOT_BOT_PK,
  STAGING_HOMESERVER_HOST,
  STAGING_HOMESERVER_PK,
  assertStagingHomeserverPk,
  assertStagingResourceHomeserverHost,
} from "./outbound-gate.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import { RESOURCE_LABELS_PER_RESOURCE_MAX } from "./resource-classify.js";

const BOT = RESOURCE_PILOT_BOT_PK;

function memoryTransport(
  botPk = BOT,
  resolvedHomeserverPk = STAGING_HOMESERVER_PK,
): Transport & { puts: string[]; deletes: string[]; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    botPk,
    resolvedHomeserverPk,
    puts,
    deletes,
    store,
    async putJson(path, json) {
      puts.push(path);
      store.set(path, json);
    },
    async putBytes() {},
    async getJson(path) {
      if (!store.has(path)) throw Object.assign(new Error("request failed"), { data: { statusCode: 404 } });
      return store.get(path);
    },
    async deleteJson(path) {
      deletes.push(path);
      store.delete(path);
    },
    async listPosts() {
      return [];
    },
    async reauth() {},
  };
}

function acceptedOne(): ExternalResource {
  const run = discoverResources(
    [{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }],
    { limit: 100, configVersion: "test-v1" },
  );
  return run.accepted[0]!;
}

const stagingCfg = {
  resourceTarget: "staging" as const,
  resourceMode: "publish" as const,
  resourceApp: DEFAULT_RESOURCE_APP,
  resourceConfigVersion: "test-v1",
  expectedPublisherPk: BOT,
  execute: true,
};

describe("universal tag app name (pubky-app-specs TagPath)", () => {
  it("accepts jeb.pubky.app and eventky.app, rejects pubky.app and slashes", () => {
    expect(assertResourceAppName("jeb.pubky.app")).toBe("jeb.pubky.app");
    expect(assertResourceAppName("eventky.app")).toBe("eventky.app");
    expect(assertResourceAppName("mapky")).toBe("mapky");
    expect(() => assertResourceAppName("pubky.app")).toThrow(/must not be pubky.app/);
    expect(isUniversalTagHomeserverPath("/pub/pubky.app/tags/CBYS8P6VJPHC5XXT4WDW26662W")).toBe(false);
    expect(isUniversalTagHomeserverPath("/pub/jeb.pubky.app/tags/CBYS8P6VJPHC5XXT4WDW26662W")).toBe(true);
    expect(() => assertResourceAppName("my/app")).toThrow(/single path segment/);
  });
});

describe("staging resource publisher contract", () => {
  it("written path matches the specs universal-tag shape and is not under pubky.app", async () => {
    const resource = acceptedOne();
    const client = memoryTransport();
    const manifest = await publishResourceTags([resource], stagingCfg, client);
    expect(manifest.written).toBeGreaterThan(0);
    for (const write of manifest.writes) {
      expect(isUniversalTagHomeserverPath(write.tagPath)).toBe(true);
      expect(write.tagPath.startsWith("/pub/jeb.pubky.app/tags/")).toBe(true);
      expect(write.tagPath.includes("/pub/pubky.app/tags/")).toBe(false);
      // TagPath::parse: pubky://<user>/pub/<app>/tags/<id>, app ≠ pubky.app
      const uri = `pubky://${BOT}${write.tagPath}`;
      expect(uri).toMatch(/^pubky:\/\/[a-z0-9]+\/pub\/jeb\.pubky\.app\/tags\/[A-Z0-9]+$/);
    }
  });

  it("JSON body round-trips through pubky-app-specs PubkyAppTag.fromJson", async () => {
    const resource = acceptedOne();
    const normalized = normalizeUri(resource.canonicalValue);
    const built = buildUniversalResourceTag(BOT, DEFAULT_RESOURCE_APP, normalized, "release");
    const parsed = PubkyAppTag.fromJson(built.body);
    expect(parsed.uri).toBe(normalized);
    expect(parsed.label).toBe("release");
    expect(built.body.uri).toBe(normalized);
    expect(built.path).toBe(resourceTagHomeserverPath(DEFAULT_RESOURCE_APP, built.tagId));
  });

  it("second run of the same batch produces 0 writes", async () => {
    const resource = acceptedOne();
    const client = memoryTransport();
    const first = await publishResourceTags([resource], stagingCfg, client);
    expect(first.written).toBeGreaterThan(0);
    const putsAfterFirst = client.puts.length;
    const second = await publishResourceTags([resource], stagingCfg, client);
    expect(second.written).toBe(0);
    expect(second.skipped_existing).toBe(first.written);
    expect(second.failed).toBe(0);
    expect(client.puts.length).toBe(putsAfterFirst);
  });

  // The staging pilot key can never publish to production: the production
  // profile pins a different publisher, and the refusal precedes any call.
  it("production target throws before any client call", async () => {
    const client = memoryTransport();
    await expect(
      publishResourceTags([acceptedOne()], { ...stagingCfg, resourceTarget: "production" }, client),
    ).rejects.toThrow("publisher pin constant/flag mismatch");
    expect(client.puts).toEqual([]);
  });

  it("101 inputs are rejected with no writes", async () => {
    const client = memoryTransport();
    expect(() =>
      discoverResources(
        Array.from({ length: 101 }, (_, i) => ({
          family: "url" as const,
          value: `https://example.test/docs/${i}`,
          source: "staging-catalog",
          labels: ["release"],
        })),
        { limit: 100, configVersion: "test-v1" },
      ),
    ).toThrow("no more than 100");
    expect(client.puts).toEqual([]);
  });

  it("records a failed PUT without aborting the batch", async () => {
    const resource = acceptedOne();
    const client = memoryTransport();
    client.putJson = async () => {
      throw new Error("homeserver 500");
    };
    const manifest = await publishResourceTags([resource], stagingCfg, client);
    expect(manifest.failed).toBeGreaterThan(0);
    expect(manifest.written).toBe(0);
  });

  it("resource identity on the write matches normalizeUri + resourceIdentity", async () => {
    const resource = acceptedOne();
    const client = memoryTransport();
    const manifest = await publishResourceTags([resource], stagingCfg, client);
    const write = manifest.writes[0]!;
    expect(write.normalizedUri).toBe(normalizeUri(resource.canonicalValue));
    expect(write.resourceIdentity).toBe(resourceIdentity(write.normalizedUri));
  });
});

describe("resource homeserver egress gate", () => {
  it("allows the staging homeserver host", () => {
    expect(() => assertStagingResourceHomeserverHost(STAGING_HOMESERVER_HOST)).not.toThrow();
    expect(() => assertStagingResourceHomeserverHost("https://homeserver.staging.pubky.app")).not.toThrow();
    expect(() => assertStagingHomeserverPk(STAGING_HOMESERVER_PK)).not.toThrow();
  });

  it("rejects a production homeserver host", () => {
    expect(() => assertStagingResourceHomeserverHost("homeserver.pubky.app")).toThrow(/resource egress refused/);
    expect(() => assertStagingResourceHomeserverHost("https://homeserver.pubky.app")).toThrow(/resource egress refused/);
    expect(() => assertStagingResourceHomeserverHost("nexus.pubky.app")).toThrow(/resource egress refused/);
  });

  it("throws before putJson when resolvedHomeserverPk is missing", async () => {
    const client = memoryTransport();
    client.resolvedHomeserverPk = undefined;
    await expect(publishResourceTags([acceptedOne()], stagingCfg, client)).rejects.toThrow(
      /session homeserver public key is missing/,
    );
    expect(client.puts).toEqual([]);
  });

  it("throws before putJson when the session reports a non-staging homeserver pk", async () => {
    const client = memoryTransport(BOT, "8um71us3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await expect(publishResourceTags([acceptedOne()], stagingCfg, client)).rejects.toThrow(
      /homeserver public key is not the staging homeserver/,
    );
    expect(client.puts).toEqual([]);
  });

  it("rejects a production host on the resolved session value", async () => {
    const client = memoryTransport();
    client.resolvedHomeserverHost = "homeserver.pubky.app";
    await expect(publishResourceTags([acceptedOne()], stagingCfg, client)).rejects.toThrow(
      /resource egress refused/,
    );
    expect(client.puts).toEqual([]);
  });

  it("refuses deleteJson on the gated transport", async () => {
    const gated = gatedResourceTransport(memoryTransport(), { mode: "publish", target: "staging" });
    expect(isUniversalTagHomeserverPath("/pub/pubky.app/posts/x")).toBe(false);
    await expect(gated.deleteJson("/pub/pubky.app/posts/x")).rejects.toThrow(/does not allow deleteJson/);
  });

  it("accepts the full write cap and rejects one more", async () => {
    const resource = acceptedOne();
    const manyLabels = Array.from({ length: RESOURCE_WRITE_MAX }, (_, i) => `lab${i}`);
    const atCap = { ...resource, labels: manyLabels };
    const client = memoryTransport();
    await expect(publishResourceTags([atCap], stagingCfg, client)).resolves.toMatchObject({ written: RESOURCE_WRITE_MAX });
    const overCap = { ...resource, labels: [...manyLabels, "one-too-many"] };
    const overCapClient = memoryTransport();
    await expect(publishResourceTags([overCap], stagingCfg, overCapClient)).rejects.toThrow(`max is ${RESOURCE_WRITE_MAX}`);
    expect(overCapClient.puts).toEqual([]);
  });
});

describe("reconcile delete precondition calibration", () => {
  const normalized = "https://example.test/docs";
  const built = buildUniversalResourceTag(BOT, DEFAULT_RESOURCE_APP, normalized, "documentation");
  const body = built.body;
  const base = () => ({
    mode: "reconcile" as const, target: "staging" as const, expectedPublisherPk: BOT, botPk: BOT,
    resolvedHomeserverPk: STAGING_HOMESERVER_PK, resolvedHomeserverHost: STAGING_HOMESERVER_HOST,
    path: built.path, listedPaths: new Set([built.path]), approvedDeletes: new Map([[built.path, body]]), body,
    resourceIdentity: resourceIdentity(normalized), acceptedUris: new Map([[resourceIdentity(normalized), normalized]]),
    desiredByResource: new Map(), retiredLabels: new Set(["documentation"]), policy: "retired" as const,
    app: DEFAULT_RESOURCE_APP,
  });
  it("passes the calibration case", () => expect(deletePrecondition(base())).toEqual({ ok: true }));
  it("rejects wrong mode", () => expect(deletePrecondition({ ...base(), mode: "publish" })).toEqual({ ok: false, reason: "mode" }));
  it("rejects production target", () => expect(deletePrecondition({ ...base(), target: "production" })).toEqual({ ok: false, reason: "mode" }));
  it("rejects wrong pilot", () => expect(deletePrecondition({ ...base(), expectedPublisherPk: "wrong" })).toEqual({ ok: false, reason: "mode" }));
  it("rejects wrong resolved pk", () => expect(deletePrecondition({ ...base(), resolvedHomeserverPk: "wrong" })).toEqual({ ok: false, reason: "mode" }));
  it("rejects unlisted path", () => expect(deletePrecondition({ ...base(), listedPaths: new Set() })).toEqual({ ok: false, reason: "allowlist" }));
  it("rejects unapproved path", () => expect(deletePrecondition({ ...base(), approvedDeletes: new Map() })).toEqual({ ok: false, reason: "allowlist" }));
  it("rejects non-universal path", () => {
    const path = "/pub/pubky.app/tags/x";
    expect(deletePrecondition({ ...base(), path, listedPaths: new Set([path]), approvedDeletes: new Map([[path, body]]) })).toEqual({ ok: false, reason: "path" });
  });
  it("rejects malformed body", () => expect(deletePrecondition({ ...base(), body: {} })).toEqual({ ok: false, reason: "body" }));
  it("rejects URI identity mismatch", () => expect(deletePrecondition({ ...base(), body: { ...body, uri: "https://other.test/" } })).toEqual({ ok: false, reason: "identity" }));
  it("rejects path identity mismatch", () => expect(deletePrecondition({ ...base(), body: { ...body, label: "project" } })).toEqual({ ok: false, reason: "recomputed_path" }));
  it("rejects desired label", () => expect(deletePrecondition({
    ...base(),
    desiredByResource: new Map([[resourceIdentity(normalized), new Set(["documentation"])]])
  })).toEqual({ ok: false, reason: "desired" }));
  it("rejects unretired label", () => expect(deletePrecondition({ ...base(), retiredLabels: new Set() })).toEqual({ ok: false, reason: "retired" }));
  it("rejects changed approved body", () => expect(deletePrecondition({ ...base(), approvedDeletes: new Map([[built.path, { ...body, created_at: body.created_at + 1 }]]) })).toEqual({ ok: false, reason: "approved_body" }));
  it("accepts full policy without retired membership", () => expect(deletePrecondition({ ...base(), policy: "full", retiredLabels: new Set() })).toEqual({ ok: true }));
  it("derives both caps from records and labels", () => {
    expect(RESOURCE_WRITE_MAX).toBe(RESOURCE_RECORD_MAX * RESOURCE_LABELS_PER_RESOURCE_MAX);
    expect(RESOURCE_DELETE_MAX).toBe(RESOURCE_RECORD_MAX * RESOURCE_LABELS_PER_RESOURCE_MAX);
  });
  it("executes exactly the delete cap before the next is rejected", async () => {
    const client = memoryTransport();
    const paths: string[] = [];
    const approved = new Map<string, ReturnType<typeof buildUniversalResourceTag>["body"]>();
    const acceptedUris = new Map<string, string>();
    for (let i = 0; i <= RESOURCE_DELETE_MAX; i += 1) {
      const uri = `https://example.test/docs/${i}`;
      const built = buildUniversalResourceTag(BOT, DEFAULT_RESOURCE_APP, uri, "general-tech");
      paths.push(built.path);
      approved.set(built.path, built.body);
      acceptedUris.set(resourceIdentity(uri), uri);
      client.store.set(built.path, built.body);
    }
    const gated = requireReconcileTransport(client, {
      mode: "reconcile",
      target: "staging",
      app: DEFAULT_RESOURCE_APP,
      expectedPublisherPk: BOT,
      listedPaths: new Set(paths),
      approvedDeletes: approved,
      acceptedUris,
      desiredByResource: new Map(),
      retiredLabels: new Set(["general-tech"]),
      policy: "full",
    });
    await expect(Promise.all(paths.map((path) => gated.deleteJson(path)))).rejects.toThrow(
      `DELETE execution cap exceeded; max is ${RESOURCE_DELETE_MAX}`,
    );
    expect(client.deletes).toHaveLength(RESOURCE_DELETE_MAX);
  });
});

describe("DELETE status precedence", () => {
  it("refuses a top-level 404 when nested data status is 500", async () => {
    const client = memoryTransport();
    client.getJson = async () => {
      throw Object.assign(new Error("request failed"), { status: 404, data: { statusCode: 500 } });
    };
    await expect(assertDeletedFromHomeserver(client, "/pub/jeb.pubky.app/tags/x")).rejects.toMatchObject({
      code: "readback_failed",
    });
  });

  it("does not treat a statusless not-found message as homeserver absence", async () => {
    const client = memoryTransport();
    client.getJson = async () => {
      throw new Error("upstream 500: resource not found");
    };
    await expect(readExisting(client, "/pub/jeb.pubky.app/tags/x")).rejects.toThrow("resource not found");
  });

  it("accepts literal nested 404 as homeserver absence", async () => {
    const client = memoryTransport();
    client.getJson = async () => {
      throw Object.assign(new Error("request failed"), { data: { statusCode: 404 } });
    };
    await expect(readExisting(client, "/pub/jeb.pubky.app/tags/x")).resolves.toBeNull();
  });
});

describe("reconcile plan execution", () => {
  it("reconciles a stale label per resource when another resource still desires it", async () => {
    const template = acceptedOne();
    const xUri = "https://example.test/x";
    const yUri = "https://example.test/y";
    const x = { ...template, canonicalValue: xUri, identity: resourceIdentity(xUri), labels: ["general-tech"] };
    const y = { ...template, canonicalValue: yUri, identity: resourceIdentity(yUri), labels: ["research"] };
    const client = memoryTransport();
    const staleX = buildUniversalResourceTag(BOT, DEFAULT_RESOURCE_APP, x.canonicalValue, "research");
    const wantedY = buildUniversalResourceTag(BOT, DEFAULT_RESOURCE_APP, y.canonicalValue, "research");
    client.store.set(staleX.path, staleX.body);
    client.store.set(wantedY.path, wantedY.body);
    client.listJsonPaths = async () => [...client.store.keys()];

    const dryRun = await reconcileResourceTags([x, y], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: BOT, policy: "full", retired: new Set(), execute: false,
    }, client);
    const result = await reconcileResourceTags([x, y], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: BOT, policy: "full", retired: new Set(), execute: true,
      confirmPlan: dryRun.planSha256,
    }, client);
    expect(result.plan.delete).toHaveLength(1);
    expect(client.deletes).toEqual([staleX.path]);
    expect(client.deletes).not.toContain(wantedY.path);
    expect(client.store.has(staleX.path)).toBe(false);
    expect(client.store.has(wantedY.path)).toBe(true);
  });

  it("requires the checked-in pilot pin, flag, and session to match", async () => {
    const resource = acceptedOne();
    const client = memoryTransport();
    client.listJsonPaths = async () => [];
    await expect(reconcileResourceTags([resource], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: "wrong", policy: "retired", retired: new Set(), execute: false,
    }, client)).rejects.toThrow("constant/flag mismatch");
    await expect(reconcileResourceTags([resource], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: BOT, policy: "retired", retired: new Set(), execute: false,
    }, memoryTransport("wrong"))).rejects.toThrow("flag/session mismatch");
    await expect(reconcileResourceTags([resource], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: BOT, policy: "retired", retired: new Set(), execute: false,
    }, client)).resolves.toBeDefined();
  });

  it("rejects plan drift before mutations", async () => {
    const resource = acceptedOne();
    const extra = buildUniversalResourceTag(BOT, DEFAULT_RESOURCE_APP, "https://example.test/docs/extra", "general-tech");
    const client = memoryTransport();
    client.store.set(extra.path, extra.body);
    let listings = 0;
    client.listJsonPaths = async () => {
      listings += 1;
      return listings === 1 ? [] : [extra.path];
    };
    await expect(reconcileResourceTags([resource], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: BOT, policy: "retired", retired: new Set(["general-tech"]), execute: true,
    }, client)).rejects.toThrow("reconcile plan drift");
    expect(client.puts).toEqual([]);
    expect(client.deletes).toEqual([]);
  });

  it("requires a matching confirmation hash for full execution", async () => {
    const resource = acceptedOne();
    const existing = buildUniversalResourceTag(BOT, DEFAULT_RESOURCE_APP, resource.canonicalValue, "general-tech");
    const client = memoryTransport();
    client.store.set(existing.path, existing.body);
    client.listJsonPaths = async () => [...client.store.keys()];
    await expect(reconcileResourceTags([resource], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: BOT, policy: "full", retired: new Set(), execute: true,
    }, client)).rejects.toThrow("matching --confirm-plan");
    expect(client.deletes).toEqual([]);
    await expect(reconcileResourceTags([resource], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: BOT, policy: "full", retired: new Set(), execute: true, confirmPlan: "wrong",
    }, client)).rejects.toThrow("matching --confirm-plan");
    expect(client.deletes).toEqual([]);
  });

  it("preserves an out-of-scope tag under the prefix", async () => {
    const resource = acceptedOne();
    const other = buildUniversalResourceTag(BOT, DEFAULT_RESOURCE_APP, "https://other.test/out-of-scope", "general-tech");
    const client = memoryTransport();
    client.store.set(other.path, other.body);
    client.listJsonPaths = async () => [...client.store.keys()];
    const dryRun = await reconcileResourceTags([resource], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: BOT, policy: "full", retired: new Set(), execute: false,
    }, client);
    await expect(reconcileResourceTags([resource], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: BOT, policy: "full", retired: new Set(), execute: true,
      confirmPlan: dryRun.planSha256,
    }, client)).resolves.toBeDefined();
    expect(client.deletes).toEqual([]);
    expect(client.store.has(other.path)).toBe(true);
  });

  it("keeps an existing matching tag despite an older created_at", async () => {
    const resource = acceptedOne();
    const normalized = normalizeUri(resource.canonicalValue);
    const built = buildUniversalResourceTag(BOT, DEFAULT_RESOURCE_APP, normalized, "release");
    const client = memoryTransport();
    client.store.set(built.path, { ...built.body, created_at: built.body.created_at - 1000 });
    client.listJsonPaths = async () => [built.path];
    const result = await reconcileResourceTags([resource], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: BOT, policy: "retired", retired: new Set(["general-tech"]), execute: false,
    }, client);
    expect(result.plan.resources[0]?.keep).toHaveLength(1);
    expect(result.plan.resources[0]?.delete).toHaveLength(0);
  });

  it("keeps PLAN hashes stable across identical listings", async () => {
    const resource = acceptedOne();
    const normalized = normalizeUri(resource.canonicalValue);
    const built = buildUniversalResourceTag(BOT, DEFAULT_RESOURCE_APP, normalized, "release");
    const client = memoryTransport();
    client.store.set(built.path, { ...built.body, created_at: built.body.created_at - 1000 });
    client.listJsonPaths = async () => [built.path];
    const result = await reconcileResourceTags([resource], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: BOT, policy: "retired", retired: new Set(["general-tech"]), execute: true,
    }, client);
    expect(result.planSha256).toBe(reconcilePlanSha256(result.plan, {
      policy: "retired", retired: new Set(["general-tech"]), resourceConfigVersion: "test-v1",
      resourceApp: DEFAULT_RESOURCE_APP, botPk: BOT, resolvedHomeserverPk: STAGING_HOMESERVER_PK,
      resourceTarget: "staging", expectedPublisherPk: BOT, allowMassDelete: false, allowHighDeleteRatio: false,
    }));
  });

  it("plans missing tags without mutation in dry-run", async () => {
    const resource = acceptedOne();
    const paths: string[] = [];
    const client = memoryTransport() as Transport & { listJsonPaths: (prefix: string) => Promise<string[]> };
    client.listJsonPaths = async () => paths;
    const result = await reconcileResourceTags([resource], {
      resourceTarget: "staging", resourceApp: DEFAULT_RESOURCE_APP, resourceConfigVersion: "test-v1",
      expectedPublisherPk: BOT, policy: "retired", retired: new Set(["general-tech"]), execute: false,
    }, client);
    expect(result.plan.put.length).toBe(resource.labels.length);
    expect(client.puts).toEqual([]);
  });

  it("changes the canonical confirmation hash when preimage metadata changes", () => {
    const plan = {
      resources: [{ resource_id: "a".repeat(32), uri: "https://example.test/docs", keep: [], put: [], delete: [], protected: [] }],
      put: [], delete: [], listed: 0,
    };
    const context = {
      policy: "retired" as const, retired: new Set(["general-tech"]), resourceConfigVersion: "test-v1",
      resourceApp: DEFAULT_RESOURCE_APP, botPk: BOT, resolvedHomeserverPk: STAGING_HOMESERVER_PK,
      resolvedHomeserverHost: STAGING_HOMESERVER_HOST,
      resourceTarget: "staging" as const, expectedPublisherPk: BOT,
      allowMassDelete: false, allowHighDeleteRatio: false,
    };
    const hash = reconcilePlanSha256(plan, context);
    expect(reconcilePlanSha256(plan, { ...context, resourceTarget: "production" })).not.toBe(hash);
    expect(reconcilePlanSha256(plan, { ...context, expectedPublisherPk: "other" })).not.toBe(hash);
    expect(reconcilePlanSha256(plan, { ...context, allowMassDelete: true })).not.toBe(hash);
    expect(reconcilePlanSha256(plan, { ...context, allowHighDeleteRatio: true })).not.toBe(hash);
    expect(reconcilePlanSha256(plan, { ...context, policy: "full" })).not.toBe(hash);
    expect(reconcilePlanSha256(plan, { ...context, botPk: "other" })).not.toBe(hash);
    expect(reconcilePlanSha256(plan, { ...context, resourceConfigVersion: "other" })).not.toBe(hash);
    expect(reconcilePlanSha256(plan, { ...context, retired: new Set(["homepage"]) })).not.toBe(hash);
    expect(reconcilePlanSha256(plan, { ...context, resourceApp: "eventky.app" })).not.toBe(hash);
    expect(reconcilePlanSha256(plan, { ...context, resolvedHomeserverHost: "other" })).not.toBe(hash);
    expect(reconcilePlanSha256(plan, { ...context, resolvedHomeserverPk: "other" })).not.toBe(hash);
    expect(reconcilePlanSha256({ ...plan, listed: 1 }, context)).not.toBe(hash);
    expect(reconcilePlanSha256(plan, { ...context })).toBe(hash);
  });
});
