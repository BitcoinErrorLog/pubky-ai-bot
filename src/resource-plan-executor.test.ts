import { describe, expect, it } from "vitest";
import { discoverResources, type ExternalResource } from "./external-resources.js";
import type { Transport } from "./homeserver.js";
import { buildUniversalResourceTag } from "./resource-publish.js";
import { buildPublishPlanArtifact, buildReconcilePlanArtifact, type PlanIdentityInput } from "./resource-planner.js";
import { executePlanArtifact } from "./resource-plan-executor.js";
import { RESOURCE_ERROR_CODES } from "./resource-error-code.js";
import { STAGING_HOMESERVER_HOST, STAGING_HOMESERVER_PK } from "./outbound-gate.js";
import { PRODUCTION_HOMESERVER_HOST, PRODUCTION_HOMESERVER_PK, assertOutboundClean } from "./outbound-gate.js";
import { PRODUCTION_RESOURCE_PROFILE, STAGING_RESOURCE_PROFILE } from "./resource-target-profile.js";
import { normalizeUri } from "./resource-identity.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";

const PILOT = STAGING_RESOURCE_PROFILE.publisherPk;
const JEB = PRODUCTION_RESOURCE_PROFILE.publisherPk;

type MemoryTransport = Transport & { puts: string[]; deletes: string[]; store: Map<string, unknown> };

