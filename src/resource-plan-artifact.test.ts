import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverResources, type ExternalResource } from "./external-resources.js";
import {
  PLAN_ARTIFACT_MAX_AGE_MS,
  artifactDeleteCeilingViolations,
  assertArtifactDeleteCeilings,
  assertPlanArtifactFresh,
  assertPlanArtifactLive,
  canonicalJson,
  planArtifactSha256,
  readPlanArtifact,
  validatePlanArtifact,
  writePlanArtifact,
  type PlanLiveIdentity,
  type ResourcePlanArtifact,
} from "./resource-plan-artifact.js";
import { buildPublishPlanArtifact, type PlanIdentityInput } from "./resource-planner.js";
import { CodedResourceError } from "./resource-error-code.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { PRODUCTION_RESOURCE_PROFILE, RESOURCE_PIN_SET_VERSION, STAGING_RESOURCE_PROFILE } from "./resource-target-profile.js";

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
    ...overrides,
  };
}

function liveFor(artifact: ResourcePlanArtifact, overrides: Partial<PlanLiveIdentity> = {}): PlanLiveIdentity {
  return {
    kind: artifact.kind,
    family: artifact.family,
    configVersion: artifact.configVersion,
    pinSetVersion: artifact.pinSetVersion,
    distHash: artifact.distHash,
    target: artifact.target,
    app: artifact.app,
    publisherPk: artifact.publisherPk,
    homeserverPk: artifact.homeserverPk,
    limit: artifact.limit,
    fetch: artifact.fetch,
    policy: artifact.policy,
    retired: artifact.retired,
    allowMassDelete: artifact.allowMassDelete,
    allowHighDeleteRatio: artifact.allowHighDeleteRatio,
    tagger: artifact.tagger,
    ...overrides,
  };
}

