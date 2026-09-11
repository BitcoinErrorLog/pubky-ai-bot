import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromProcessEnv } from "./config.js";
import { Store } from "./db.js";
import { distArtifactHash } from "./dist-artifact-hash.js";
import { PRODUCTION_HOMESERVER_PK } from "./outbound-gate.js";
import { ResourceLedger } from "./resource-ledger.js";
import { readPlanArtifact, writePlanArtifact } from "./resource-plan-artifact.js";
import { ResourceRunSession } from "./resource-run-session.js";
import {
  PRODUCTION_RESOURCE_PROFILE,
  RESOURCE_PIN_SET_VERSION,
  STAGING_RESOURCE_PROFILE,
} from "./resource-target-profile.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { runResourcesCli } from "./resources.js";

const PILOT = STAGING_RESOURCE_PROFILE.publisherPk;
const JEB = PRODUCTION_RESOURCE_PROFILE.publisherPk;

const RESOURCE_ENV = [
  "JEB_RESOURCE_TARGET",
  "JEB_RESOURCE_MODE",
  "JEB_HOMESERVER",
  "JEB_RESOURCE_CONFIG_VERSION",
  "PUBKY_BOT_SECRET_KEY_HEX",
] as const;

async function seedDistTree(directory: string): Promise<string> {
  const distRoot = join(directory, "dist");
  await mkdir(join(distRoot, "nested"), { recursive: true });
  await writeFile(join(distRoot, "main.js"), "export const main = 1;\n");
  await writeFile(join(distRoot, "nested", "worker.js"), "export const worker = 2;\n");
  return distRoot;
}

function stagingTransport() {
  const store = new Map<string, unknown>();
  const puts: string[] = [];
  return {
    botPk: PILOT,
    resolvedHomeserverPk: STAGING_RESOURCE_PROFILE.homeserverPk,
    puts,
    store,
    putJson: async (path: string, json: unknown) => {
      puts.push(path);
      store.set(path, json);
    },
    putBytes: async () => {},
    getJson: async (path: string) => {
      if (store.has(path)) return store.get(path);
      throw Object.assign(new Error("request failed"), { data: { statusCode: 404 } });
    },
    deleteJson: async () => {},
    listPosts: async () => [],
    reauth: async () => {},
  };
}

const noNexus = { nexusVerify: async () => ({ checked: 0, indexed: 0, attempts: 0 }) };

