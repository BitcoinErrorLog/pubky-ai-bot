import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromProcessEnv } from "./config.js";
import { Store } from "./db.js";
import { STAGING_HOMESERVER_PK } from "./outbound-gate.js";
import { acquireResourceRunLock, runResourcesCli, type ResourcesCliDeps } from "./resources.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { distArtifactHash } from "./dist-artifact-hash.js";
import { readPlanArtifact, writePlanArtifact } from "./resource-plan-artifact.js";
import {
  PRODUCTION_RESOURCE_PROFILE,
  RESOURCE_PIN_SET_VERSION,
  STAGING_RESOURCE_PROFILE,
} from "./resource-target-profile.js";
import type { TaggedResource } from "./resource-tagger.js";

const PILOT = STAGING_RESOURCE_PROFILE.publisherPk;
const ENV_NAMES = [
  "JEB_RESOURCE_TARGET",
  "JEB_RESOURCE_MODE",
  "JEB_RESOURCE_CONFIG_VERSION",
  "JEB_HOMESERVER",
  "JEB_MODEL_API_KEY",
  "JEB_SIGNUP_TOKEN",
  "PUBKY_BOT_SECRET_KEY_HEX",
  "PUBKY_BOT_SECRET_KEY_FILE",
  "PUBKY_BOT_MNEMONIC",
] as const;

async function seedDistTree(root: string): Promise<string> {
  const distRoot = join(root, "dist");
  await mkdir(distRoot, { recursive: true });
  await writeFile(join(distRoot, "main.js"), "console.log('jeb');\n");
  await writeFile(join(distRoot, "resource-taxonomy.js"), `export const RESOURCE_CONFIG_VERSION = "${RESOURCE_CONFIG_VERSION}";\n`);
  return distRoot;
}

async function writeStamp(distRoot: string, gitHead = "test-head"): Promise<string> {
  const buildStampPath = join(distRoot, "build-stamp.json");
  await writeFile(
    buildStampPath,
    JSON.stringify({
      configVersion: RESOURCE_CONFIG_VERSION,
      pinSetVersion: RESOURCE_PIN_SET_VERSION,
      gitHead,
      distHash: await distArtifactHash(distRoot),
    }),
  );
  return buildStampPath;
}

function stagingTransport() {
  const store = new Map<string, unknown>();
  const puts: string[] = [];
  return {
    botPk: PILOT,
    resolvedHomeserverPk: STAGING_HOMESERVER_PK,
    puts,
    store,
    putJson: async (path: string, json: unknown) => {
      puts.push(path);
      store.set(path, json);
    },
    putBytes: async () => {},
    getJson: async (path: string) => {
      if (!store.has(path)) throw Object.assign(new Error("404 Not Found"), { data: { statusCode: 404 } });
      return store.get(path);
    },
    deleteJson: async () => {},
    listPosts: async () => [],
    reauth: async () => {},
  };
}

const noNexus = { nexusVerify: async () => ({ checked: 0, indexed: 0, attempts: 0 }) };

