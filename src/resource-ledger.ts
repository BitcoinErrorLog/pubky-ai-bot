import { createHash } from "node:crypto";
import type pg from "pg";
import { DatabaseMigrator } from "./infrastructure/database/migrator.js";
import { CodedResourceError, type ResourceErrorCode } from "./resource-error-code.js";
import type { ResourceCommandFamily } from "./resource-command-family.js";
import type { ResourceTarget } from "./resource-target-profile.js";

/** Tables migrations 110-112 add, with the columns the runtime actually reads. */
export const RESOURCE_LEDGER_TABLES = {
  resource_spend_day: ["utc_day", "target", "actual_usd", "reserved_usd", "updated_at"],
  resource_runs: [
    "run_id",
    "target",
    "family",
    "config_version",
    "pin_set_version",
    "dist_hash",
    "plan_sha256",
    "publisher_pk",
    "started_at",
    "finished_at",
    "status",
    "estimated_usd",
    "actual_usd",
    "accepted_count",
    "processed_count",
    "unprocessed_count",
    "written_count",
    "skipped_count",
    "failed_count",
    "put_count",
    "delete_count",
    "verified",
    "failure_code",
    "lease_expires_at",
  ],
  resource_plan_consumptions: ["plan_sha256", "planner_run_id", "executor_run_id", "consumed_at"],
} as const satisfies Record<string, readonly string[]>;

export type ResourceRunStatus = "running" | "succeeded" | "failed" | "overlap_refused" | "abandoned";

const UTC_DAY_SQL = "(now() AT TIME ZONE 'utc')::date";

/**
 * The three lease statements. Every lease timestamp comes from the database
 * clock (`now()`), never the application clock: the reaper compares
 * `lease_expires_at` against DB time, so an app-clock timestamp would let a
 * skewed process extend or expire leases the reaper sees differently.
 */
export const RUN_START_SQL = `INSERT INTO resource_runs
   (run_id, target, family, config_version, pin_set_version, dist_hash, plan_sha256, publisher_pk,
    status, started_at, estimated_usd, lease_expires_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', date_trunc('milliseconds', now()), $9, now() + make_interval(secs => $10))
 RETURNING started_at`;

export const RUN_LEASE_RENEW_SQL = `UPDATE resource_runs
 SET lease_expires_at = now() + make_interval(secs => $2)
 WHERE run_id = $1 AND status = 'running'`;

export const REAP_STALE_RUNS_SQL = `UPDATE resource_runs
 SET status = 'abandoned', finished_at = now()
 WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < now()
   AND ($1::text IS NULL OR target = $1)`;

/**
 * One metered step: the run row's persisted actual spend and its lease move
 * together, so a crash can never leave spend that exists only in process
 * memory. `GREATEST` makes the write monotonic — a later statement may never
 * lower a persisted actual.
 */
export const RUN_METER_SQL = `UPDATE resource_runs
 SET lease_expires_at = now() + make_interval(secs => $3),
     actual_usd = GREATEST(actual_usd, $2)
 WHERE run_id = $1 AND status = 'running'`;

const RUN_ACTUAL_FOR_UPDATE_SQL = `SELECT actual_usd FROM resource_runs WHERE run_id = $1 AND status = 'running' FOR UPDATE`;

const DAY_METER_SQL = `UPDATE resource_spend_day
 SET actual_usd = actual_usd + $3,
     reserved_usd = GREATEST(0, reserved_usd - $3),
     updated_at = now()
 WHERE utc_day = $1::date AND target = $2`;

const RUN_RESERVE_SQL = `INSERT INTO resource_spend_day (utc_day, target, actual_usd, reserved_usd)
 VALUES (${UTC_DAY_SQL}, $1, 0, $2)
 ON CONFLICT (utc_day, target) DO UPDATE
 SET reserved_usd = resource_spend_day.reserved_usd + EXCLUDED.reserved_usd, updated_at = now()
 WHERE resource_spend_day.actual_usd + resource_spend_day.reserved_usd + EXCLUDED.reserved_usd <= $3
 RETURNING utc_day::text`;