describe("execution gate against Postgres", () => {
  const saved = new Map<string, string | undefined>();
  let store: Store;
  let directory: string;
  let inputPath: string;
  let planPath: string;
  let buildStampPath: string;

  beforeAll(async () => {
    store = new Store(process.env.DATABASE_URL ?? "");
    await store.migrate();
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    for (const name of RESOURCE_ENV) saved.set(name, process.env[name]);
    for (const name of RESOURCE_ENV) delete process.env[name];
    await store.pool.query("DELETE FROM resource_plan_consumptions");
    await store.pool.query("DELETE FROM resource_runs");
    await store.pool.query("DELETE FROM resource_spend_day");
    directory = await mkdtemp(join(tmpdir(), "jeb-exec-gate-"));
    inputPath = join(directory, "resources.json");
    planPath = join(directory, "plan.json");
    await writeFile(
      inputPath,
      JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }]),
    );
    const distRoot = await seedDistTree(directory);
    buildStampPath = join(distRoot, "build-stamp.json");
    await writeFile(
      buildStampPath,
      JSON.stringify({
        configVersion: RESOURCE_CONFIG_VERSION,
        pinSetVersion: RESOURCE_PIN_SET_VERSION,
        gitHead: "test-head",
        distHash: await distArtifactHash(distRoot),
      }),
    );
    process.env.JEB_RESOURCE_TARGET = "staging";
    process.env.JEB_RESOURCE_MODE = "shadow";
  });

  afterEach(async () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  const deps = () => ({ buildStampPath, gitHead: "test-head", pool: store.pool });

  function planArgv(target: "staging" | "production" = "staging"): string[] {
    return [
      "node", "main.js", "--role", "resources", "discover", "--input", inputPath,
      "--mode", "plan", "--target", target, "--plan-out", planPath,
    ];
  }

  function executeArgv(sha: string, target: "staging" | "production" = "staging"): string[] {
    return [
      "node", "main.js", "--role", "resources", "discover", "--input", inputPath,
      "--mode", "publish", "--target", target,
      "--expected-pk", target === "production" ? JEB : PILOT,
      "--plan", planPath, "--confirm-plan", sha, "--execute",
    ];
  }

  async function plan(target: "staging" | "production" = "staging"): Promise<string> {
    const planned = await runResourcesCli(
      configFromProcessEnv({ requireSecret: false, role: "resources" }),
      planArgv(target),
      deps(),
    );
    expect(planned.ok).toBe(true);
    return JSON.parse(planned.lines[0]!).plan_sha256 as string;
  }

  // P1: actual model spend is persisted with every metered step, so a crashed
  // run is counted at max(persisted actual, reservation) against the day cap.
  it("counts an abandoned run at its persisted actual spend, not its reservation", async () => {
    const crashed = await ResourceRunSession.open(
      {
        profile: STAGING_RESOURCE_PROFILE,
        family: "canon",
        publisherPk: PILOT,
        distHash: "c".repeat(64),
        limit: 1,
        caps: { runUsdCap: 2, dailyUsdCap: 5 },
        databaseUrl: process.env.DATABASE_URL ?? "",
        perResourceEstimateUsd: 0.01,
      },
      { pool: store.pool },
    );
    // Reservation is one cent; the run then meters $1.90 across three steps.
    await crashed.recordSpend({ cached: false, usd: 1.0 });
    await crashed.recordSpend({ cached: true });
    await crashed.recordSpend({ cached: false, usd: 0.9 });
    // Every step persisted: the run row already shows the actual spend.
    const mid = await store.pool.query<{ actual_usd: string }>(
      "SELECT actual_usd::text FROM resource_runs WHERE run_id = $1",
      [crashed.runId],
    );
    expect(Number(mid.rows[0]?.actual_usd)).toBeCloseTo(1.9, 6);
    // The "crash": no finish, and the lock connection goes away.
    await (crashed as unknown as { dispose(): Promise<void> }).dispose();
    await store.pool.query(
      "UPDATE resource_runs SET lease_expires_at = now() - interval '1 second' WHERE run_id = $1",
      [crashed.runId],
    );
    // The next invocation reaps it as abandoned; the day must count $1.90.
    const refused = ResourceRunSession.open(
      {
        profile: STAGING_RESOURCE_PROFILE,
        family: "canon",
        publisherPk: PILOT,
        distHash: "c".repeat(64),
        limit: 100,
        caps: { runUsdCap: 4, dailyUsdCap: 5 },
        databaseUrl: process.env.DATABASE_URL ?? "",
        perResourceEstimateUsd: 0.04,
      },
      { pool: store.pool },
    );
    await expect(refused).rejects.toMatchObject({ code: "spend_cap_exceeded" });
    const ledger = new ResourceLedger(store.pool);
    const day = await ledger.spentToday("staging");
    expect(day.actualUsd + day.reservedUsd).toBeGreaterThanOrEqual(1.9);
    const row = await store.pool.query<{ status: string; actual_usd: string }>(
      "SELECT status, actual_usd::text FROM resource_runs WHERE run_id = $1",
      [crashed.runId],
    );
    expect(row.rows[0]?.status).toBe("abandoned");
    expect(Number(row.rows[0]?.actual_usd)).toBeCloseTo(1.9, 6);
  });

  // Settlement is monotonic: a terminal write may never lower the actual a
  // metered step already persisted.
  it("never lets settlement lower a persisted actual", async () => {
    const ledger = new ResourceLedger(store.pool);
    const reservation = await ledger.reserve("staging", 0.5, { runUsdCap: 2, dailyUsdCap: 5 });
    const runId = randomUUID();
    await ledger.startRun({
      runId,
      target: "staging",
      family: "canon",
      configVersion: STAGING_RESOURCE_PROFILE.signedConfigVersion,
      pinSetVersion: STAGING_RESOURCE_PROFILE.pinSetVersion,
      distHash: "a".repeat(64),
      publisherPk: PILOT,
      estimatedUsd: 0.5,
    });
    await ledger.meterStep(reservation, runId, 1.9);
    await ledger.finishRun(runId, {
      status: "failed",
      actualUsd: 0.5,
      accepted: 0, processed: 0, unprocessed: 0, written: 0, skipped: 0,
      failed: 1, puts: 0, deletes: 0, verified: false, failureCode: "model_failed",
    });
    const row = await store.pool.query<{ actual_usd: string }>(
      "SELECT actual_usd::text FROM resource_runs WHERE run_id = $1",
      [runId],
    );
    expect(Number(row.rows[0]?.actual_usd)).toBeCloseTo(1.9, 6);
  });

  // P2 replay: a confirmed plan executes at most once. The second execution
  // of the same file and hash is refused with zero mutation, even for a
  // non-first-write publish plan.
  it("refuses to execute the same confirmed plan twice, with zero mutation on the replay", async () => {
    const sha = await plan();
    const first = stagingTransport();
    const executed = await runResourcesCli(
      configFromProcessEnv({ requireSecret: false, role: "resources" }),
      executeArgv(sha),
      { ...deps(), transport: first, ...noNexus },
    );
    expect(executed.ok).toBe(true);
    expect(first.puts.length).toBeGreaterThan(0);
    const replay = stagingTransport();
    await expect(
      runResourcesCli(
        configFromProcessEnv({ requireSecret: false, role: "resources" }),
        executeArgv(sha),
        { ...deps(), transport: replay, ...noNexus },
      ),
    ).rejects.toThrow(/already consumed/);
    expect(replay.puts).toEqual([]);
    // Exactly one planner row and one executor row: the replay rolled back.
    const rows = await store.pool.query<{ status: string }>("SELECT status FROM resource_runs ORDER BY started_at");
    expect(rows.rows.map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
  });

  // The artifact's runId must reference an existing planner run with a
  // terminal successful status; anything else is drift, refused pre-mutation.
  it("refuses an artifact whose runId is unknown or whose planner run failed", async () => {
    const sha = await plan();
    const { artifact } = await readPlanArtifact(planPath);
    // Unknown planner run.
    const forgedSha = await writePlanArtifact(planPath, { ...artifact, runId: randomUUID() });
    const forged = stagingTransport();
    await expect(
      runResourcesCli(
        configFromProcessEnv({ requireSecret: false, role: "resources" }),
        executeArgv(forgedSha),
        { ...deps(), transport: forged, ...noNexus },
      ),
    ).rejects.toThrow(/unknown planner run/);
    expect(forged.puts).toEqual([]);
    // A real but failed planner run (the original artifact is restored).
    await writePlanArtifact(planPath, artifact);
    await store.pool.query("UPDATE resource_runs SET status = 'failed' WHERE run_id = $1", [artifact.runId]);
    const failedPlanner = stagingTransport();
    await expect(
      runResourcesCli(
        configFromProcessEnv({ requireSecret: false, role: "resources" }),
        executeArgv(sha),
        { ...deps(), transport: failedPlanner, ...noNexus },
      ),
    ).rejects.toThrow(/did not succeed/);
    expect(failedPlanner.puts).toEqual([]);
  });

  // P3 freshness: the one-hour window runs between the two run rows' DB
  // timestamps. A 61-minute-old DB-stamped plan is refused as stale even when
  // the executor's process clock is rolled back two hours.
  it("enforces the plan age window from the database clock, not the executor wall clock", async () => {
    await plan();
    const { artifact, sha256 } = await readPlanArtifact(planPath);
    const aged = await store.pool.query<{ started_at: Date }>(
      `UPDATE resource_runs SET started_at = date_trunc('milliseconds', now() - interval '61 minutes')
       WHERE run_id = $1 RETURNING started_at`,
      [artifact.runId],
    );
    const agedSha = await writePlanArtifact(planPath, {
      ...artifact,
      plannedAt: aged.rows[0]!.started_at.toISOString(),
    });
    expect(agedSha).not.toBe(sha256);
    // A planner that genuinely ran 61 minutes ago would have recorded this
    // artifact's hash on its own row; keep the binding consistent.
    await store.pool.query("UPDATE resource_runs SET plan_sha256 = $2 WHERE run_id = $1", [artifact.runId, agedSha]);
    // The executor's wall clock is two hours slow: a wall-clock check would
    // see this plan as dated in the future, not stale.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow - 2 * 60 * 60 * 1000);
    const transport = stagingTransport();
    await expect(
      runResourcesCli(
        configFromProcessEnv({ requireSecret: false, role: "resources" }),
        executeArgv(agedSha),
        { ...deps(), transport, ...noNexus },
      ),
    ).rejects.toThrow(/stale/);
    expect(transport.puts).toEqual([]);
  });

  // P3 deadlock resolution: a valid production plan with no JEB_HOMESERVER in
  // the environment must fail at the host-evidence gate — the pinned SDK
  // exposes no authenticated endpoint — never at a missing-env check.
  it("refuses production at the host-evidence gate, not for a missing JEB_HOMESERVER", async () => {
    process.env.JEB_RESOURCE_TARGET = "production";
    process.env.JEB_RESOURCE_CONFIG_VERSION = PRODUCTION_RESOURCE_PROFILE.signedConfigVersion;
    const sha = await plan("production");
    expect("JEB_HOMESERVER" in process.env).toBe(false);
    // The executor contract: exactly one key source, no URL override.
    process.env.PUBKY_BOT_SECRET_KEY_HEX = "11".repeat(32);
    const transport = {
      botPk: JEB,
      resolvedHomeserverPk: PRODUCTION_HOMESERVER_PK,
      puts: [] as string[],
      putJson: async (path: string) => {
        transport.puts.push(path);
      },
      putBytes: async () => {},
      getJson: async () => {
        throw Object.assign(new Error("request failed"), { data: { statusCode: 404 } });
      },
      deleteJson: async () => {},
      listPosts: async () => [],
      reauth: async () => {},
    };
    const refusal = await runResourcesCli(
      configFromProcessEnv({ requireSecret: false, role: "resources" }),
      executeArgv(sha, "production"),
      { ...deps(), transport, ...noNexus },
    ).catch((error: unknown) => error);
    expect(String((refusal as Error).message)).toMatch(/host evidence/);
    expect(String((refusal as Error).message)).not.toMatch(/homeserver public key is missing/);
    expect(transport.puts).toEqual([]);
  });

  // P3/P4: the first PUT readback failure stops the batch, and the run row
  // persists the payload's actual failure code.
  it("stops at the first PUT readback failure and persists readback_failed on the run row", async () => {
    await writeFile(
      inputPath,
      JSON.stringify([
        { family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] },
        { family: "url", value: "https://example.test/other", source: "staging-catalog", labels: ["release"] },
      ]),
    );
    const sha = await plan();
    const transport = stagingTransport();
    let corrupted = false;
    let nexusCalls = 0;
    const realPut = transport.putJson;
    transport.putJson = async (path: string, json: unknown) => {
      if (!corrupted) {
        corrupted = true;
        transport.puts.push(path);
        return; // Accepted but nothing lands: the readback fails.
      }
      return realPut(path, json);
    };
    const result = await runResourcesCli(
      configFromProcessEnv({ requireSecret: false, role: "resources" }),
      executeArgv(sha),
      {
        ...deps(),
        transport,
        nexusVerify: async () => {
          nexusCalls += 1;
          return { checked: 0, indexed: 0, attempts: 0 };
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(nexusCalls).toBe(0);
    // The second PUT was never attempted.
    expect(transport.puts).toHaveLength(1);
    const rows = await store.pool.query<{ status: string; failure_code: string | null }>(
      "SELECT status, failure_code FROM resource_runs ORDER BY started_at",
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ status: "succeeded", failure_code: null });
    expect(rows.rows[1]).toMatchObject({ status: "failed", failure_code: "readback_failed" });
  });

  it("gates terminal success on publisher-scoped Nexus verification", async () => {
    const sha = await plan();
    const transport = stagingTransport();
    const result = await runResourcesCli(
      configFromProcessEnv({ requireSecret: false, role: "resources" }),
      executeArgv(sha),
      {
        ...deps(),
        transport,
        nexusVerify: async () => ({
          checked: 1,
          indexed: 0,
          attempts: 1,
          failureCode: "nexus_unavailable",
        }),
      },
    );
    expect(result.ok).toBe(false);
    const payload = JSON.parse(result.lines[0]!);
    expect(payload.verified).toBe(false);
    expect(payload.nexusVerified).toMatchObject({ checked: 1, indexed: 0 });
    const rows = await store.pool.query<{ status: string; verified: boolean; failure_code: string | null }>(
      "SELECT status, verified, failure_code FROM resource_runs ORDER BY started_at",
    );
    expect(rows.rows[1]).toMatchObject({ status: "failed", verified: false, failure_code: "nexus_unavailable" });
  });
});
