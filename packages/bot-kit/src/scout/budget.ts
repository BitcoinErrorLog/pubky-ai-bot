import type pg from "pg";
import { ScoutToolError } from "./client.js";
import { defaultScoutEnvSwitchOn, type ScoutBudgetConfig, type ScoutEnvSwitchOn } from "./scout-config.js";
import { assertCeiling, type PersonaLedgerIdentity } from "../policy/persona-ledger.js";

export {
  noteScoutOutcome,
  resetScoutBreakerForTests,
  scoutBreakerBlocked,
  ScoutCircuitBreaker,
} from "./circuit.js";

export interface BudgetGate {
  blocked: boolean;
  reason?: string;
}

export type ComposedQueryBudget = {
  allow(owner: string): Promise<boolean>;
};

export type C5ScoutBudget = {
  reserve(owner: string, queries: number, now?: Date): Promise<boolean>;
};

const C5_SCOUT_TOOL = "pubchi_c5";

export function memoryC5ScoutBudget(cap = 20, now: () => Date = () => new Date()): C5ScoutBudget & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async reserve(owner, queries, clock = now()) {
      const key = `${clock.toISOString().slice(0, 10)}:${owner}`;
      const used = counts.get(key) ?? 0;
      if (used + queries > cap) return false;
      counts.set(key, used + queries);
      return true;
    },
  };
}

