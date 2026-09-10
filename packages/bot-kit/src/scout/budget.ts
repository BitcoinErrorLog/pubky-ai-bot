import type pg from "pg";
import { ScoutToolError } from "./client.js";
import { defaultScoutEnvSwitchOn, type ScoutBudgetConfig, type ScoutEnvSwitchOn } from "./scout-config.js";

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

const COMPOSED_TOOL = "composed_cypher";

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
  const key = (owner: string) => `${currentDay()}:${owner}`;
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
  pool: Pick<pg.Pool, "query">,
  opts: { ownerDailyCap?: number; globalDailyCap?: number } = {},
): ComposedQueryBudget {
  const ownerDailyCap = opts.ownerDailyCap ?? 60;
  const globalDailyCap = opts.globalDailyCap ?? 2_000;
  return {
    async allow(owner) {
      const ownerResult = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM scout_queries
         WHERE tool = $1 AND mention_key = $2 AND created_at >= ${UTC_DAY_START_SQL} AND ok = TRUE`,
        [COMPOSED_TOOL, owner],
      );
      if (Number(ownerResult.rows[0]?.n ?? 0) >= ownerDailyCap) return false;
      const globalResult = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM scout_queries
         WHERE tool = $1 AND created_at >= ${UTC_DAY_START_SQL} AND ok = TRUE`,
        [COMPOSED_TOOL],
      );
      return Number(globalResult.rows[0]?.n ?? 0) < globalDailyCap;
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

  constructor(private readonly maxCalls = 10, private readonly maxScoutMs = 20_000) {}

  record(durationMs: number): void {
    this.calls += 1;
    this.scoutMs += Math.max(0, durationMs);
  }

  assertBudget(): void {
    if (this.calls > this.maxCalls) throw new ScoutCallBudgetError("SCOUT_CALL_CAP");
    if (this.scoutMs > this.maxScoutMs) throw new ScoutCallBudgetError("SCOUT_TIME_CAP");
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
    `SELECT count(*)::text AS n FROM scout_queries WHERE created_at >= ${UTC_DAY_START_SQL} AND ok = TRUE`,
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
      `SELECT count(*)::text AS n FROM scout_queries WHERE mention_key = $1 AND ok = TRUE`,
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