const PLANNER_RUN_FOR_CONSUME_SQL = `SELECT status, plan_sha256, started_at FROM resource_runs WHERE run_id = $1`;

const PLAN_CONSUME_SQL = `INSERT INTO resource_plan_consumptions (plan_sha256, planner_run_id, executor_run_id)
 VALUES ($1, $2, $3)
 ON CONFLICT (plan_sha256) DO NOTHING`;

/**
 * Read-only readiness. The runtime service must never execute DDL, so it
 * checks that the migration stream is fully applied and that both resource
 * tables carry every column it reads, then exits before any Nexus, model, or
 * key access when either is false.
 */
export async function resourceSchemaReady(
  pool: pg.Pool,
  migrator: Pick<DatabaseMigrator, "allMigrationsApplied"> = new DatabaseMigrator(pool),
): Promise<{ ready: boolean; missing: string[] }> {
  const missing: string[] = [];
  if (!(await migrator.allMigrationsApplied())) missing.push("migrations");
  const names = Object.keys(RESOURCE_LEDGER_TABLES);
  const rows = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [names],
  );
  const present = new Map<string, Set<string>>();
  for (const row of rows.rows) {
    let columns = present.get(row.table_name);
    if (!columns) present.set(row.table_name, (columns = new Set()));
    columns.add(row.column_name);
  }
  for (const [table, columns] of Object.entries(RESOURCE_LEDGER_TABLES)) {
    const found = present.get(table);
    if (!found) {
      missing.push(table);
      continue;
    }
    for (const column of columns) if (!found.has(column)) missing.push(`${table}.${column}`);
  }
  return { ready: missing.length === 0, missing };
}

export async function assertResourceSchemaReady(
  pool: pg.Pool,
  migrator?: Pick<DatabaseMigrator, "allMigrationsApplied">,
): Promise<void> {
  const { ready, missing } = await resourceSchemaReady(pool, migrator);
  if (!ready) {
    throw new CodedResourceError("database_failed", `resource schema is not ready: missing ${missing.join(", ")}`);
  }
}

export const PUBLISHER_LOCK_DOMAIN = "jeb-resource-publisher-lock-v1";

/**
 * Domain-separated so this key space cannot collide with the migration lock or
 * any other advisory lock in the database, and keyed by publisher rather than
 * by target so every future writer to the same tag prefix contends here.
 */
export function publisherLockKey(publisherPk: string): bigint {
  if (!publisherPk.trim()) throw new CodedResourceError("config_refused", "publisher lock key requires a publisher");
  const digest = createHash("sha256").update(`${PUBLISHER_LOCK_DOMAIN}:${publisherPk}`).digest();
  return digest.readBigInt64BE(0);
}

export interface PublisherLock {
  release(): Promise<void>;
}

/**
 * Session-level lock on a dedicated connection: a pooled query could return a
 * different backend for the unlock, and a transaction-level lock would drop at
 * the first commit, long before post-run verification.
 */
export async function acquirePublisherLock(pool: pg.Pool, publisherPk: string): Promise<PublisherLock> {
  const key = publisherLockKey(publisherPk);
  const client = await pool.connect();
  let acquired = false;
  try {
    const held = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [key.toString()]);
    acquired = held.rows[0]?.locked === true;
    if (!acquired) throw new CodedResourceError("overlap_refused", "another resource publisher holds the lock");
    return {
      async release() {
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [key.toString()]);
        } finally {
          client.release();
        }
      },
    };
  } finally {
    if (!acquired) client.release();
  }
}

export interface SpendCaps {
  runUsdCap: number;
  dailyUsdCap: number;
}

/** One metered model or cache step. */
export type MeteredStep = { cached: true } | { cached: false; usd: number };

/**
 * A cache hit costs nothing new and says so explicitly; absent metering is a
 * failure, because treating it as zero is exactly how a run outspends its cap.
 */