function memoryTransport(opts: { botPk: string; resolvedHomeserverPk?: string; resolvedHomeserverHost?: string }): MemoryTransport {
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

function resourceWith(uri: string, labels: string[]): ExternalResource {
  const run = discoverResources(
    [{ family: "url", value: uri, source: "staging-catalog", labels }],
    { limit: 100, configVersion: "test-v1" },
  );
  const accepted = run.accepted[0];
  if (!accepted) throw new Error(`fixture resource was rejected: ${JSON.stringify(run.rejected)}`);
  return accepted;
}

function identity(overrides: Partial<PlanIdentityInput> = {}): PlanIdentityInput {
  return {
    kind: "publish",
    family: "discover",
    sourceId: "discover:" + "a".repeat(64),
    tagger: { id: "rules", model: null },
    configVersion: RESOURCE_CONFIG_VERSION,
    distHash: "c".repeat(64),
    profile: STAGING_RESOURCE_PROFILE,
    app: "jeb.pubky.app",
    limit: 10,
    fetch: false,
    policy: null,
    retired: new Set<string>(),
    overrides: { allowMassDelete: false, allowHighDeleteRatio: false },
    runId: null,
    reservedUsd: null,
    firstProductionWrite: false,
    plannedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("artifact executor: publish", () => {
  it("writes every PUT action and verifies by readback", async () => {
    const resources = [
      resourceWith("https://example.test/docs", ["release"]),
      resourceWith("https://example.test/other", ["release"]),
    ];
    const artifact = buildPublishPlanArtifact(resources, identity());
    const transport = memoryTransport({ botPk: PILOT, resolvedHomeserverPk: STAGING_HOMESERVER_PK });
    const outcome = await executePlanArtifact(artifact, transport);
    expect(outcome).toMatchObject({ puts: 2, written: 2, skipped: 0, deletes: 0, failed: 0, verified: true });
    expect(transport.puts).toHaveLength(2);
    for (const action of artifact.actions) {
      if (action.kind !== "put") continue;
      expect(transport.store.get(action.path)).toEqual(action.body);
    }
  });

  it("skips an identical existing tag instead of rewriting it", async () => {
    const resource = resourceWith("https://example.test/docs", ["release"]);
    const artifact = buildPublishPlanArtifact([resource], identity());
    const transport = memoryTransport({ botPk: PILOT, resolvedHomeserverPk: STAGING_HOMESERVER_PK });
    const action = artifact.actions[0]!;
    if (action.kind !== "put") throw new Error("expected a put action");
    transport.store.set(action.path, action.body);
    const outcome = await executePlanArtifact(artifact, transport);
    expect(outcome).toMatchObject({ written: 0, skipped: 1, failed: 0, verified: true });
    expect(transport.puts).toEqual([]);
  });

  // verified is only true when every action read back; a readback mismatch
  // is a failed item with a bounded code, never a thrown SDK object.
  it("marks the run unverified when a PUT readback mismatches", async () => {
    const resource = resourceWith("https://example.test/docs", ["release"]);
    const artifact = buildPublishPlanArtifact([resource], identity());
    const transport = memoryTransport({ botPk: PILOT, resolvedHomeserverPk: STAGING_HOMESERVER_PK });
    transport.putJson = async () => {
      // The PUT is accepted but nothing lands: readback must catch it.
    };
    const outcome = await executePlanArtifact(artifact, transport);
    expect(outcome.failed).toBe(1);
    expect(outcome.verified).toBe(false);
    expect(outcome.failures[0]?.error).toBe("readback_failed");
    expect(RESOURCE_ERROR_CODES).toContain(outcome.failures[0]?.error);
    expect(() => assertOutboundClean(JSON.stringify(outcome))).not.toThrow();
  });
});

describe("artifact executor: reconcile deletes", () => {
  async function reconcileFixture(opts: { target?: "staging" | "production" } = {}) {
    const production = opts.target === "production";
    const profile = production ? PRODUCTION_RESOURCE_PROFILE : STAGING_RESOURCE_PROFILE;
    const botPk = profile.publisherPk;
    const transport = memoryTransport(
      production
        ? { botPk, resolvedHomeserverPk: PRODUCTION_HOMESERVER_PK, resolvedHomeserverHost: PRODUCTION_HOMESERVER_HOST }
        : { botPk, resolvedHomeserverPk: STAGING_HOMESERVER_PK, resolvedHomeserverHost: STAGING_HOMESERVER_HOST },
    );
    const resource = resourceWith("https://example.test/docs", ["release"]);
    // Live state: the desired label plus a stale one the plan removes.
    const uri = normalizeUri(resource.canonicalValue);
    for (const label of ["release", "general-tech"]) {
      const built = buildUniversalResourceTag(botPk, "jeb.pubky.app", uri, label);
      transport.store.set(built.path, built.body);
    }
    const artifact = await buildReconcilePlanArtifact(
      [resource],
      identity({ kind: "reconcile", policy: "retired", retired: new Set(["general-tech"]), profile }),
      transport,
    );
    return { artifact, transport };
  }

  it("executes confirmed deletes and verifies each one reads back 404", async () => {
    const { artifact, transport } = await reconcileFixture();
    expect(artifact.ceilings.deletes).toBe(1);
    const outcome = await executePlanArtifact(artifact, transport);
    expect(outcome).toMatchObject({ deletes: 1, failed: 0, verified: true });
    expect(transport.deletes).toHaveLength(1);
    expect([...transport.store.keys()]).toHaveLength(1);
  });

  // Deliberate negative: a DELETE the homeserver claims to accept but leaves
  // in place must stop the run as a readback failure, not count as verified.
  it("refuses to verify when a deleted path is still present", async () => {
    const { artifact, transport } = await reconcileFixture();
    transport.deleteJson = async () => {
      // Accepted but not actually removed.
    };
    await expect(executePlanArtifact(artifact, transport)).rejects.toMatchObject({
      code: "readback_failed",
    });
    const stillThere = await reconcileFixture();
    stillThere.transport.deleteJson = async (path: string) => {
      stillThere.transport.store.set(path, (stillThere.artifact.actions.find((a) => a.kind === "delete" && a.path === path) as { label: string; uri: string } | undefined)
        ? { uri: "https://example.test/docs", label: "general-tech", created_at: 1 }
        : null);
    };
    await expect(executePlanArtifact(stillThere.artifact, stillThere.transport)).rejects.toThrow(/DELETE readback/);
  });

  it("refuses when the live listing drifted from the confirmed plan", async () => {
    const { artifact, transport } = await reconcileFixture();
    const built = buildUniversalResourceTag(PILOT, "jeb.pubky.app", "https://example.test/other", "release");
    transport.store.set(built.path, built.body);
    await expect(executePlanArtifact(artifact, transport)).rejects.toMatchObject({ code: "plan_drift" });
    expect(transport.deletes).toEqual([]);
  });

  it("refuses when a delete target's body changed since planning", async () => {
    const { artifact, transport } = await reconcileFixture();
    const action = artifact.actions.find((a) => a.kind === "delete")!;
    transport.store.set(action.path, { uri: "https://example.test/docs", label: "release", created_at: 1 });
    await expect(executePlanArtifact(artifact, transport)).rejects.toMatchObject({ code: "plan_drift" });
    expect(transport.deletes).toEqual([]);
  });

  // The production host-evidence gate still binds the artifact executor.
  it("keeps production closed when the transport has no host evidence", async () => {
    const { artifact } = await reconcileFixture({ target: "production" });
    const noHost = memoryTransport({ botPk: JEB, resolvedHomeserverPk: PRODUCTION_HOMESERVER_PK });
    await expect(executePlanArtifact(artifact, noHost)).rejects.toThrow(/host evidence/);
    expect(noHost.puts).toEqual([]);
    expect(noHost.deletes).toEqual([]);
  });
});
