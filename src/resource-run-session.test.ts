import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configFromProcessEnv } from "./config.js";
import { Store } from "./db.js";
import { STAGING_HOMESERVER_PK } from "./outbound-gate.js";
import { distArtifactHash } from "./dist-artifact-hash.js";
import { RESOURCE_PIN_SET_VERSION, STAGING_RESOURCE_PROFILE } from "./resource-target-profile.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";
import { ResourceRunSession } from "./resource-run-session.js";
import { acquirePublisherLock } from "./resource-ledger.js";
import { runResourcesCli } from "./resources.js";

const RESOURCE_ENV = ["JEB_RESOURCE_TARGET", "JEB_RESOURCE_MODE", "JEB_HOMESERVER", "JEB_RESOURCE_CONFIG_VERSION"] as const;

async function seedDistTree(directory: string): Promise<string> {
  const distRoot = join(directory, "dist");
  await mkdir(join(distRoot, "nested"), { recursive: true });
  await writeFile(join(distRoot, "main.js"), "export const main = 1;\n");
  await writeFile(join(distRoot, "nested", "worker.js"), "export const worker = 2;\n");
  return distRoot;
}

function stagingTransport(puts: string[]) {
  const stored = new Map<string, unknown>();
  return {
    botPk: STAGING_RESOURCE_PROFILE.publisherPk,
    resolvedHomeserverPk: STAGING_HOMESERVER_PK,
    putJson: async (path: string, json: unknown) => {
      puts.push(path);
      stored.set(path, json);
    },
    putBytes: async () => {},
    getJson: async (path: string) => {
      if (stored.has(path)) return stored.get(path);
      throw new Error("404 Not Found");
    },
    deleteJson: async () => {},
    listPosts: async () => [],
    reauth: async () => {},
  };
}