export function meteredStepUsd(step: MeteredStep): number {
  if (step.cached) return 0;
  if (typeof step.usd !== "number" || !Number.isFinite(step.usd) || step.usd < 0) {
    throw new CodedResourceError("metering_missing", "model step reported no finite usage cost");
  }
  return step.usd;
}

/** Per-run accumulator checked before each resource is published. */
export class RunSpendMeter {
  #spent = 0;
  readonly #cap: number;

  constructor(runUsdCap: number) {
    if (!Number.isFinite(runUsdCap) || runUsdCap <= 0) {
      throw new CodedResourceError("config_refused", "run USD cap must be a positive finite number");
    }
    this.#cap = runUsdCap;
  }

  get spentUsd(): number {
    return this.#spent;
  }

  get capUsd(): number {
    return this.#cap;
  }

  /** Records one step and refuses the run once the cap is crossed. */
  record(step: MeteredStep): number {
    const next = this.#spent + meteredStepUsd(step);
    if (next > this.#cap) {
      throw new CodedResourceError("spend_cap_exceeded", "run USD cap would be exceeded by this resource");
    }
    this.#spent = next;
    return next;
  }
}

export interface RunEstimateInput {
  perResourceEstimateUsd: number;
  recentAverageUsd: number;
  limit: number;
  runUsdCap: number;
}

/**
 * The greater of the configured per-resource estimate and the observed recent
 * average, times the requested limit, clamped to the run cap: an unusually
 * expensive recent run must raise the reservation, never lower it, and no
 * estimate may reserve more than a single run is allowed to spend.
 */
export function estimateRunUsd(input: RunEstimateInput): number {
  const per = Math.max(
    Number.isFinite(input.perResourceEstimateUsd) ? input.perResourceEstimateUsd : 0,
    Number.isFinite(input.recentAverageUsd) ? input.recentAverageUsd : 0,
  );
  if (per < 0 || input.limit < 0) throw new CodedResourceError("config_refused", "run estimate inputs must be positive");
  return Math.min(per * input.limit, input.runUsdCap);
}

export interface SpendReservation {
  target: ResourceTarget;
  utcDay: string;
  reservedUsd: number;
}

/** Everything the executor must prove about the planner run that minted a confirmed plan. */
export interface PlanConsumption {
  planSha256: string;
  plannerRunId: string;
  /** The artifact's `plannedAt`, which must equal the planner row's DB `started_at`. */
  plannedAt: string;
}

function assertReservableEstimate(estimateUsd: number, caps: SpendCaps): void {
  if (!Number.isFinite(estimateUsd) || estimateUsd < 0) {
    throw new CodedResourceError("config_refused", "run estimate must be a non-negative finite number");
  }
  if (estimateUsd > caps.dailyUsdCap) {
    throw new CodedResourceError("spend_cap_exceeded", "run estimate alone exceeds the daily USD cap");
  }
}

export interface ResourceRunRecord {
  runId: string;
  target: ResourceTarget;
  family: ResourceCommandFamily;
  configVersion: string;
  pinSetVersion: string;
  distHash: string;
  publisherPk: string;
  planSha256?: string;
  estimatedUsd: number;
  /** Milliseconds the `running` row may live without a heartbeat before the reaper closes it as abandoned. */
  leaseMs?: number;
}

/** Default reservation lease: a run silent for longer than this is treated as crashed. */
export const RESOURCE_RUN_LEASE_MS = 15 * 60 * 1000;

export interface ResourceRunOutcome {
  /** `abandoned` is the reaper's transition, never a live run's own outcome. */
  status: Exclude<ResourceRunStatus, "running" | "abandoned">;
  actualUsd: number;
  accepted: number;
  processed: number;
  unprocessed: number;
  written: number;
  skipped: number;
  failed: number;
  puts: number;
  deletes: number;
  verified: boolean;
  failureCode?: ResourceErrorCode;
  planSha256?: string;
}

/**
 * Every method is one short statement. No transaction is ever held across
 * model, Nexus, or homeserver I/O, so a slow external call cannot pin the
 * day row and stall a concurrent family.
 */
