import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverResources, type ExternalResource } from "./external-resources.js";
import { RESOURCE_PILOT_BOT_PK, STAGING_HOMESERVER_PK } from "./outbound-gate.js";
import { DEFAULT_RESOURCE_APP } from "./resource-publish.js";
import { buildPublishPlanArtifact, type PlanIdentityInput } from "./resource-planner.js";
import {
  PLAN_ARTIFACT_MAX_AGE_MS,
  assertPlanArtifactFresh,
  assertPlanArtifactLive,
  readPlanArtifact,
  validatePlanArtifact,
  writePlanArtifact,
  type PlanLiveIdentity,
  type ResourcePlanArtifact,
} from "./resource-plan-artifact.js";

const BOT = RESOURCE_PILOT_BOT_PK;

function acceptedOne(): ExternalResource {
  const run = discoverResources(
    [{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }],
    { limit: 100, configVersion: "test-v1" },
  );
  return run.accepted[0]!;
}

function identity(overrides: Partial<PlanIdentityInput> = {}): PlanIdentityInput {
  return {
    family: "discover",
    sourceId: "ab".repeat(32),
    tagger: { id: "rules", model: null },
    configVersion: "test-v1",
    sourceHash: "cd".repeat(32),
    gitHead: "ef".repeat(20),
    app: DEFAULT_RESOURCE_APP,
    publisherPk: BOT,
    homeserverPk: STAGING_HOMESERVER_PK,
    limit: 10,
    fetch: false,
    plannedAt: "2026-09-21T12:00:00.000Z",
    ...overrides,
  };
}

async function validArtifact(): Promise<ResourcePlanArtifact> {
  return buildPublishPlanArtifact([acceptedOne()], identity(), async () => null);
}

function liveOf(artifact: ResourcePlanArtifact, overrides: Partial<PlanLiveIdentity> = {}): PlanLiveIdentity {
  return {
    kind: "publish",
    family: artifact.family,
    configVersion: artifact.configVersion,
    sourceHash: artifact.sourceHash,
    gitHead: artifact.gitHead,
    target: "staging",
    app: artifact.app,
    publisherPk: artifact.publisherPk,
    homeserverPk: artifact.homeserverPk,
    limit: artifact.limit,
    fetch: artifact.fetch,
    tagger: { ...artifact.tagger },
    ...overrides,
  };
}

async function withPlanFile<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "jeb-plan-artifact-"));
  try {
    return await fn(join(directory, "plan.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("plan artifact canonical form", () => {
  it("round-trips: write -> read gives the same sha, equal to the sha256 of the file bytes", async () => {
    const artifact = await validArtifact();
    await withPlanFile(async (path) => {
      const sha = await writePlanArtifact(path, artifact);
      const bytes = await readFile(path);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const loaded = await readPlanArtifact(path);
      expect(loaded.sha256).toBe(sha);
      expect(loaded.artifact).toEqual(artifact);
    });
  });

  it("refuses a file with one changed byte in a label", async () => {
    const artifact = await validArtifact();
    await withPlanFile(async (path) => {
      await writePlanArtifact(path, artifact);
      const original = await readFile(path, "utf8");
      expect(original).toContain('"label":"release"');
      await writeFile(path, original.replace('"label":"release"', '"label":"xelease"'));
      await expect(readPlanArtifact(path)).rejects.toThrow(/does not derive from its body|not in canonical form/);
    });
  });

  it("refuses the same JSON pretty-printed", async () => {
    const artifact = await validArtifact();
    await withPlanFile(async (path) => {
      await writeFile(path, JSON.stringify(artifact, null, 2));
      await expect(readPlanArtifact(path)).rejects.toThrow("not in canonical form");
    });
  });

  it("refuses an unknown top-level key", async () => {
    const artifact = await validArtifact();
    expect(() => validatePlanArtifact({ ...artifact, ledger: { runId: "x" } })).toThrow("unknown field: ledger");
    await withPlanFile(async (path) => {
      await writePlanArtifact(path, { ...artifact, extra: true } as ResourcePlanArtifact);
      await expect(readPlanArtifact(path)).rejects.toThrow("unknown field: extra");
    });
  });

  it("refuses a non-object, a wrong kind, and a wrong version", async () => {
    const artifact = await validArtifact();
    expect(() => validatePlanArtifact(null)).toThrow("not an object");
    expect(() => validatePlanArtifact([artifact])).toThrow("not an object");
    expect(() => validatePlanArtifact({ ...artifact, artifact: "other" })).toThrow("kind is unknown");
    expect(() => validatePlanArtifact({ ...artifact, version: 2 })).toThrow("version is unknown");
    expect(() => validatePlanArtifact({ ...artifact, kind: "reconcile" })).toThrow("mode is unknown");
  });

  it("refuses when resource puts do not sum to the action count", async () => {
    const artifact = await validArtifact();
    const drifted = {
      ...artifact,
      resources: artifact.resources.map((row) => ({ ...row, puts: row.puts + 1 })),
    };
    expect(() => validatePlanArtifact(drifted)).toThrow("resource puts do not match its actions");
  });
});

describe("assertPlanArtifactLive", () => {
  it.each<[Partial<PlanLiveIdentity>, string]>([
    [{ family: "canon" }, "family"],
    [{ configVersion: "other" }, "config_version"],
    [{ sourceHash: "00".repeat(32) }, "source_hash"],
    [{ gitHead: "00".repeat(20) }, "git_head"],
    [{ target: "production" as never }, "target"],
    [{ app: "eventky.app" }, "app"],
    [{ publisherPk: "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo" }, "publisher_pk"],
    [{ homeserverPk: "8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo" }, "homeserver_pk"],
    [{ limit: 11 }, "limit"],
    [{ fetch: true }, "fetch"],
    [{ tagger: { id: "model", model: null } }, "tagger.id"],
    [{ tagger: { id: "rules", model: "gpt-4o-mini" } }, "tagger.model"],
  ])("refuses a mismatch on %s with the field name", async (override, field) => {
    const artifact = await validArtifact();
    expect(() => assertPlanArtifactLive(artifact, liveOf(artifact, override))).toThrow(
      `plan artifact does not match this run: ${field}`,
    );
  });

  it("accepts the exact live identity", async () => {
    const artifact = await validArtifact();
    expect(() => assertPlanArtifactLive(artifact, liveOf(artifact))).not.toThrow();
  });
});

describe("assertPlanArtifactFresh", () => {
  it("refuses a plan dated in the future", async () => {
    const artifact = await validArtifact();
    const now = Date.parse("2026-09-21T12:00:00.000Z");
    expect(() => assertPlanArtifactFresh(artifact, now - 1)).toThrow("dated in the future");
  });

  it("refuses a stale plan", async () => {
    const artifact = await validArtifact();
    const planned = Date.parse(artifact.plannedAt);
    expect(() => assertPlanArtifactFresh(artifact, planned + PLAN_ARTIFACT_MAX_AGE_MS + 1)).toThrow(
      "stale; plan again and re-confirm",
    );
    expect(() => assertPlanArtifactFresh(artifact, planned + PLAN_ARTIFACT_MAX_AGE_MS)).not.toThrow();
  });

  it("refuses an unparseable plannedAt", async () => {
    const artifact = await validArtifact();
    expect(() => assertPlanArtifactFresh({ ...artifact, plannedAt: "not-a-date" }, Date.now())).toThrow(
      "plan artifact does not match this run: planned_at",
    );
  });
});
