import { describe, expect, it } from "vitest";
import { discoverResources, type ExternalResource } from "./external-resources.js";
import type { Transport } from "./homeserver.js";
import {
  buildUniversalResourceTag,
  DEFAULT_RESOURCE_APP,
  deletePrecondition,
  productionFullDeleteCeiling,
  productionFullDeleteViolations,
  publishPlanSha256,
  publishResourceTags,
  reconcileResourceTags,
  type ResourceReconcilePlan,
} from "./resource-publish.js";
import {
  assertOutboundClean,
  PRODUCTION_HOMESERVER_HOST,
  PRODUCTION_HOMESERVER_PK,
  STAGING_HOMESERVER_HOST,
  STAGING_HOMESERVER_PK,
} from "./outbound-gate.js";
import { PRODUCTION_RESOURCE_PROFILE, STAGING_RESOURCE_PROFILE } from "./resource-target-profile.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import { RESOURCE_ERROR_CODES } from "./resource-error-code.js";

const JEB = PRODUCTION_RESOURCE_PROFILE.publisherPk;
const PILOT = STAGING_RESOURCE_PROFILE.publisherPk;

type MemoryTransport = Transport & { puts: string[]; deletes: string[]; store: Map<string, unknown> };

function memoryTransport(opts: {
  botPk: string;
  resolvedHomeserverPk?: string;
  resolvedHomeserverHost?: string;
}): MemoryTransport {
  const store = new Map<string, unknown>();
  const puts: string[] = [];
  const deletes: string[] = [];
  return {
    botPk: opts.botPk,
    resolvedHomeserverPk: opts.resolvedHomeserverPk,
    resolvedHomeserverHost: opts.resolvedHomeserverHost,
    puts,
    deletes,
    store,
    async putJson(path, json) {
      puts.push(path);
      store.set(path, json);
    },
    async putBytes() {},
    async getJson(path) {
      if (!store.has(path)) throw new Error("404 Not Found");
      return store.get(path);
    },
    async deleteJson(path) {
      deletes.push(path);
      store.delete(path);
    },
    async listPosts() {
      return [];
    },
    async listJsonPaths() {
      return [...store.keys()];
    },
    async reauth() {},
  };
}

function productionTransport(overrides: Partial<Parameters<typeof memoryTransport>[0]> = {}): MemoryTransport {
  return memoryTransport({
    botPk: JEB,
    resolvedHomeserverPk: PRODUCTION_HOMESERVER_PK,
    resolvedHomeserverHost: PRODUCTION_HOMESERVER_HOST,
    ...overrides,
  });
}

function resourceWith(uri: string, labels: string[]): ExternalResource {
  const run = discoverResources(
    [{ family: "url", value: uri, source: "staging-catalog", labels }],
    { limit: 100, configVersion: "test-v1" },
  );
  const accepted = run.accepted[0];
  if (!accepted) throw new Error(`fixture resource was rejected: ${JSON.stringify(run.rejected)}`);
  return accepted;
}

const productionCfg = {
  resourceTarget: "production" as const,
  resourceApp: DEFAULT_RESOURCE_APP,
  resourceConfigVersion: "test-v1",
  expectedPublisherPk: JEB,
};

const productionPublishCfg = { ...productionCfg, resourceMode: "publish" as const };

/** Seeds `store` with one existing desired tag per resource plus stale extras. */
function seed(client: MemoryTransport, resources: readonly ExternalResource[], stale: Record<string, string[]> = {}): void {
  for (const resource of resources) {
    const uri = normalizeUri(resource.canonicalValue);
    for (const label of resource.labels) {
      const built = buildUniversalResourceTag(client.botPk, DEFAULT_RESOURCE_APP, uri, label);
      client.store.set(built.path, built.body);
    }
    for (const label of stale[uri] ?? []) {
      const built = buildUniversalResourceTag(client.botPk, DEFAULT_RESOURCE_APP, uri, label);
      client.store.set(built.path, built.body);
    }
  }
}