describe("resource planner/executor CLI", () => {
  const saved = new Map<string, string | undefined>();
  let store: Store;
  let directory: string;
  let inputPath: string;
  let planPath: string;
  let buildStampPath: string;
  const baseDeps: ResourcesCliDeps = { gitHead: "test-head" };

  beforeAll(async () => {
    store = new Store(process.env.DATABASE_URL ?? "");
    await store.migrate();
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    for (const name of ENV_NAMES) saved.set(name, process.env[name]);
    for (const name of ENV_NAMES) delete process.env[name];
    await store.pool.query("DELETE FROM resource_plan_consumptions");
    await store.pool.query("DELETE FROM resource_runs");
    await store.pool.query("DELETE FROM resource_spend_day");
    directory = await mkdtemp(join(tmpdir(), "jeb-plan-cli-"));
    inputPath = join(directory, "resources.json");
    planPath = join(directory, "plan.json");
    await writeFile(
      inputPath,
      JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }]),
    );
    const distRoot = await seedDistTree(directory);
    buildStampPath = await writeStamp(distRoot);
    process.env.JEB_RESOURCE_TARGET = "staging";
    process.env.JEB_RESOURCE_MODE = "shadow";
    // No JEB_HOMESERVER: the executor contract forbids it by name on staging
    // too, and the homeserver pin comes from the compiled target profile.
  });

  afterEach(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
    await rm(directory, { recursive: true, force: true });
  });

  function planArgv(): string[] {
    return [
      "node", "main.js", "--role", "resources", "discover", "--input", inputPath,
      "--mode", "plan", "--target", "staging", "--plan-out", planPath,
    ];
  }

  function executeArgv(sha?: string): string[] {
    const argv = [
      "node", "main.js", "--role", "resources", "discover", "--input", inputPath,
      "--mode", "publish", "--target", "staging", "--expected-pk", PILOT, "--plan", planPath,
    ];
    return sha ? [...argv, "--confirm-plan", sha, "--execute"] : argv;
  }

  async function plan(overrides: { argv?: string[]; deps?: ResourcesCliDeps } = {}) {
    const result = await runResourcesCli(
      configFromProcessEnv({ requireSecret: false, role: "resources" }),
      overrides.argv ?? planArgv(),
      { buildStampPath, ...baseDeps, ...overrides.deps },
    );
    expect(result.ok).toBe(true);
    return JSON.parse(result.lines[0]!) as { plan_sha256: string; puts: number };
  }

  // The planner is keyless on every target: a present key source is the refusal.
  it("refuses to plan while any bot key source is present", async () => {
    process.env.PUBKY_BOT_SECRET_KEY_HEX = "00".repeat(32);
    await expect(
      runResourcesCli(configFromProcessEnv({ requireSecret: false, role: "resources" }), planArgv(), { buildStampPath, ...baseDeps }),
    ).rejects.toThrow(/key material must not be present|planner forbids/);
    delete process.env.PUBKY_BOT_SECRET_KEY_HEX;
    process.env.PUBKY_BOT_SECRET_KEY_FILE = "";
    await expect(
      runResourcesCli(configFromProcessEnv({ requireSecret: false, role: "resources" }), planArgv(), { buildStampPath, ...baseDeps }),
    ).rejects.toThrow(/planner forbids: PUBKY_BOT_SECRET_KEY_FILE/);
    delete process.env.PUBKY_BOT_SECRET_KEY_FILE;
    process.env.JEB_SIGNUP_TOKEN = "x";
    await expect(
      runResourcesCli(configFromProcessEnv({ requireSecret: false, role: "resources" }), planArgv(), { buildStampPath, ...baseDeps }),
    ).rejects.toThrow(/planner forbids: JEB_SIGNUP_TOKEN/);
  });

  // The executor holds the identity key and nothing else; a model key in its
  // process means planner and executor credentials leaked into one process.
  it("refuses to execute with a model key present", async () => {
    process.env.JEB_RESOURCE_TARGET = "production";
    process.env.JEB_RESOURCE_CONFIG_VERSION = PRODUCTION_RESOURCE_PROFILE.signedConfigVersion;
    process.env.JEB_HOMESERVER = PRODUCTION_RESOURCE_PROFILE.homeserverPk;
    process.env.PUBKY_BOT_SECRET_KEY_HEX = "11".repeat(32);
    process.env.JEB_MODEL_API_KEY = "sk-test";
    await expect(
      runResourcesCli(configFromProcessEnv({ requireSecret: true, role: "resources" }), [
        "node", "main.js", "--role", "resources", "discover", "--input", inputPath,
        "--mode", "publish", "--target", "production",
        "--expected-pk", PRODUCTION_RESOURCE_PROFILE.publisherPk, "--plan", planPath,
      ], { buildStampPath, ...baseDeps }),
    ).rejects.toThrow(/executor forbids: JEB_MODEL_API_KEY/);
  });

  it("executes a confirmed plan with zero discovery, fetch, or tagger calls", async () => {
    const summary = await plan();
    const onDiscovery = vi.fn(() => {
      throw new Error("discovery ran in the executor");
    });
    const onTagger = vi.fn(() => {
      throw new Error("the tagger ran in the executor");
    });
    const tagResource = vi.fn(() => {
      throw new Error("tagResource ran in the executor");
    });
    const transport = stagingTransport();
    const result = await runResourcesCli(
      configFromProcessEnv({ requireSecret: false, role: "resources" }),
      // A nonexistent input file proves discovery never ran.
      executeArgv(summary.plan_sha256).map((arg) => (arg === inputPath ? join(directory, "absent.json") : arg)),
      { buildStampPath, ...baseDeps, transport, onDiscovery, onTagger, tagResource: tagResource as never, ...noNexus },
    );
    expect(result.ok).toBe(true);
    expect(onDiscovery).not.toHaveBeenCalled();
    expect(onTagger).not.toHaveBeenCalled();
    expect(tagResource).not.toHaveBeenCalled();
    expect(transport.puts.length).toBeGreaterThan(0);
  });

  it("refuses a plan edited after its sha was confirmed", async () => {
    const summary = await plan();
    const { artifact } = await readPlanArtifact(planPath);
    await writePlanArtifact(planPath, { ...artifact, sourceId: "discover:" + "f".repeat(64) });
    await expect(
      runResourcesCli(
        configFromProcessEnv({ requireSecret: false, role: "resources" }),
        executeArgv(summary.plan_sha256),
        { buildStampPath, ...baseDeps, transport: stagingTransport(), ...noNexus },
      ),
    ).rejects.toThrow(/does not match the plan artifact/);
  });

  // Domain binding: byte-identical actions under another family, tagger,
  // config version, or dist build must refuse.
  it("refuses a plan from another family, tagger, or dist with identical actions", async () => {
    await plan();
    const { artifact } = await readPlanArtifact(planPath);
    for (const mutation of [
      { family: "canon" },
      { tagger: { id: "model", model: "kimi-k3" } },
      { distHash: "e".repeat(64) },
      { configVersion: "external-resources-v9-other" },
    ] as const) {
      const edited = { ...artifact, ...mutation } as typeof artifact;
      const sha = await writePlanArtifact(planPath, edited);
      await expect(
        runResourcesCli(
          configFromProcessEnv({ requireSecret: false, role: "resources" }),
          executeArgv(sha),
          { buildStampPath, ...baseDeps, transport: stagingTransport(), ...noNexus },
        ),
      ).rejects.toThrow(/plan artifact does not match this run/);
    }
  });

  it("refuses a config-version env override at execute time", async () => {
    const summary = await plan();
    process.env.JEB_RESOURCE_CONFIG_VERSION = "attacker-chosen-version";
    await expect(
      runResourcesCli(
        configFromProcessEnv({ requireSecret: false, role: "resources" }),
        executeArgv(summary.plan_sha256),
        { buildStampPath, ...baseDeps, transport: stagingTransport(), ...noNexus },
      ),
    ).rejects.toThrow(/plan artifact does not match this run: config_version/);
  });

  it("refuses a stale plan", async () => {
    await plan();
    const { artifact } = await readPlanArtifact(planPath);
    const stale = { ...artifact, plannedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() };
    const sha = await writePlanArtifact(planPath, stale);
    await expect(
      runResourcesCli(
        configFromProcessEnv({ requireSecret: false, role: "resources" }),
        executeArgv(sha),
        { buildStampPath, ...baseDeps, transport: stagingTransport(), ...noNexus },
      ),
    ).rejects.toThrow(/stale/);
  });

  function fakeTagged(usd: number): TaggedResource {
    return {
      url: "https://example.test/docs",
      currentLabels: [],
      labels: ["release"],
      added: ["release"],
      removed: [],
      provenance: { release: "model" },
      denials: {},
      cacheHit: false,
      usage: { tokens: 10, tokensIn: 8, tokensOut: 2, estimated: false, usage_estimated: false, usd },
    };
  }

  // The reservation must exist before the first model call, not after.
  it("reserves against the day row before any model call", async () => {
    let reservedAtTagTime = -1;
    const tagResource = async () => {
      const day = await store.pool.query<{ reserved_usd: string }>(
        "SELECT reserved_usd::text FROM resource_spend_day WHERE target = 'staging'",
      );
      reservedAtTagTime = Number(day.rows[0]?.reserved_usd ?? -1);
      return fakeTagged(0.01);
    };
    await plan({
      argv: [...planArgv(), "--tagger", "model"],
      deps: { pool: store.pool, tagResource: tagResource as never },
    });
    expect(reservedAtTagTime).toBeGreaterThan(0);
  });

  it("meters a cache hit as an explicit zero", async () => {
    const tagResource = async () => ({ ...fakeTagged(0), usage: undefined, cacheHit: true });
    await plan({
      argv: [...planArgv(), "--tagger", "model"],
      deps: { pool: store.pool, tagResource: tagResource as never },
    });
    const day = await store.pool.query<{ actual_usd: string; reserved_usd: string }>(
      "SELECT actual_usd::text, reserved_usd::text FROM resource_spend_day WHERE target = 'staging'",
    );
    expect(Number(day.rows[0]?.actual_usd)).toBe(0);
    expect(Number(day.rows[0]?.reserved_usd)).toBe(0);
  });

  // Deliberate negative: unmeasurable spend is a refusal, never a silent zero.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.5])("refuses to plan with %s metered", async (usd) => {
    const tagResource = async () => fakeTagged(usd);
    await expect(
      plan({
        argv: [...planArgv(), "--tagger", "model"],
        deps: { pool: store.pool, tagResource: tagResource as never },
      }),
    ).rejects.toThrow();
    const rows = await store.pool.query<{ status: string; failure_code: string }>(
      "SELECT status, failure_code FROM resource_runs",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.status).toBe("failed");
    expect(["metering_missing", "spend_cap_exceeded"]).toContain(rows.rows[0]?.failure_code);
  });

  it("meters real model spend into the day row", async () => {
    await plan({
      argv: [...planArgv(), "--tagger", "model"],
      deps: { pool: store.pool, tagResource: (async () => fakeTagged(0.25)) as never },
    });
    const day = await store.pool.query<{ actual_usd: string }>(
      "SELECT actual_usd::text FROM resource_spend_day WHERE target = 'staging'",
    );
    expect(Number(day.rows[0]?.actual_usd)).toBeCloseTo(0.25, 6);
  });

  it("runs a staging retired reconcile end to end through the two-step flow", async () => {
    const { buildUniversalResourceTag } = await import("./resource-publish.js");
    const transport = stagingTransport() as ReturnType<typeof stagingTransport> & {
      deletes: string[];
      listJsonPaths: () => Promise<string[]>;
    };
    const deletes: string[] = [];
    transport.deletes = deletes;
    transport.deleteJson = async (path: string) => {
      deletes.push(path);
      transport.store.delete(path);
    };
    transport.listJsonPaths = async () => [...transport.store.keys()];
    // Live state: one desired tag and one retired stale tag.
    for (const label of ["release", "general-tech"]) {
      const built = buildUniversalResourceTag(PILOT, "jeb.pubky.app", "https://example.test/docs", label);
      transport.store.set(built.path, built.body);
    }
    const planned = await runResourcesCli(
      configFromProcessEnv({ requireSecret: false, role: "resources" }),
      [
        "node", "main.js", "--role", "resources", "discover", "--input", inputPath,
        "--mode", "plan", "--target", "staging", "--plan-out", planPath,
        "--reconcile", "retired", "--retired", "general-tech",
      ],
      { buildStampPath, ...baseDeps, transport },
    );
    expect(planned.ok).toBe(true);
    const summary = JSON.parse(planned.lines[0]!) as { plan_sha256: string; kind: string; deletes: number; listed: number };
    expect(summary.kind).toBe("reconcile");
    expect(summary.deletes).toBe(1);
    expect(summary.listed).toBe(2);
    expect(deletes).toEqual([]);
    const result = await runResourcesCli(
      configFromProcessEnv({ requireSecret: false, role: "resources" }),
      [
        "node", "main.js", "--role", "resources", "discover", "--input", inputPath,
        "--mode", "reconcile", "--target", "staging", "--expected-pk", PILOT,
        "--reconcile", "retired", "--retired", "general-tech",
        "--plan", planPath, "--confirm-plan", summary.plan_sha256, "--execute",
      ],
      { buildStampPath, ...baseDeps, transport, ...noNexus },
    );
    expect(result.ok).toBe(true);
    const payload = JSON.parse(result.lines[0]!);
    expect(payload.mode).toBe("reconcile");
    expect(payload.verified).toBe(true);
    expect(deletes).toHaveLength(1);
    expect([...transport.store.keys()]).toHaveLength(1);
  });

  // Two publishers in one container race the operator-owned file lock; the
  // loser refuses instead of planning or writing concurrently.
  it("refuses a second publisher while the run lock is held", async () => {
    const release = await acquireResourceRunLock();
    try {
      await expect(acquireResourceRunLock()).rejects.toThrow(/lock exists/);
    } finally {
      await release();
    }
    // The lock is free again after release.
    const again = await acquireResourceRunLock();
    await again();
  });
});
