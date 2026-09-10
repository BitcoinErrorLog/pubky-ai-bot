import { randomUUID } from "node:crypto";
import pg from "pg";
import { CodedResourceError, resourceErrorCode, type ResourceErrorCode } from "./resource-error-code.js";
import type { ResourceCommandFamily } from "./resource-command-family.js";
import {
  ResourceLedger,
  RunSpendMeter,
  acquirePublisherLock,
  assertResourceSchemaReady,
  estimateRunUsd,
  type PublisherLock,
  type ResourceRunOutcome,
  type SpendCaps,
  type SpendReservation,
} from "./resource-ledger.js";
import type { ResourceTargetProfile } from "./resource-target-profile.js";

/** Configured per-resource estimate floor, in USD, before observed history. */
export const PER_RESOURCE_ESTIMATE_USD = 0.01;

export interface RunSessionOptions {
  profile: ResourceTargetProfile;
  family: ResourceCommandFamily;
  publisherPk: string;
  distHash: string;
  limit: number;
  caps: SpendCaps;
  databaseUrl: string;
}

export interface RunSessionDeps {
  pool?: pg.Pool;
  createPool?: (connectionString: string) => pg.Pool;
  runId?: string;
}

/**
 * One production-grade resource invocation: readiness, single-writer lock,
 * day reservation, and exactly one manifest row.
 *
 * The order is load-bearing. Readiness precedes everything so an unmigrated
 * database cannot reach the model or the homeserver; the lock precedes the
 * reservation so the loser of an overlap spends nothing; the reservation
 * commits before any external I/O so a slow model call never holds the day
 * row.
 */
export class ResourceRunSession {
  readonly meter: RunSpendMeter;
  readonly runId: string;
  #reservation?: SpendReservation;
  #lock?: PublisherLock;
  #settled = false;

  private constructor(
    private readonly opts: RunSessionOptions,
    private readonly ledger: ResourceLedger,
    private readonly pool: pg.Pool,
    private readonly ownsPool: boolean,
    runId: string,
  ) {
    this.runId = runId;
    this.meter = new RunSpendMeter(opts.caps.runUsdCap);
  }

  static async open(opts: RunSessionOptions, deps: RunSessionDeps = {}): Promise<ResourceRunSession> {
    if (!opts.databaseUrl.trim() || opts.databaseUrl.startsWith("unused:")) {
      throw new CodedResourceError("database_failed", "resource runs require a real DATABASE_URL");
    }
    const ownsPool = !deps.pool;
    const pool = deps.pool ?? (deps.createPool ?? ((c: string) => new pg.Pool({ connectionString: c })))(opts.databaseUrl);
    const session = new ResourceRunSession(opts, new ResourceLedger(pool), pool, ownsPool, deps.runId ?? randomUUID());
    try {
      await assertResourceSchemaReady(pool);
      await session.acquire();
      await session.reserve();
    } catch (error) {
      await session.dispose();
      throw error;
    }
    return session;
  }

  private get record() {
    return {
      runId: this.runId,
      target: this.opts.profile.target,
      family: this.opts.family,
      configVersion: this.opts.profile.signedConfigVersion,
      pinSetVersion: this.opts.profile.pinSetVersion,
      distHash: this.opts.distHash,
      publisherPk: this.opts.publisherPk,
      estimatedUsd: 0,
    };
  }

  private async acquire(): Promise<void> {
    try {
      this.#lock = await acquirePublisherLock(this.pool, this.opts.publisherPk);
    } catch (error) {
      if (resourceErrorCode(error) === "overlap_refused") {
        await this.ledger.recordOverlapRefused(this.record);
      }
      throw error;
    }
  }

  private async reserve(): Promise<void> {
    const recent = await this.ledger.recentAverageUsd(this.opts.profile.target, this.opts.family);
    const estimate = estimateRunUsd({
      perResourceEstimateUsd: PER_RESOURCE_ESTIMATE_USD,
      recentAverageUsd: recent,
      limit: this.opts.limit,
      runUsdCap: this.opts.caps.runUsdCap,
    });
    this.#reservation = await this.ledger.reserve(this.opts.profile.target, estimate, this.opts.caps);
    await this.ledger.startRun({ ...this.record, estimatedUsd: estimate });
  }

  /** Records one metered step and refuses the run once the cap is crossed. */
  recordSpend(step: Parameters<RunSpendMeter["record"]>[0]): number {
    return this.meter.record(step);
  }

  /** Terminal path. Settles spend, closes the manifest, and drops the lock. */
  async finish(outcome: Omit<ResourceRunOutcome, "actualUsd">): Promise<void> {
    if (this.#settled) return;
    this.#settled = true;
    try {
      const spent = this.meter.spentUsd;
      if (this.#reservation) {
        await this.ledger.settle(this.#reservation, spent, this.#reservation.reservedUsd);
      }
      await this.ledger.finishRun(this.runId, { ...outcome, actualUsd: spent });
    } finally {
      await this.dispose();
    }
  }

  /** Terminal path for a thrown error; the code is bounded, never the message. */
  async fail(error: unknown, counts: Partial<Omit<ResourceRunOutcome, "status" | "actualUsd" | "failureCode">> = {}): Promise<ResourceErrorCode> {
    const code = resourceErrorCode(error);
    await this.finish({
      status: "failed",
      accepted: counts.accepted ?? 0,
      processed: counts.processed ?? 0,
      unprocessed: counts.unprocessed ?? 0,
      written: counts.written ?? 0,
      skipped: counts.skipped ?? 0,
      failed: counts.failed ?? 0,
      puts: counts.puts ?? 0,
      deletes: counts.deletes ?? 0,
      verified: counts.verified ?? false,
      planSha256: counts.planSha256,
      failureCode: code,
    });
    return code;
  }

  private async dispose(): Promise<void> {
    try {
      await this.#lock?.release();
    } finally {
      this.#lock = undefined;
      if (this.ownsPool) await this.pool.end();
    }
  }
}
