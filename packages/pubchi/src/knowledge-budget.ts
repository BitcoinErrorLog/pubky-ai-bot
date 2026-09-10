import { ownerBudgetKey } from "./env.js";
import { UTC_DAY_START_SQL } from "../bot-kit/scout/budget.js";

export type PubchiKnowledgeBudget = {
  allow(owner: string): Promise<boolean>;
};

export function memoryPubchiKnowledgeBudget(opts: { ownerDailyCap?: number; clock?: () => number } = {}): PubchiKnowledgeBudget & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const cap = opts.ownerDailyCap ?? 40;
  const clock = opts.clock ?? Date.now;
  return {
    counts,
    async allow(owner) {
      const day = new Date(clock()).toISOString().slice(0, 10);
      const key = `${day}:${ownerBudgetKey(owner)}`;
      const count = counts.get(key) ?? 0;
      if (count >= cap) return false;
      counts.set(key, count + 1);
      return true;
    },
  };
}

export function postgresPubchiKnowledgeBudget(
  pool: { query(sql: string, values?: unknown[]): Promise<{ rows: Array<{ n?: string }> }> },
  opts: { ownerDailyCap?: number } = {},
): PubchiKnowledgeBudget {
  const cap = opts.ownerDailyCap ?? 40;
  return {
    async allow(owner) {
      const key = ownerBudgetKey(owner);
      const found = await pool.query(
        `SELECT count(*)::text AS n FROM scout_queries WHERE tool = $1 AND mention_key = $2 AND created_at >= ${UTC_DAY_START_SQL}`,
        ["knowledge_search", key],
      );
      if (Number(found.rows[0]?.n ?? 0) >= cap) return false;
      await pool.query(
        `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, error_code, mention_key)
         VALUES ($1, $2, $2, 0, FALSE, 0, FALSE, 'BUDGET_RESERVED', $3)`,
        ["knowledge_search", "budget-reservation", key],
      );
      return true;
    },
  };
}
