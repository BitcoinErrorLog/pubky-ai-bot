import type pg from "pg";
import type { TenantV1 } from "../pubchi-schemas/index.js";
import { scoutMentionKey } from "./env.js";

export type BudgetCheck = { ok: true } | { ok: false; code: "BUDGET_EXCEEDED" };

export type TokenBudget = {
  check(tenant: TenantV1): Promise<BudgetCheck>;
  charge(tenant: TenantV1, tokens: number): Promise<void>;
};

export type TokenBucket = {
  take(tenant: TenantV1): boolean;
};

export function memoryTokenBudget(opts: {
  dailyCeiling: number;
  perRequestCap: number;
}): TokenBudget & { spent: Map<string, number> } {
  const spent = new Map<string, number>();
  const keyOf = (t: TenantV1) => scoutMentionKey(t.bot, t.owner);
  return {
    spent,
    async check(tenant) {
      const used = spent.get(keyOf(tenant)) ?? 0;
      if (used >= opts.dailyCeiling) return { ok: false, code: "BUDGET_EXCEEDED" };
      if (used + opts.perRequestCap > opts.dailyCeiling) return { ok: false, code: "BUDGET_EXCEEDED" };
      return { ok: true };
    },
    async charge(tenant, tokens) {
      const key = keyOf(tenant);
      const add = Math.min(Math.max(0, tokens), opts.perRequestCap);
      spent.set(key, (spent.get(key) ?? 0) + add);
    },
  };
}

export function postgresTokenBudget(
  pool: pg.Pool,
  opts: { dailyCeiling: number; perRequestCap: number },
): TokenBudget {
  return {
    async check(tenant) {
      const key = scoutMentionKey(tenant.bot, tenant.owner);
      const r = await pool.query<{ total: string | null }>(
        `SELECT SUM(total_tokens)::text AS total FROM token_usage
         WHERE mention_key = $1 AND created_at >= date_trunc('day', now())`,
        [key],
      );
      const used = r.rows[0]?.total ? parseInt(r.rows[0].total, 10) : 0;
      if (!Number.isFinite(used) || used >= opts.dailyCeiling) return { ok: false, code: "BUDGET_EXCEEDED" };
      if (used + opts.perRequestCap > opts.dailyCeiling) return { ok: false, code: "BUDGET_EXCEEDED" };
      return { ok: true };
    },
    async charge(tenant, tokens) {
      const key = scoutMentionKey(tenant.bot, tenant.owner);
      const add = Math.min(Math.max(0, tokens), opts.perRequestCap);
      if (add <= 0) return;
      await pool.query(
        `INSERT INTO token_usage (mention_key, public_key, phase, provider, model, input_tokens, output_tokens, total_tokens)
         VALUES ($1, $2, 'pubchi', 'pubchi', 'pubchi', NULL, NULL, $3)`,
        [key, tenant.owner, add],
      );
    },
  };
}

export function memoryTokenBucket(opts: { ratePerSec: number; burst: number }): TokenBucket {
  const state = new Map<string, { tokens: number; updated: number }>();
  return {
    take(tenant) {
      const key = scoutMentionKey(tenant.bot, tenant.owner);
      const now = Date.now();
      let s = state.get(key);
      if (!s) {
        s = { tokens: opts.burst, updated: now };
        state.set(key, s);
      }
      const elapsed = (now - s.updated) / 1000;
      s.tokens = Math.min(opts.burst, s.tokens + elapsed * opts.ratePerSec);
      s.updated = now;
      if (s.tokens < 1) return false;
      s.tokens -= 1;
      return true;
    },
  };
}