describe("production target requires host evidence", () => {
  it("refuses a production publish when the transport cannot say which host it reached", async () => {
    const client = productionTransport({ resolvedHomeserverHost: undefined });
    await expect(
      publishResourceTags([resourceWith("https://example.test/docs", ["release"])], { ...productionPublishCfg, execute: true }, client),
    ).rejects.toThrow(/production requires resolved homeserver host evidence/);
    expect(client.puts).toEqual([]);
  });

  it("refuses a production publish routed at the staging host", async () => {
    const client = productionTransport({ resolvedHomeserverHost: STAGING_HOMESERVER_HOST });
    await expect(
      publishResourceTags([resourceWith("https://example.test/docs", ["release"])], { ...productionPublishCfg, execute: true }, client),
    ).rejects.toThrow(/is not the production homeserver/);
    expect(client.puts).toEqual([]);
  });

  it("refuses a production publish against the staging homeserver key", async () => {
    const client = productionTransport({ resolvedHomeserverPk: STAGING_HOMESERVER_PK });
    await expect(
      publishResourceTags([resourceWith("https://example.test/docs", ["release"])], { ...productionPublishCfg, execute: true }, client),
    ).rejects.toThrow(/homeserver public key is not the production homeserver/);
    expect(client.puts).toEqual([]);
  });

  // Staging keeps its current behaviour: host evidence stays optional there.
  it("still allows a staging run with no host evidence", async () => {
    const client = memoryTransport({ botPk: PILOT, resolvedHomeserverPk: STAGING_HOMESERVER_PK });
    const manifest = await publishResourceTags(
      [resourceWith("https://example.test/docs", ["release"])],
      {
        resourceTarget: "staging",
        resourceMode: "publish",
        resourceApp: DEFAULT_RESOURCE_APP,
        resourceConfigVersion: "test-v1",
        expectedPublisherPk: PILOT,
        execute: true,
      },
      client,
    );
    expect(manifest.written).toBeGreaterThan(0);
  });
});