export class ResourceLedger {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Check-and-reserve in a single conditional upsert so two runs cannot both
   * read a day under the cap and then both reserve. The fresh-row path is
   * guarded separately because `ON CONFLICT ... WHERE` does not apply to a
   * plain insert.
   */
  async reserve(target: ResourceTarget, estimateUsd: number, caps: SpendCaps): Promise<SpendReservation> {
    assertReservableEstimate(estimateUsd, caps);
    const reserved = await this.pool.query<{ utc_day: string }>(RUN_RESERVE_SQL, [target, estimateUsd, caps.dailyUsdCap]);
    if (reserved.rowCount !== 1) {
      throw new CodedResourceError("spend_cap_exceeded", "daily USD cap would be exceeded by this run");
    }
    return { target, utcDay: String(reserved.rows[0]?.utc_day), reservedUsd: estimateUsd };
  }

  /**
   * Reservation and run-row insert in ONE transaction: there is no window in
   * which reserved dollars exist without a run row the reaper can account
   * for. When the run executes a confirmed plan, the same transaction also
   * binds the artifact to its planner row (terminal successful status,
   * matching plan hash, matching DB timestamp) and consumes the plan hash —
   * a second execution of the same hash rolls back as `plan_consumed` before
   * any mutation.
   */
  async reserveAndStartRun(
    run: ResourceRunRecord,
    estimateUsd: number,
    caps: SpendCaps,
    consume?: PlanConsumption,
  ): Promise<{ reservation: SpendReservation; startedAt: Date }> {
    assertReservableEstimate(estimateUsd, caps);
    const leaseMs = run.leaseMs ?? RESOURCE_RUN_LEASE_MS;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new CodedResourceError("config_refused", "run lease must be a positive finite number of milliseconds");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const reserved = await client.query<{ utc_day: string }>(RUN_RESERVE_SQL, [run.target, estimateUsd, caps.dailyUsdCap]);
      if (reserved.rowCount !== 1) {
        throw new CodedResourceError("spend_cap_exceeded", "daily USD cap would be exceeded by this run");
      }
      const started = await client.query<{ started_at: Date }>(RUN_START_SQL, [
        run.runId,
        run.target,
        run.family,
        run.configVersion,
        run.pinSetVersion,
        run.distHash,
        run.planSha256 ?? null,
        run.publisherPk,
        estimateUsd,
        leaseMs / 1000,
      ]);
      const startedAt = started.rows[0]!.started_at;
      if (consume) {
        const planner = await client.query<{ status: string; plan_sha256: string | null; started_at: Date }>(
          PLANNER_RUN_FOR_CONSUME_SQL,
          [consume.plannerRunId],
        );
        const row = planner.rows[0];
        if (!row) throw new CodedResourceError("plan_drift", "plan artifact references an unknown planner run");
        if (row.status !== "succeeded") {
          throw new CodedResourceError("plan_drift", "plan artifact references a planner run that did not succeed");
        }
        if (row.plan_sha256 !== consume.planSha256) {
          throw new CodedResourceError("plan_drift", "plan artifact hash does not match its planner run");
        }
        if (!(row.started_at instanceof Date) || row.started_at.toISOString() !== consume.plannedAt) {
          throw new CodedResourceError("plan_drift", "plan artifact timestamp does not match its planner run");
        }
        const consumed = await client.query(PLAN_CONSUME_SQL, [consume.planSha256, consume.plannerRunId, run.runId]);
        if (consumed.rowCount !== 1) {
          throw new CodedResourceError("plan_consumed", "plan artifact was already consumed by an earlier execution");
        }
      }
      await client.query("COMMIT");
      return {
        reservation: { target: run.target, utcDay: String(reserved.rows[0]?.utc_day), reservedUsd: estimateUsd },
        startedAt,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * One metered step: persists the run's cumulative actual spend to its row
   * in the same statement that renews the lease, and moves the newly spent
   * delta from reservation to actual on the day row — one short transaction,
   * so a crash at any later point leaves the daily ledger at least as
   * conservative as what the model actually consumed. Because actual spend is
   * transferred step by step, an `abandoned` or `running` row is always
   * counted at max(persisted actual, its remaining reservation): the
   * transferred part sits in `actual_usd`, the unspent part in `reserved_usd`.
   */
  async meterStep(
    reservation: SpendReservation,
    runId: string,
    cumulativeUsd: number,
    leaseMs: number = RESOURCE_RUN_LEASE_MS,
  ): Promise<void> {
    if (!Number.isFinite(cumulativeUsd) || cumulativeUsd < 0) {
      throw new CodedResourceError("metering_missing", "metered spend must be a non-negative finite number");
    }
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new CodedResourceError("config_refused", "run lease must be a positive finite number of milliseconds");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ actual_usd: string }>(RUN_ACTUAL_FOR_UPDATE_SQL, [runId]);
      if (current.rowCount !== 1) {
        throw new CodedResourceError("database_failed", "running resource manifest was not found during lease renewal");
      }
      const persisted = Number(current.rows[0]!.actual_usd);
      const delta = Math.max(0, cumulativeUsd - persisted);
      await client.query(RUN_METER_SQL, [runId, cumulativeUsd, leaseMs / 1000]);
      if (delta > 0) {
        const day = await client.query(DAY_METER_SQL, [reservation.utcDay, reservation.target, delta]);
        if (day.rowCount !== 1) {
          throw new CodedResourceError("database_failed", "reserved spend-day row was not found during metering");
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Moves spend from reservation to actual; the release is clamped at zero. */
  async settle(reservation: SpendReservation, actualUsd: number, releaseUsd: number): Promise<void> {
    if (!Number.isFinite(actualUsd) || actualUsd < 0) {
      throw new CodedResourceError("metering_missing", "settled spend must be a non-negative finite number");
    }
    const result = await this.pool.query(
      `UPDATE resource_spend_day
       SET actual_usd = actual_usd + $3,
           reserved_usd = GREATEST(0, reserved_usd - $4),
           updated_at = now()
       WHERE utc_day = $1::date AND target = $2`,
      [reservation.utcDay, reservation.target, actualUsd, Math.max(0, releaseUsd)],
    );
    if (result.rowCount !== 1) {
      throw new CodedResourceError("database_failed", "reserved spend-day row was not found during settlement");
    }
  }

  /** Terminal path for a run that spent less than it reserved. */
  async releaseReservation(reservation: SpendReservation, remainingUsd: number): Promise<void> {
    if (remainingUsd <= 0) return;
    await this.settle(reservation, 0, remainingUsd);
  }

  async spentToday(target: ResourceTarget): Promise<{ actualUsd: number; reservedUsd: number }> {
    const row = await this.pool.query<{ actual_usd: string; reserved_usd: string }>(
      `SELECT actual_usd::text, reserved_usd::text FROM resource_spend_day
       WHERE utc_day = ${UTC_DAY_SQL} AND target = $1`,
      [target],
    );
    return {
      actualUsd: Number(row.rows[0]?.actual_usd ?? 0),
      reservedUsd: Number(row.rows[0]?.reserved_usd ?? 0),
    };
  }

  /** Bounded sample: only recent finished runs of the same family count. */
  async recentAverageUsd(
    target: ResourceTarget,
    family: ResourceCommandFamily,
    sampleSize = 10,
  ): Promise<number> {
    const rows = await this.pool.query<{ per_resource: string }>(
      `SELECT (actual_usd / processed_count)::text AS per_resource
       FROM resource_runs
       WHERE target = $1 AND family = $2 AND status = 'succeeded' AND processed_count > 0
       ORDER BY started_at DESC
       LIMIT $3`,
      [target, family, sampleSize],
    );
    if (rows.rows.length === 0) return 0;
    const total = rows.rows.reduce((sum, row) => sum + Number(row.per_resource), 0);
    return total / rows.rows.length;
  }

  async startRun(run: ResourceRunRecord): Promise<Date> {
    const leaseMs = run.leaseMs ?? RESOURCE_RUN_LEASE_MS;
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new CodedResourceError("config_refused", "run lease must be a positive finite number of milliseconds");
    }
    const started = await this.pool.query<{ started_at: Date }>(RUN_START_SQL, [
      run.runId,
      run.target,
      run.family,
      run.configVersion,
      run.pinSetVersion,
      run.distHash,
      run.planSha256 ?? null,
      run.publisherPk,
      run.estimatedUsd,
      leaseMs / 1000,
    ]);
    return started.rows[0]!.started_at;
  }

  /**
   * Heartbeat: extends the lease of a live `running` row. A row that cannot
   * be renewed no longer exists as `running` — it was finished or reaped —
   * and continuing would write against a manifest nobody can settle.
   */
  async renewLease(runId: string, leaseMs: number = RESOURCE_RUN_LEASE_MS): Promise<void> {
    const result = await this.pool.query(RUN_LEASE_RENEW_SQL, [runId, leaseMs / 1000]);
    if (result.rowCount !== 1) {
      throw new CodedResourceError("database_failed", "running resource manifest was not found during lease renewal");
    }
  }

  /**
   * Crash reaper. A `running` row whose lease expired belongs to a process
   * that can no longer heartbeat, so it is closed as `abandoned` and can
   * never be silently reused: `finishRun` and `renewLease` both require the
   * `running` status. Its day-row reservation is deliberately NOT released —
   * freeing reserved dollars without terminal-manifest proof is how a crashed
   * run outspends the daily cap. Returns the number of reaped rows.
   */
  async reapStaleRuns(target?: ResourceTarget): Promise<number> {
    const result = await this.pool.query(REAP_STALE_RUNS_SQL, [target ?? null]);
    return result.rowCount ?? 0;
  }

  /** True once a successful run with writes exists for this target; feeds the first-production-write gate. */
  async hasSuccessfulWriteRun(target: ResourceTarget): Promise<boolean> {
    const rows = await this.pool.query(
      `SELECT 1 FROM resource_runs
       WHERE target = $1 AND status = 'succeeded' AND (written_count > 0 OR put_count > 0)
       LIMIT 1`,
      [target],
    );
    return rows.rows.length > 0;
  }

  /**
   * Records the terminal state of a run before the process exits. Settlement
   * never lowers a persisted actual: per-step metering may already have
   * recorded more than the terminal accumulator reports (e.g. a fail path
   * that never re-metered), and the higher persisted value is the truth.
   */
  async finishRun(runId: string, outcome: ResourceRunOutcome): Promise<void> {
    const result = await this.pool.query(
      `UPDATE resource_runs
       SET status = $2, finished_at = now(), actual_usd = GREATEST(actual_usd, $3), accepted_count = $4, processed_count = $5,
           unprocessed_count = $6, written_count = $7, skipped_count = $8, failed_count = $9,
           put_count = $10, delete_count = $11, verified = $12, failure_code = $13,
           plan_sha256 = COALESCE($14, plan_sha256)
       WHERE run_id = $1 AND status = 'running'`,
      [
        runId,
        outcome.status,
        outcome.actualUsd,
        outcome.accepted,
        outcome.processed,
        outcome.unprocessed,
        outcome.written,
        outcome.skipped,
        outcome.failed,
        outcome.puts,
        outcome.deletes,
        outcome.verified,
        outcome.failureCode ?? null,
        outcome.planSha256 ?? null,
      ],
    );
    if (result.rowCount !== 1) {
      throw new CodedResourceError("database_failed", "running resource manifest was not found during settlement");
    }
  }

  /** Refused before any model or homeserver work, so the row is terminal at insert. */
  async recordOverlapRefused(run: ResourceRunRecord): Promise<void> {
    await this.startRun({ ...run, estimatedUsd: 0 });
    await this.finishRun(run.runId, {
      status: "overlap_refused",
      actualUsd: 0,
      accepted: 0,
      processed: 0,
      unprocessed: 0,
      written: 0,
      skipped: 0,
      failed: 0,
      puts: 0,
      deletes: 0,
      verified: false,
      failureCode: "overlap_refused",
    });
  }
}