function sampleArtifact(overrides: Partial<PlanIdentityInput> = {}): ResourcePlanArtifact {
  return buildPublishPlanArtifact([resourceWith("https://example.test/docs", ["release"])], identity(overrides));
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function artifactFile(artifact: ResourcePlanArtifact): Promise<{ path: string; sha256: string }> {
  const dir = await mkdtemp(join(tmpdir(), "jeb-plan-artifact-"));
  dirs.push(dir);
  const path = join(dir, "plan.json");
  const sha256 = await writePlanArtifact(path, artifact);
  return { path, sha256 };
}

describe("canonical plan artifact", () => {
  it("is deterministic: canonical bytes and sha256 are stable for one plan", () => {
    const first = sampleArtifact({ plannedAt: "2026-09-10T00:00:00.000Z" });
    expect(planArtifactSha256(first)).toMatch(/^[0-9a-f]{64}$/);
    // Re-serializing the parsed artifact reproduces the identical hash.
    const reparsed = JSON.parse(canonicalJson(first)) as ResourcePlanArtifact;
    expect(planArtifactSha256(reparsed)).toBe(planArtifactSha256(first));
    // Canonicalization is key-order independent at every depth.
    const shuffleKeys = (value: unknown): unknown => {
      if (value === null || typeof value !== "object") return value;
      if (Array.isArray(value)) return value.map(shuffleKeys);
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse().map(([k, v]) => [k, shuffleKeys(v)]));
    };
    expect(canonicalJson(shuffleKeys(first))).toBe(canonicalJson(first));
  });

  it("contains full PUT bodies and the identity fields the executor verifies", () => {
    const artifact = sampleArtifact({ runId: "8a4e4b0a-0000-4000-8000-000000000000", reservedUsd: 0.1 });
    expect(artifact.actions).toHaveLength(1);
    const action = artifact.actions[0]!;
    expect(action.kind).toBe("put");
    if (action.kind === "put") {
      expect(action.path).toMatch(/^\/pub\/jeb\.pubky\.app\/tags\//);
      expect(action.body.uri).toBe("https://example.test/docs");
      expect(action.body.label).toBe("release");
      expect(typeof action.body.created_at).toBe("number");
    }
    expect(artifact.runId).toBe("8a4e4b0a-0000-4000-8000-000000000000");
    expect(artifact.reservedUsd).toBe(0.1);
    expect(artifact.pinSetVersion).toBe(RESOURCE_PIN_SET_VERSION);
  });

  it("round-trips through write and read with the printed sha256", async () => {
    const artifact = sampleArtifact();
    const { path, sha256 } = await artifactFile(artifact);
    expect(sha256).toBe(planArtifactSha256(artifact));
    const loaded = await readPlanArtifact(path);
    expect(loaded.sha256).toBe(sha256);
    expect(loaded.artifact).toEqual(artifact);
  });

  // Deliberate negative: an edited plan must never validate against the
  // confirmed hash, however the edit is dressed up.
  it("refuses a file edited after the sha was confirmed", async () => {
    const artifact = sampleArtifact();
    const { path, sha256 } = await artifactFile(artifact);
    // Semantic edit: the recomputed sha no longer equals the confirmed one.
    const edited = sampleArtifact({ sourceId: "discover:" + "b".repeat(64) });
    await writePlanArtifact(path, edited);
    const loaded = await readPlanArtifact(path);
    expect(loaded.sha256).not.toBe(sha256);
    // Cosmetic edit: re-keyed JSON with identical content is not canonical.
    const dir = await mkdtemp(join(tmpdir(), "jeb-plan-artifact-"));
    dirs.push(dir);
    const cosmetic = join(dir, "cosmetic.json");
    await writeFile(cosmetic, JSON.stringify(artifact, null, 2));
    await expect(readPlanArtifact(cosmetic)).rejects.toThrow(/not in canonical form/);
    // Truncated/garbage files refuse with a bounded code.
    const garbage = join(dir, "garbage.json");
    await writeFile(garbage, "{not json");
    await expect(readPlanArtifact(garbage)).rejects.toMatchObject({ code: "plan_drift" });
  });

  it("refuses an artifact whose counts do not match its actions", () => {
    const artifact = sampleArtifact();
    const tampered = { ...artifact, ceilings: { ...artifact.ceilings, puts: 99 } };
    expect(() => validatePlanArtifact(tampered)).toThrow(/action counts/);
    expect(() => validatePlanArtifact({ artifact: "other" })).toThrow(CodedResourceError);
  });
});

describe("executor identity verification is domain-bound", () => {
  it("accepts the live identity the plan was written for", () => {
    const artifact = sampleArtifact();
    expect(() => assertPlanArtifactLive(artifact, liveFor(artifact))).not.toThrow();
  });

  // A plan from another family, tagger, config version, or dist build with
  // byte-identical actions MUST refuse: the confirmed hash only ever commits
  // to one exact context.
  it.each<[string, (live: PlanLiveIdentity) => PlanLiveIdentity]>([
    ["family", (live) => ({ ...live, family: "canon" })],
    ["tagger", (live) => ({ ...live, tagger: { id: "model", model: "kimi-k3" } })],
    ["config version", (live) => ({ ...live, configVersion: "external-resources-v9-other" })],
    ["dist hash", (live) => ({ ...live, distHash: "d".repeat(64) })],
    ["target", (live) => ({ ...live, target: "production", publisherPk: PRODUCTION_RESOURCE_PROFILE.publisherPk })],
    ["publisher", (live) => ({ ...live, publisherPk: PRODUCTION_RESOURCE_PROFILE.publisherPk })],
    ["homeserver pin", (live) => ({ ...live, homeserverPk: PRODUCTION_RESOURCE_PROFILE.homeserverPk })],
    ["pin set", (live) => ({ ...live, pinSetVersion: "resource-pins-v0" })],
    ["limit", (live) => ({ ...live, limit: 11 })],
    ["fetch flag", (live) => ({ ...live, fetch: true })],
    ["mass-delete override", (live) => ({ ...live, allowMassDelete: true })],
    ["first-write state", (live) => ({ ...live, firstProductionWrite: true })],
  ])("refuses a plan from another %s with identical actions", (_label, mutate) => {
    const artifact = sampleArtifact();
    const live = mutate(liveFor(artifact));
    expect(() => assertPlanArtifactLive(artifact, live)).toThrow(/plan artifact does not match this run/);
  });

  it("refuses a stale plan and a plan dated in the future, with no skew tolerance", () => {
    const artifact = sampleArtifact();
    const plannedMs = Date.parse(artifact.plannedAt);
    expect(() => assertPlanArtifactFresh(artifact, plannedMs + PLAN_ARTIFACT_MAX_AGE_MS + 1)).toThrow(/stale/);
    // The wall-clock future tolerance is gone: one millisecond ahead is forged.
    expect(() => assertPlanArtifactFresh(artifact, plannedMs - 1)).toThrow(/future/);
    expect(() => assertPlanArtifactFresh(artifact, plannedMs - PLAN_ARTIFACT_MAX_AGE_MS)).toThrow(/future/);
    // Exactly at the age bound the plan is still live.
    expect(() => assertPlanArtifactFresh(artifact, plannedMs + PLAN_ARTIFACT_MAX_AGE_MS)).not.toThrow();
  });
});

describe("delete ceilings are re-checked from the artifact", () => {
  function reconcileArtifact(rows: Array<{ keep: number; protectedCount: number; del: number; put?: number }>, overrides: { allowMassDelete?: boolean; allowHighDeleteRatio?: boolean } = {}): ResourcePlanArtifact {
    const resources = rows.map((row, index) => ({
      resourceId: `r${index}`,
      keep: Array.from({ length: row.keep }, (_, i) => `k${i}`),
      protected: Array.from({ length: row.protectedCount }, (_, i) => `p${i}`),
      puts: row.put ?? 0,
      deletes: row.del,
    }));
    const deletes = resources.reduce((n, r) => n + r.deletes, 0);
    const listed = resources.reduce((n, r) => n + r.keep.length + r.protected.length + r.deletes, 0);
    const artifact = sampleArtifact({
      kind: "reconcile",
      policy: "full",
      profile: PRODUCTION_RESOURCE_PROFILE,
      overrides: { allowMassDelete: overrides.allowMassDelete === true, allowHighDeleteRatio: overrides.allowHighDeleteRatio === true },
    });
    return {
      ...artifact,
      kind: "reconcile",
      policy: "full",
      listed,
      listedDigest: "e".repeat(64),
      resources,
      actions: resources.flatMap((r) =>
        Array.from({ length: r.deletes }, (_, i) => ({ kind: "delete" as const, path: `/pub/jeb.pubky.app/tags/D${r.resourceId}${i}`, label: `d${i}`, uri: "https://example.test/x" })),
      ),
      ceilings: { deleteCeiling: Math.min(50, Math.floor(0.2 * listed)), perResourceDeleteRatio: 0.5, puts: 0, deletes, violations: [] },
    };
  }

  it("passes exactly at min(50, 20% of listed) and refuses one over", () => {
    // 245 listed -> ceiling 49.
    const atCeiling = reconcileArtifact(Array.from({ length: 49 }, () => ({ keep: 4, protectedCount: 0, del: 1 })));
    expect(atCeiling.listed).toBe(245);
    expect(artifactDeleteCeilingViolations(atCeiling)).toEqual([]);
    expect(() => assertArtifactDeleteCeilings(atCeiling)).not.toThrow();
    const oneOver = reconcileArtifact(Array.from({ length: 50 }, () => ({ keep: 4, protectedCount: 0, del: 1 })));
    // 250 listed -> ceiling 50, so 50 is still inside; 51 is over.
    expect(artifactDeleteCeilingViolations(oneOver)).toEqual([]);
    const overRows = [
      ...Array.from({ length: 48 }, () => ({ keep: 4, protectedCount: 0, del: 1 })),
      { keep: 3, protectedCount: 0, del: 2 },
    ];
    const over = reconcileArtifact(overRows);
    expect(over.listed).toBe(245);
    expect(over.ceilings.deletes).toBe(50);
    expect(artifactDeleteCeilingViolations(over)).toEqual(["run_ceiling"]);
    expect(() => assertArtifactDeleteCeilings(over)).toThrow(/production full reconcile refused: run_ceiling/);
    // The hash-bound override admits exactly the reviewed plan.
    const overridden = reconcileArtifact(overRows, { allowMassDelete: true });
    expect(artifactDeleteCeilingViolations(overridden)).toEqual([]);
  });

  it("passes exactly at 50% of one resource's labels and refuses one over", () => {
    const atRatio = reconcileArtifact([
      { keep: 1, protectedCount: 0, del: 1 },
      ...Array.from({ length: 8 }, () => ({ keep: 1, protectedCount: 0, del: 0 })),
    ]);
    expect(artifactDeleteCeilingViolations(atRatio)).toEqual([]);
    const overRatio = reconcileArtifact([
      { keep: 1, protectedCount: 0, del: 2 },
      ...Array.from({ length: 8 }, () => ({ keep: 1, protectedCount: 0, del: 0 })),
    ]);
    expect(artifactDeleteCeilingViolations(overRatio)).toEqual(["per_resource_ratio"]);
    const overridden = reconcileArtifact(
      [{ keep: 1, protectedCount: 0, del: 2 }, ...Array.from({ length: 8 }, () => ({ keep: 1, protectedCount: 0, del: 0 }))],
      { allowHighDeleteRatio: true },
    );
    expect(artifactDeleteCeilingViolations(overridden)).toEqual([]);
  });

  it("never lets an override empty a resource's desired set", () => {
    const empty = reconcileArtifact(
      [{ keep: 0, protectedCount: 0, del: 2 }, ...Array.from({ length: 9 }, () => ({ keep: 1, protectedCount: 0, del: 0 }))],
      { allowMassDelete: true, allowHighDeleteRatio: true },
    );
    expect(artifactDeleteCeilingViolations(empty)).toEqual(["empty_desired_set"]);
    expect(() => assertArtifactDeleteCeilings(empty)).toThrow(/empty_desired_set/);
  });

  it("refuses to execute a plan that recorded violations at plan time", () => {
    const artifact = sampleArtifact();
    const recorded: ResourcePlanArtifact = {
      ...artifact,
      ceilings: { ...artifact.ceilings, violations: ["run_ceiling"] },
    };
    expect(() => assertArtifactDeleteCeilings(recorded)).toThrow(/recorded ceiling violations/);
  });

  // The executor-facing refusal is a bounded code, never an uncoded Error
  // that would persist as unknown_failure.
  it("throws a coded plan_drift error when the recomputed ceilings fail", () => {
    const over = reconcileArtifact([
      ...Array.from({ length: 48 }, () => ({ keep: 4, protectedCount: 0, del: 1 })),
      { keep: 3, protectedCount: 0, del: 2 },
    ]);
    expect(() => assertArtifactDeleteCeilings(over)).toThrow(CodedResourceError);
    expect(() => assertArtifactDeleteCeilings(over)).toThrow(/production full reconcile refused: run_ceiling/);
  });
});