describe("publish dry run and first production write", () => {
  const resource = resourceWith("https://example.test/docs", ["release"]);

  it("emits a deterministic plan and performs zero PUTs without execute", async () => {
    const client = productionTransport();
    const first = await publishResourceTags([resource], { ...productionPublishCfg, execute: false }, client);
    const second = await publishResourceTags([resource], { ...productionPublishCfg, execute: false }, client);
    expect(first.executed).toBe(false);
    expect(first.plan.items).toHaveLength(1);
    expect(first.planSha256).toBe(second.planSha256);
    expect(client.puts).toEqual([]);
  });

  it("requires a matching confirmation for the first production write", async () => {
    const client = productionTransport();
    const dry = await publishResourceTags([resource], { ...productionPublishCfg, execute: false }, client);
    await expect(
      publishResourceTags([resource], { ...productionPublishCfg, execute: true }, client),
    ).rejects.toThrow(/first production publish requires matching --confirm-plan/);
    await expect(
      publishResourceTags([resource], { ...productionPublishCfg, execute: true, confirmPlan: "wrong" }, client),
    ).rejects.toThrow(/first production publish requires matching --confirm-plan/);
    expect(client.puts).toEqual([]);
    const executed = await publishResourceTags(
      [resource],
      { ...productionPublishCfg, execute: true, confirmPlan: dry.planSha256 },
      client,
    );
    expect(executed.executed).toBe(true);
    expect(executed.written).toBe(1);
    expect(client.puts).toHaveLength(1);
  });

  it("drops the first-write confirmation only once a successful write exists, and still replans", async () => {
    const client = productionTransport();
    const executed = await publishResourceTags(
      [resource],
      { ...productionPublishCfg, execute: true, firstProductionWrite: false },
      client,
    );
    expect(executed.written).toBe(1);
    expect(executed.planSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds the target and the pins into the publish plan hash", () => {
    const plan = {
      items: [
        {
          resourceIdentity: "a".repeat(32),
          normalizedUri: "https://example.test/docs",
          label: "release",
          tagPath: "/pub/jeb.pubky.app/tags/AAA",
          tagId: "AAA",
        },
      ],
      rejected: [],
    };
    const context = {
      resourceTarget: "production" as const,
      resourceApp: DEFAULT_RESOURCE_APP,
      resourceConfigVersion: "test-v1",
      expectedPublisherPk: JEB,
      botPk: JEB,
      resolvedHomeserverPk: PRODUCTION_HOMESERVER_PK,
      resolvedHomeserverHost: PRODUCTION_HOMESERVER_HOST,
    };
    const hash = publishPlanSha256(plan, context);
    expect(publishPlanSha256(plan, { ...context, resourceTarget: "staging" })).not.toBe(hash);
    expect(publishPlanSha256(plan, { ...context, botPk: PILOT })).not.toBe(hash);
    expect(publishPlanSha256(plan, { ...context, resolvedHomeserverHost: STAGING_HOMESERVER_HOST })).not.toBe(hash);
    expect(publishPlanSha256(plan, { ...context, resourceConfigVersion: "other" })).not.toBe(hash);
    expect(publishPlanSha256({ ...plan, items: [] }, context)).not.toBe(hash);
    expect(publishPlanSha256(plan, { ...context })).toBe(hash);
  });
});

describe("every production reconcile is confirmed", () => {
  const resource = resourceWith("https://example.test/docs", ["release"]);

  it("refuses a production retired reconcile with no confirmation and deletes nothing", async () => {
    const client = productionTransport();
    seed(client, [resource], { "https://example.test/docs": ["general-tech"] });
    const cfg = {
      ...productionCfg,
      policy: "retired" as const,
      retired: new Set(["general-tech"]),
      execute: true,
    };
    await expect(reconcileResourceTags([resource], cfg, client)).rejects.toThrow(
      /production retired reconcile requires matching --confirm-plan/,
    );
    await expect(reconcileResourceTags([resource], { ...cfg, confirmPlan: "wrong" }, client)).rejects.toThrow(
      /production retired reconcile requires matching --confirm-plan/,
    );
    expect(client.deletes).toEqual([]);
    const dry = await reconcileResourceTags([resource], { ...cfg, execute: false }, client);
    const done = await reconcileResourceTags([resource], { ...cfg, confirmPlan: dry.planSha256 }, client);
    expect(done.plan.delete).toHaveLength(1);
    expect(client.deletes).toHaveLength(1);
  });

  // Staging behaviour is unchanged: retired needs no confirmation there.
  it("keeps the staging retired reconcile confirmation-free", async () => {
    const client = memoryTransport({ botPk: PILOT, resolvedHomeserverPk: STAGING_HOMESERVER_PK });
    seed(client, [resource], { "https://example.test/docs": ["general-tech"] });
    const done = await reconcileResourceTags(
      [resource],
      {
        resourceTarget: "staging",
        resourceApp: DEFAULT_RESOURCE_APP,
        resourceConfigVersion: "test-v1",
        expectedPublisherPk: PILOT,
        policy: "retired",
        retired: new Set(["general-tech"]),
        execute: true,
      },
      client,
    );
    expect(done.plan.delete).toHaveLength(1);
    expect(client.deletes).toHaveLength(1);
  });
});

describe("production full delete ceilings", () => {
  it("computes min(50, 20% of listed)", () => {
    expect(productionFullDeleteCeiling(0)).toBe(0);
    expect(productionFullDeleteCeiling(10)).toBe(2);
    expect(productionFullDeleteCeiling(250)).toBe(50);
    expect(productionFullDeleteCeiling(1_000)).toBe(50);
  });

  function planOf(rows: Array<{ keep: number; protectedCount: number; del: number; put?: number }>): ResourceReconcilePlan {
    const action = (label: string, path: string) => ({ label, path });
    const resources = rows.map((row, index) => ({
      resource_id: `r${index}`,
      uri: `https://example.test/${index}`,
      keep: Array.from({ length: row.keep }, (_, i) => action(`k${i}`, `/pub/jeb.pubky.app/tags/K${index}${i}`)),
      protected: Array.from({ length: row.protectedCount }, (_, i) => action(`p${i}`, `/pub/jeb.pubky.app/tags/P${index}${i}`)),
      delete: Array.from({ length: row.del }, (_, i) => action(`d${i}`, `/pub/jeb.pubky.app/tags/D${index}${i}`)),
      put: Array.from({ length: row.put ?? 0 }, (_, i) => action(`w${i}`, `/pub/jeb.pubky.app/tags/W${index}${i}`)),
    }));
    const listed = resources.reduce((n, r) => n + r.keep.length + r.protected.length + r.delete.length, 0);
    return {
      resources,
      put: resources.flatMap((r) => r.put),
      delete: resources.flatMap((r) => r.delete),
      listed,
    };
  }

  const noOverrides = { allowMassDelete: false, allowHighDeleteRatio: false };

  it("accepts a plan inside both ceilings", () => {
    const plan = planOf(Array.from({ length: 10 }, () => ({ keep: 4, protectedCount: 0, del: 1 })));
    expect(plan.listed).toBe(50);
    expect(plan.delete).toHaveLength(10);
    expect(productionFullDeleteCeiling(plan.listed)).toBe(10);
    expect(productionFullDeleteViolations(plan, noOverrides)).toEqual([]);
  });

  it("refuses a run above min(50, 20%) and lets the override through", () => {
    const plan = planOf(Array.from({ length: 10 }, () => ({ keep: 1, protectedCount: 0, del: 1 })));
    expect(productionFullDeleteCeiling(plan.listed)).toBe(4);
    expect(productionFullDeleteViolations(plan, noOverrides)).toEqual([
      { kind: "run_ceiling", deletes: 10, ceiling: 4, listed: 20 },
    ]);
    expect(productionFullDeleteViolations(plan, { ...noOverrides, allowMassDelete: true })).toEqual([]);
  });

  it("refuses removing more than half of one resource's labels and lets its own override through", () => {
    const rows = [{ keep: 1, protectedCount: 0, del: 2 }, ...Array.from({ length: 8 }, () => ({ keep: 1, protectedCount: 0, del: 0 }))];
    const plan = planOf(rows);
    expect(plan.listed).toBe(11);
    expect(plan.delete).toHaveLength(2);
    expect(productionFullDeleteCeiling(plan.listed)).toBe(2);
    expect(productionFullDeleteViolations(plan, noOverrides)).toEqual([{ kind: "per_resource_ratio", resourceIds: ["r0"] }]);
    expect(productionFullDeleteViolations(plan, { ...noOverrides, allowHighDeleteRatio: true })).toEqual([]);
    // The mass-delete override is the wrong key for this violation.
    expect(productionFullDeleteViolations(plan, { ...noOverrides, allowMassDelete: true })).toEqual([
      { kind: "per_resource_ratio", resourceIds: ["r0"] },
    ]);
  });

  it("counts protected labels as existing, so half of them cannot be removed", () => {
    const rows = [{ keep: 0, protectedCount: 1, del: 2, put: 1 }, ...Array.from({ length: 8 }, () => ({ keep: 1, protectedCount: 0, del: 0 }))];
    const plan = planOf(rows);
    expect(productionFullDeleteViolations(plan, noOverrides)).toEqual([{ kind: "per_resource_ratio", resourceIds: ["r0"] }]);
  });

  // No override can authorize emptying a resource.
  it("always refuses a resource left with no desired label", () => {
    const plan = planOf([{ keep: 0, protectedCount: 0, del: 2 }, ...Array.from({ length: 9 }, () => ({ keep: 1, protectedCount: 0, del: 0 }))]);
    expect(productionFullDeleteViolations(plan, { allowMassDelete: true, allowHighDeleteRatio: true })).toEqual([
      { kind: "empty_desired_set", resourceIds: ["r0"] },
    ]);
  });

  it("rejects a resource with no labels upstream of the planner", () => {
    const run = discoverResources(
      [{ family: "url", value: "https://example.test/empty", source: "staging-catalog", labels: [] }],
      { limit: 100, configVersion: "test-v1" },
    );
    expect(run.accepted).toEqual([]);
    expect(run.rejected.length).toBe(1);
  });

  it("refuses a production full run over the ceiling end to end and changes the hash under override", async () => {
    const resources = Array.from({ length: 10 }, (_, i) => resourceWith(`https://example.test/docs/${i}`, ["release"]));
    const client = productionTransport();
    for (const resource of resources) {
      seed(client, [resource], { [normalizeUri(resource.canonicalValue)]: ["general-tech"] });
    }
    const cfg = { ...productionCfg, policy: "full" as const, retired: new Set<string>(), execute: false };
    await expect(reconcileResourceTags(resources, cfg, client)).rejects.toThrow(
      /production full reconcile refused: run_ceiling/,
    );
    expect(client.deletes).toEqual([]);
    const overridden = { ...cfg, allowMassDelete: true };
    const dry = await reconcileResourceTags(resources, overridden, client);
    expect(dry.plan.delete).toHaveLength(10);
    const withoutOverride = { ...cfg, allowMassDelete: false };
    // The override flag is bound into the preimage, so the confirmation hash
    // an operator reviewed cannot be replayed without it.
    await expect(
      reconcileResourceTags(resources, { ...withoutOverride, execute: true, confirmPlan: dry.planSha256 }, client),
    ).rejects.toThrow(/production full reconcile refused: run_ceiling/);
    expect(client.deletes).toEqual([]);
    const executed = await reconcileResourceTags(
      resources,
      { ...overridden, execute: true, confirmPlan: dry.planSha256 },
      client,
    );
    expect(executed.plan.delete).toHaveLength(10);
    expect(client.deletes).toHaveLength(10);
  });
});

describe("delete precondition is target-aware", () => {
  const uri = "https://example.test/docs";
  const built = buildUniversalResourceTag(JEB, DEFAULT_RESOURCE_APP, uri, "documentation");
  const base = () => ({
    mode: "reconcile" as const,
    target: "production" as const,
    expectedPublisherPk: JEB,
    botPk: JEB,
    resolvedHomeserverPk: PRODUCTION_HOMESERVER_PK,
    resolvedHomeserverHost: PRODUCTION_HOMESERVER_HOST,
    path: built.path,
    listedPaths: new Set([built.path]),
    approvedDeletes: new Map([[built.path, built.body]]),
    body: built.body,
    resourceIdentity: resourceIdentity(uri),
    acceptedUris: new Map([[resourceIdentity(uri), uri]]),
    desiredByResource: new Map(),
    retiredLabels: new Set(["documentation"]),
    policy: "retired" as const,
    app: DEFAULT_RESOURCE_APP,
  });

  it("passes the production calibration case", () => {
    expect(deletePrecondition(base())).toEqual({ ok: true });
  });

  it("refuses production without host evidence", () => {
    expect(deletePrecondition({ ...base(), resolvedHomeserverHost: undefined })).toEqual({ ok: false, reason: "mode" });
  });

  it("refuses the staging homeserver under the production target", () => {
    expect(deletePrecondition({ ...base(), resolvedHomeserverPk: STAGING_HOMESERVER_PK })).toEqual({
      ok: false,
      reason: "mode",
    });
  });

  it("refuses the pilot identity under the production target", () => {
    expect(deletePrecondition({ ...base(), botPk: PILOT, expectedPublisherPk: PILOT })).toEqual({
      ok: false,
      reason: "mode",
    });
  });

  it("refuses an unknown target", () => {
    expect(deletePrecondition({ ...base(), target: "testnet" as never })).toEqual({ ok: false, reason: "mode" });
  });
});

describe("manifest failures carry a bounded code, not the thrown message", () => {
  const SENTINEL = "https://jeb:sk-live-DO-NOT-LEAK@homeserver.pubky.app/session/abc";

  it("records a code and leaks nothing from a failing PUT", async () => {
    const client = memoryTransport({ botPk: PILOT, resolvedHomeserverPk: STAGING_HOMESERVER_PK });
    client.putJson = async () => {
      throw new Error(SENTINEL);
    };
    const manifest = await publishResourceTags(
      [resourceWith("https://example.test/docs", ["release"])],
      {
        resourceTarget: "staging",
        resourceMode: "publish",
        resourceApp: DEFAULT_RESOURCE_APP,
        resourceConfigVersion: "test-v1",
        expectedPublisherPk: PILOT,
        execute: true,
      },
      client,
    );
    expect(manifest.failed).toBe(1);
    expect(RESOURCE_ERROR_CODES).toContain(manifest.failures[0]?.error);
    expect(manifest.failures[0]?.error).toBe("homeserver_conflict");
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("sk-live");
    expect(serialized).not.toContain("session/abc");
    expect(() => assertOutboundClean(serialized)).not.toThrow();
  });

  it("records a code when the tag cannot even be built", async () => {
    const client = memoryTransport({ botPk: PILOT, resolvedHomeserverPk: STAGING_HOMESERVER_PK });
    const manifest = await publishResourceTags(
      [{ ...resourceWith("https://example.test/docs", ["release"]), labels: ["not a valid label!!"] }],
      {
        resourceTarget: "staging",
        resourceMode: "publish",
        resourceApp: DEFAULT_RESOURCE_APP,
        resourceConfigVersion: "test-v1",
        expectedPublisherPk: PILOT,
        execute: true,
      },
      client,
    );
    expect(manifest.failed).toBe(1);
    expect(RESOURCE_ERROR_CODES).toContain(manifest.failures[0]?.error);
    expect(client.puts).toEqual([]);
  });
});