export function postgresC5ScoutBudget(
  pool: Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>,
  cap = 20,
): C5ScoutBudget {
  return {
    async reserve(owner, queries) {
      if (!Number.isInteger(queries) || queries < 1) return false;
      const key = `pubchi:${owner}:c5`;
      const client = pool.connect ? await pool.connect() : undefined;
      const db = client ?? pool;
      try {
        if (client) await client.query("BEGIN");
        if (client) await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [C5_SCOUT_TOOL, key]);
        const used = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM scout_queries
           WHERE tool = $1 AND mention_key = $2 AND created_at >= ${UTC_DAY_START_SQL}
             AND (ok = TRUE OR error_code = 'BUDGET_RESERVED')`,
          [C5_SCOUT_TOOL, key],
        );
        if (Number(used.rows[0]?.n ?? 0) + queries > cap) {
          if (client) await client.query("COMMIT");
          return false;
        }
        for (let i = 0; i < queries; i += 1) {
          await db.query(
            `INSERT INTO scout_queries
             (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, error_code, mention_key)
             VALUES ($1, $2, $3, 0, FALSE, 0, FALSE, 'BUDGET_RESERVED', $4)`,
            [C5_SCOUT_TOOL, "budget-reservation", "budget-reservation", key],
          );
        }
        if (client) await client.query("COMMIT");
        return true;
      } catch (error) {
        if (client) await client.query("ROLLBACK");
        throw error;
      } finally {
        client?.release();
      }
    },
  };
}

const COMPOSED_TOOL = "composed_cypher";

export function ownerBudgetKey(owner: string): string {
  return `pubchi:${owner}`;
}

export function memoryComposedQueryBudget(opts: {
  ownerDailyCap?: number;
  globalDailyCap?: number;
  now?: () => Date;
} = {}): ComposedQueryBudget & { ownerCounts: Map<string, number>; globalCount: () => number } {
  const ownerCounts = new Map<string, number>();
  let global = 0;
  const ownerDailyCap = opts.ownerDailyCap ?? 60;
  const globalDailyCap = opts.globalDailyCap ?? 2_000;
  const currentDay = () => (opts.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const key = (owner: string) => `${currentDay()}:${ownerBudgetKey(owner)}`;
  let activeDay = currentDay();
  const resetIfDayChanged = () => {
    const day = currentDay();
    if (day !== activeDay) {
      ownerCounts.clear();
      global = 0;
      activeDay = day;
    }
  };
  return {
    ownerCounts,
    globalCount: () => {
      resetIfDayChanged();
      return global;
    },
    async allow(owner) {
      resetIfDayChanged();
      const ownerKey = key(owner);
      const count = ownerCounts.get(ownerKey) ?? 0;
      if (count >= ownerDailyCap || global >= globalDailyCap) return false;
      ownerCounts.set(ownerKey, count + 1);
      global += 1;
      return true;
    },
  };
}

export function postgresComposedQueryBudget(
  pool: Pick<pg.Pool, "query"> & Partial<Pick<pg.Pool, "connect">>,
  opts: { ownerDailyCap?: number; globalDailyCap?: number } = {},
): ComposedQueryBudget {
  const ownerDailyCap = opts.ownerDailyCap ?? 60;
  const globalDailyCap = opts.globalDailyCap ?? 2_000;
  return {
    async allow(owner) {
      const key = ownerBudgetKey(owner);
      const client = pool.connect ? await pool.connect() : undefined;
      const db = client ?? pool;
      try {
        if (client) await client.query("BEGIN");
        if (client) {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [COMPOSED_TOOL, key]);
        }
        const ownerResult = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM scout_queries
           WHERE tool = $1 AND mention_key = $2 AND created_at >= ${UTC_DAY_START_SQL}
             AND (ok = TRUE OR error_code = 'BUDGET_RESERVED')`,
          [COMPOSED_TOOL, key],
        );
        const globalResult = await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM scout_queries
           WHERE tool = $1 AND created_at >= ${UTC_DAY_START_SQL}
             AND (ok = TRUE OR error_code = 'BUDGET_RESERVED')`,
          [COMPOSED_TOOL],
        );
        const allowed =
          Number(ownerResult.rows[0]?.n ?? 0) < ownerDailyCap &&
          Number(globalResult.rows[0]?.n ?? 0) < globalDailyCap;
        if (allowed) {
          await db.query(
            `INSERT INTO scout_queries
              (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, error_code, mention_key)
             VALUES ($1, $2, $3, 0, FALSE, 0, FALSE, 'BUDGET_RESERVED', $4)`,
            [COMPOSED_TOOL, "budget-reservation", "budget-reservation", key],
          );
        }
        if (client) await client.query("COMMIT");
        return allowed;
      } catch (error) {
        if (client) await client.query("ROLLBACK");
        throw error;
      } finally {
        client?.release();
      }
    },
  };
}

export class ScoutCallBudgetError extends Error {
  constructor(public readonly code: "SCOUT_CALL_CAP" | "SCOUT_TIME_CAP") {
    super(code);
    this.name = "ScoutCallBudgetError";
  }
}

export class ScoutCallMeter {
  private calls = 0;
  private scoutMs = 0;
  private pendingReservations = 0;

  constructor(private readonly maxCalls = 10, private readonly maxScoutMs = 20_000) {}

  record(durationMs: number): void {
    if (this.pendingReservations > 0) this.pendingReservations -= 1;
    else this.calls += 1;
    this.scoutMs += Math.max(0, durationMs);
  }

  assertBudget(): void {
    if (this.calls > this.maxCalls) throw new ScoutCallBudgetError("SCOUT_CALL_CAP");
    if (this.scoutMs > this.maxScoutMs) throw new ScoutCallBudgetError("SCOUT_TIME_CAP");
  }

  /**
   * Pre-call gate (D2). `assertBudget` only notices a breach after the call
   * that caused it has already run; this refuses the call that would exceed
   * the cap.
   */
  assertCapacity(): void {
    if (this.calls >= this.maxCalls) throw new ScoutCallBudgetError("SCOUT_CALL_CAP");
    if (this.scoutMs >= this.maxScoutMs) throw new ScoutCallBudgetError("SCOUT_TIME_CAP");
  }

  reserve(): void {
    this.assertCapacity();
    this.calls += 1;
    this.pendingReservations += 1;
  }

  snapshot(): { calls: number; scoutMs: number } {
    return { calls: this.calls, scoutMs: this.scoutMs };
  }
}

/**
 * Caller keys that are reused across mentions/requests. The all-time
 * per-mention Scout cap must not apply to these — they are governed by
 * `checkNlqDailyBudget` (UTC-day ceiling) only. Jeb reason-loop keys are
 * unique per mention and are not persistent.
 */
export function isPersistentCallerKey(key: string): boolean {
  return key.startsWith("nlq:") || key.startsWith("pubchi:");
}

/** Inclusive start of the current UTC calendar day as timestamptz. */
export const UTC_DAY_START_SQL = `((now() AT TIME ZONE 'UTC')::date)::timestamp AT TIME ZONE 'UTC'`;

export async function scoutSwitchBlocked(
  storeSwitchOn: () => Promise<boolean>,
  envSwitchOn: ScoutEnvSwitchOn = defaultScoutEnvSwitchOn,
): Promise<boolean> {
  if (envSwitchOn("scout") || envSwitchOn("global")) return true;
  return storeSwitchOn();
}

export async function checkScoutBudgets(
  pool: pg.Pool,
  cfg: ScoutBudgetConfig,
  opts: { mentionKey?: string; author?: string; raw: boolean; persistent?: boolean },
): Promise<BudgetGate> {
  const day = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM scout_queries
     WHERE created_at >= ${UTC_DAY_START_SQL}
       AND (ok = TRUE OR error_code = '${SCOUT_CALL_RESERVED}')`,
  );
  if (Number(day.rows[0]?.n ?? 0) >= cfg.scoutDailyCeiling) {
    return { blocked: true, reason: "daily_scout_ceiling" };
  }
  // Reason-loop keys are unique per mention, so all-time ≈ per mention.
  // Persistent callers (NLQ `nlq:*`, Pubchi `pubchi:*`) pass `persistent` or
  // match `isPersistentCallerKey` and use checkNlqDailyBudget only.
  const persistent = opts.persistent ?? (opts.mentionKey ? isPersistentCallerKey(opts.mentionKey) : false);
  if (opts.mentionKey && !persistent) {
    const m = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM scout_queries
       WHERE mention_key = $1 AND (ok = TRUE OR error_code = '${SCOUT_CALL_RESERVED}')`,
      [opts.mentionKey],
    );
    if (Number(m.rows[0]?.n ?? 0) >= cfg.scoutPerMentionCap) {
      return { blocked: true, reason: "per_mention_scout_cap" };
    }
  }
  if (opts.raw) {
    const g = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM scout_queries WHERE tool = 'query_graph' AND created_at >= ${UTC_DAY_START_SQL}`,
    );
    if (Number(g.rows[0]?.n ?? 0) >= cfg.scoutRawGlobalDaily) {
      return { blocked: true, reason: "raw_global_daily_cap" };
    }
    if (opts.author) {
      const u = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM scout_queries q
         JOIN handled_mentions h ON h.mention_key = q.mention_key
         WHERE q.tool = 'query_graph' AND h.author = $1 AND q.created_at >= ${UTC_DAY_START_SQL}`,
        [opts.author],
      );
      if (Number(u.rows[0]?.n ?? 0) >= cfg.scoutRawPerUserDaily) {
        return { blocked: true, reason: "raw_per_user_daily_cap" };
      }
    }
  }
  return { blocked: false };
}

/** In-flight Scout tool-call admission row; counted by every Scout ceiling until released. */
export const SCOUT_CALL_RESERVED = "CALL_RESERVED";
const SCOUT_CALL_BUDGET_LOCK = "scout_call_budget";

/** Persona Scout layer; admitted in the same transaction as the fleet Scout layer. */
export type ScoutPersonaBudget = {
  identity: PersonaLedgerIdentity;
  dailyCeiling: number;
  perMentionCeiling: number;
};

export type ScoutCallReservation = BudgetGate & { reservationId?: string };

/**
 * Atomic Scout admission. Fleet daily, per-mention, raw, and persona daily
 * ceilings are read under one advisory lock and one `CALL_RESERVED` row is
 * inserted before the lock is released, so concurrent calls cannot all pass
 * the same remaining capacity. Persona and fleet count the same ledger unit
 * (successful upstream Scout queries plus in-flight admissions); the
 * per-mention ceiling is the lower of the persona and fleet values.
 */
export async function reserveScoutCall(
  pool: pg.Pool,
  cfg: ScoutBudgetConfig,
  opts: {
    tool: string;
    mentionKey?: string;
    author?: string;
    raw: boolean;
    persistent?: boolean;
    persona?: ScoutPersonaBudget;
  },
): Promise<ScoutCallReservation> {
  const persona = opts.persona;
  if (persona) {
    assertCeiling(persona.dailyCeiling, "persona scout ceiling");
    assertCeiling(persona.perMentionCeiling, "persona scout per-mention ceiling");
  }
  const effectiveCfg = persona
    ? { ...cfg, scoutPerMentionCap: Math.min(cfg.scoutPerMentionCap, persona.perMentionCeiling) }
    : cfg;
  if (typeof pool.connect !== "function") {
    if (persona) return { blocked: true, reason: "budgets_unavailable" };
    return checkScoutBudgets(pool, cfg, opts);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [SCOUT_CALL_BUDGET_LOCK]);
    const gate = await checkScoutBudgets(client as unknown as pg.Pool, effectiveCfg, opts);
    if (gate.blocked) {
      await client.query("ROLLBACK");
      return gate;
    }
    if (persona) {
      const used = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM scout_queries
         WHERE persona_id = $1
           AND created_at >= ${UTC_DAY_START_SQL}
           AND (ok = TRUE OR error_code = '${SCOUT_CALL_RESERVED}')`,
        [persona.identity.id],
      );
      if (Number(used.rows[0]?.n ?? 0) >= persona.dailyCeiling) {
        await client.query("ROLLBACK");
        return { blocked: true, reason: "persona_daily_scout_ceiling" };
      }
    }
    const inserted = persona
      ? await client.query<{ id: string }>(
          `INSERT INTO scout_queries (
             tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, error_code, mention_key,
             persona_id, persona_version, persona_manifest_hash, target_bot_pk
           )
           VALUES ($1, 'budget-reservation', 'budget-reservation', 0, FALSE, 0, FALSE, '${SCOUT_CALL_RESERVED}', $2,
                   $3, $4, $5, $6)
           RETURNING id::text`,
          [
            opts.tool,
            opts.mentionKey ?? null,
            persona.identity.id,
            persona.identity.version,
            persona.identity.manifestHash,
            persona.identity.botPk,
          ],
        )
      : await client.query<{ id: string }>(
          `INSERT INTO scout_queries
             (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, error_code, mention_key)
           VALUES ($1, 'budget-reservation', 'budget-reservation', 0, FALSE, 0, FALSE, '${SCOUT_CALL_RESERVED}', $2)
           RETURNING id::text`,
          [opts.tool, opts.mentionKey ?? null],
        );
    await client.query("COMMIT");
    const reservationId = inserted.rows[0]?.id;
    if (!reservationId) throw new Error("scout budget reservation missing id");
    return { blocked: false, reservationId };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original reservation failure remains authoritative.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Remove the exact in-flight admission row once the call finished. The
 * upstream queries the call made are already recorded as their own rows.
 */
