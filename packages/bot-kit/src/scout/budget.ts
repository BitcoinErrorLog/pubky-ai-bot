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
  opts: { mentionKey?: string; author?: string; raw: boolean },
): Promise<BudgetGate> {
  const day = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM scout_queries WHERE created_at >= date_trunc('day', now()) AND ok = TRUE`,
  );
  if (Number(day.rows[0]?.n ?? 0) >= cfg.scoutDailyCeiling) {
    return { blocked: true, reason: "daily_scout_ceiling" };
  }
  if (opts.mentionKey) {
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
      `SELECT count(*)::text AS n FROM scout_queries WHERE tool = 'query_graph' AND created_at >= date_trunc('day', now())`,
    );
    if (Number(g.rows[0]?.n ?? 0) >= cfg.scoutRawGlobalDaily) {
      return { blocked: true, reason: "raw_global_daily_cap" };
    }
    if (opts.author) {
      const u = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM scout_queries q
         JOIN handled_mentions h ON h.mention_key = q.mention_key
         WHERE q.tool = 'query_graph' AND h.author = $1 AND q.created_at >= date_trunc('day', now())`,
        [opts.author],
      );
      if (Number(u.rows[0]?.n ?? 0) >= cfg.scoutRawPerUserDaily) {
        return { blocked: true, reason: "raw_per_user_daily_cap" };
      }
    }
  }
  return { blocked: false };
}

/** NLQ daily ceiling over caller-keyed rows (`mention_key LIKE 'nlq:%'`). */
export async function checkNlqDailyBudget(pool: pg.Pool, ceiling: number): Promise<BudgetGate> {
  const day = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM scout_queries
     WHERE mention_key LIKE 'nlq:%' AND created_at >= date_trunc('day', now())`,
  );
  if (Number(day.rows[0]?.n ?? 0) >= ceiling) {
    return { blocked: true, reason: "nlq_daily_ceiling" };
  }
  return { blocked: false };
}

export function budgetError(reason: string): ScoutToolError {
  return new ScoutToolError("BUDGET", `graph lookup unavailable right now (${reason})`);
}