describe("resource run session", () => {
  const saved = new Map<string, string | undefined>();
  let store: Store;

  beforeAll(async () => {
    store = new Store(process.env.DATABASE_URL ?? "");
    await store.migrate();
  });

  afterAll(async () => {
    await store.close();
  });

  beforeEach(async () => {
    for (const name of RESOURCE_ENV) saved.set(name, process.env[name]);
    await store.pool.query("DELETE FROM resource_runs");
    await store.pool.query("DELETE FROM resource_spend_day");
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  async function openSession(overrides: Partial<Parameters<typeof ResourceRunSession.open>[0]> = {}) {
    return ResourceRunSession.open(
      {
        profile: STAGING_RESOURCE_PROFILE,
        family: "canon",
        publisherPk: STAGING_RESOURCE_PROFILE.publisherPk,
        distHash: "c".repeat(64),
        limit: 10,
        caps: { runUsdCap: 2, dailyUsdCap: 5 },
        databaseUrl: process.env.DATABASE_URL ?? "",
        ...overrides,
      },
      { pool: store.pool },
    );
  }

  it("opens a manifest row, reserves the estimate, and settles actual spend", async () => {
    const session = await openSession();
    const running = await store.pool.query<{ status: string; estimated_usd: string }>(
      "SELECT status, estimated_usd::text FROM resource_runs WHERE run_id = $1",
      [session.runId],
    );
    expect(running.rows[0]?.status).toBe("running");
    // Configured floor 0.01 x limit 10, no history to raise it.
    expect(Number(running.rows[0]?.estimated_usd)).toBeCloseTo(0.1, 6);
    const day = await store.pool.query<{ reserved_usd: string }>(
      "SELECT reserved_usd::text FROM resource_spend_day WHERE target = 'staging'",
    );
    expect(Number(day.rows[0]?.reserved_usd)).toBeCloseTo(0.1, 6);

    session.recordSpend({ cached: false, usd: 0.03 });
    session.recordSpend({ cached: true });
    await session.finish({
      status: "succeeded",
      accepted: 2,
      processed: 2,
      unprocessed: 0,
      written: 2,
      skipped: 0,
      failed: 0,
      puts: 2,
      deletes: 0,
      verified: true,
    });
    const done = await store.pool.query<{ status: string; actual_usd: string }>(
      "SELECT status, actual_usd::text FROM resource_runs WHERE run_id = $1",
      [session.runId],
    );
    expect(done.rows[0]?.status).toBe("succeeded");
    expect(Number(done.rows[0]?.actual_usd)).toBeCloseTo(0.03, 6);
    const settled = await store.pool.query<{ actual_usd: string; reserved_usd: string }>(
      "SELECT actual_usd::text, reserved_usd::text FROM resource_spend_day WHERE target = 'staging'",
    );
    expect(Number(settled.rows[0]?.actual_usd)).toBeCloseTo(0.03, 6);
    expect(Number(settled.rows[0]?.reserved_usd)).toBe(0);
  });

  // Deliberate negative: the loser of an overlap must spend nothing and leave
  // a terminal row saying why.
  it("records overlap_refused and reserves nothing when the publisher lock is held", async () => {
    const held = await acquirePublisherLock(store.pool, STAGING_RESOURCE_PROFILE.publisherPk);
    try {
      await expect(openSession()).rejects.toMatchObject({ code: "overlap_refused" });
    } finally {
      await held.release();
    }
    const rows = await store.pool.query<{ status: string; failure_code: string }>(
      "SELECT status, failure_code FROM resource_runs",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ status: "overlap_refused", failure_code: "overlap_refused" });
    const day = await store.pool.query("SELECT 1 FROM resource_spend_day");
    expect(day.rowCount).toBe(0);
  });

  // Deliberate negative: a run that cannot pay must not open at all.
  it("refuses to open once the day's cap is reserved, and releases the lock", async () => {
    const first = await openSession({ limit: 100, caps: { runUsdCap: 2, dailyUsdCap: 2 } });
    await first.finish({
      status: "succeeded",
      accepted: 0, processed: 0, unprocessed: 0, written: 0, skipped: 0, failed: 0, puts: 0, deletes: 0, verified: true,
    });
    await store.pool.query("UPDATE resource_spend_day SET actual_usd = 2, reserved_usd = 0 WHERE target = 'staging'");
    await expect(openSession({ limit: 100, caps: { runUsdCap: 2, dailyUsdCap: 2 } })).rejects.toMatchObject({
      code: "spend_cap_exceeded",
    });
    // The refused run released the advisory lock on its way out.
    const relocked = await acquirePublisherLock(store.pool, STAGING_RESOURCE_PROFILE.publisherPk);
    await relocked.release();
  });

  // Deliberate negative: the placeholder connection string must never reach a run.
  it("refuses the placeholder database URL", async () => {
    await expect(
      ResourceRunSession.open(
        {
          profile: STAGING_RESOURCE_PROFILE,
          family: "canon",
          publisherPk: STAGING_RESOURCE_PROFILE.publisherPk,
          distHash: "c".repeat(64),
          limit: 10,
          caps: { runUsdCap: 2, dailyUsdCap: 5 },
          databaseUrl: "unused://resources",
        },
        { pool: store.pool },
      ),
    ).rejects.toThrow("require a real DATABASE_URL");
  });

  it("maps a thrown error to a bounded code and never persists its message", async () => {
    const session = await openSession();
    const code = await session.fail(new Error("homeserver said https://user:pass@host/secret"), { accepted: 3 });
    expect(code).toBe("unknown_failure");
    const row = await store.pool.query<{ failure_code: string; status: string; accepted_count: number }>(
      "SELECT failure_code, status, accepted_count FROM resource_runs WHERE run_id = $1",
      [session.runId],
    );
    expect(row.rows[0]).toMatchObject({ failure_code: "unknown_failure", status: "failed", accepted_count: 3 });
    const dump = JSON.stringify(row.rows[0]);
    expect(dump).not.toContain("secret");
    expect(dump).not.toContain("pass");
  });

  it("writes exactly one manifest row for a CLI publish run", async () => {
    const puts: string[] = [];
    const directory = await mkdtemp(join(tmpdir(), "jeb-run-session-"));
    try {
      const path = join(directory, "resources.json");
      await writeFile(path, JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }]));
      const distRoot = await seedDistTree(directory);
      const buildStampPath = join(distRoot, "build-stamp.json");
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
      process.env.JEB_HOMESERVER = STAGING_HOMESERVER_PK;
      const result = await runResourcesCli(
        configFromProcessEnv({ requireSecret: false, role: "resources" }),
        [
          "node", "main.js", "--role", "resources", "discover", "--input", path,
          "--mode", "publish", "--target", "staging", "--expected-pk", STAGING_RESOURCE_PROFILE.publisherPk,
          "--execute",
        ],
        { transport: stagingTransport(puts), buildStampPath, gitHead: "test-head", pool: store.pool },
      );
      expect(result.ok).toBe(true);
      const rows = await store.pool.query<{ status: string; family: string; written_count: number; plan_sha256: string }>(
        "SELECT status, family, written_count, plan_sha256 FROM resource_runs",
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ status: "succeeded", family: "discover" });
      expect(rows.rows[0]?.written_count).toBe(puts.length);
      expect(rows.rows[0]?.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // Deliberate negative: a run that throws mid-flight still closes its row.
  it("closes the manifest row when the CLI run throws", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jeb-run-session-"));
    try {
      const path = join(directory, "resources.json");
      await writeFile(path, JSON.stringify([{ family: "url", value: "https://example.test/docs", source: "staging-catalog", labels: ["release"] }]));
      const distRoot = await seedDistTree(directory);
      const buildStampPath = join(distRoot, "build-stamp.json");
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
      process.env.JEB_HOMESERVER = STAGING_HOMESERVER_PK;
      const transport = { ...stagingTransport([]), botPk: "9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y" };
      await expect(
        runResourcesCli(
          configFromProcessEnv({ requireSecret: false, role: "resources" }),
          [
            "node", "main.js", "--role", "resources", "discover", "--input", path,
            "--mode", "publish", "--target", "staging", "--expected-pk", STAGING_RESOURCE_PROFILE.publisherPk,
            "--execute",
          ],
          { transport, buildStampPath, gitHead: "test-head", pool: store.pool },
        ),
      ).rejects.toThrow();
      const rows = await store.pool.query<{ status: string; failure_code: string }>(
        "SELECT status, failure_code FROM resource_runs",
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.status).toBe("failed");
      expect(rows.rows[0]?.failure_code).toBe("unknown_failure");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