export async function releaseScoutCall(pool: Pick<pg.Pool, "query">, reservationId: string): Promise<void> {
  await pool.query(
    `DELETE FROM scout_queries WHERE id = $1 AND error_code = '${SCOUT_CALL_RESERVED}'`,
    [reservationId],
  );
}

/**
 * NLQ daily ceiling: per caller key for today, then the global `nlq:%` total
 * for today. Both use `JEB_NLQ_DAILY_QUERIES`. Reason-loop keys are excluded
 * by the `nlq:` prefix.
 */
export async function checkNlqDailyBudget(
  pool: Pick<pg.Pool, "query">,
  ceiling: number,
  mentionKey?: string,
): Promise<BudgetGate> {
  if (mentionKey) {
    const per = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM scout_queries
       WHERE mention_key = $1 AND created_at >= ${UTC_DAY_START_SQL}`,
      [mentionKey],
    );
    if (Number(per.rows[0]?.n ?? 0) >= ceiling) {
      return { blocked: true, reason: "nlq_daily_ceiling" };
    }
  }
  const day = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM scout_queries
     WHERE mention_key LIKE 'nlq:%' AND created_at >= ${UTC_DAY_START_SQL}`,
  );
  if (Number(day.rows[0]?.n ?? 0) >= ceiling) {
    return { blocked: true, reason: "nlq_daily_ceiling" };
  }
  return { blocked: false };
}

export function budgetError(reason: string): ScoutToolError {
  return new ScoutToolError("BUDGET", `graph lookup unavailable right now (${reason})`);
}
