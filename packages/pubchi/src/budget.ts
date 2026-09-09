import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { TenantV1 } from "../pubchi-schemas/index.js";
import { ownerBudgetKey } from "./env.js";

export type BudgetCheck = { ok: true } | { ok: false; code: "BUDGET_EXCEEDED" };

export type BudgetReservation = { id: string; key: string; tokens: number; owner: string; utcDay: string };

export type TokenBudget = {
  check(tenant: TenantV1): Promise<BudgetCheck>;
  reserve(
    tenant: TenantV1,
    tokens: number,
  ): Promise<{ ok: true; reservation: BudgetReservation } | { ok: false; code: "BUDGET_EXCEEDED" }>;
  settle(reservation: BudgetReservation): Promise<void>;
  resize(reservation: BudgetReservation, tokens: number): Promise<BudgetReservation>;
  refund(reservation: BudgetReservation): Promise<void>;
  charge(tenant: TenantV1, tokens: number): Promise<void>;
};

export type TokenBucket = {
  take(tenant: TenantV1): boolean;
};

function clampCharge(tokens: number, perRequestCap: number): number {
  return Math.min(Math.max(0, tokens), perRequestCap);
}

function withLock<T>(tail: { p: Promise<unknown> }, fn: () => T | Promise<T>): Promise<T> {
  const run = tail.p.then(fn, fn);
  tail.p = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function pruneTerminalReservations(
  terminalReservations: Map<string, BudgetReservation>,
  utcDay: string,
): void {
  for (const [id, reservation] of terminalReservations) {
    if (reservation.utcDay < utcDay) terminalReservations.delete(id);
  }
}

export function memoryTokenBudget(opts: {
  dailyCeiling: number;
  perRequestCap: number;
}): TokenBudget & { spent: Map<string, number>; resized: Set<string> } {
  const spent = new Map<string, number>();
  const resized = new Set<string>();
  const resizedReservations = new Map<string, BudgetReservation>();
  const terminalReservations = new Map<string, BudgetReservation>();
  const lock = { p: Promise.resolve() as Promise<unknown> };
  const keyOf = (t: TenantV1) => ownerBudgetKey(t.owner);
  const utcDay = () => new Date().toISOString().slice(0, 10);
  return {
    spent,
    resized,
    async check(tenant) {
      const used = spent.get(keyOf(tenant)) ?? 0;
      if (used >= opts.dailyCeiling) return { ok: false, code: "BUDGET_EXCEEDED" };
      if (used + opts.perRequestCap > opts.dailyCeiling) return { ok: false, code: "BUDGET_EXCEEDED" };
      return { ok: true };
    },
    reserve(tenant, tokens) {
      return withLock(lock, () => {
        const add = clampCharge(tokens, opts.perRequestCap);
        const key = keyOf(tenant);
        const used = spent.get(key) ?? 0;
        if (add <= 0) return {
          ok: true as const,
          reservation: { id: randomUUID(), key, tokens: 0, owner: tenant.owner, utcDay: utcDay() },
        };
        if (used + add > opts.dailyCeiling) return { ok: false as const, code: "BUDGET_EXCEEDED" as const };
        spent.set(key, used + add);
        return { ok: true as const, reservation: { id: randomUUID(), key, tokens: add, owner: tenant.owner, utcDay: utcDay() } };
      });
    },
    settle(reservation) {
      return withLock(lock, () => {
        pruneTerminalReservations(terminalReservations, utcDay());
        if (terminalReservations.has(reservation.id)) return;
        terminalReservations.set(reservation.id, reservation);
        resized.delete(reservation.id);
        resizedReservations.delete(reservation.id);
      });
    },
    resize(reservation, tokens) {
      return withLock(lock, () => {
        pruneTerminalReservations(terminalReservations, utcDay());
        const terminal = terminalReservations.get(reservation.id);
        if (terminal) return terminal;
        const previous = resizedReservations.get(reservation.id);
        if (previous) return previous;
        const next = Math.max(0, Math.min(reservation.tokens, Math.floor(tokens)));
        spent.set(reservation.key, Math.max(0, (spent.get(reservation.key) ?? 0) - (reservation.tokens - next)));
        resized.add(reservation.id);
        const resizedReservation = { ...reservation, tokens: next };
        resizedReservations.set(reservation.id, resizedReservation);
        return resizedReservation;
      });
    },
    refund(reservation) {
      return withLock(lock, () => {
        pruneTerminalReservations(terminalReservations, utcDay());
        if (terminalReservations.has(reservation.id)) return;
        const resizedReservation = resizedReservations.get(reservation.id);
        if (resizedReservation) {
          resizedReservations.delete(reservation.id);
          resized.delete(reservation.id);
          terminalReservations.set(reservation.id, { ...resizedReservation, tokens: 0 });
          return;
        }
        if (reservation.tokens > 0) {
          spent.set(reservation.key, Math.max(0, (spent.get(reservation.key) ?? 0) - reservation.tokens));
        }
        terminalReservations.set(reservation.id, { ...reservation, tokens: 0 });
      });
    },
    async charge(tenant, tokens) {
      const reserved = await this.reserve(tenant, tokens);
      if (!reserved.ok) return;
      await this.settle(reserved.reservation);
    },
  };
}

const UTC_DAY_SQL = `(now() AT TIME ZONE 'UTC')::date`;

export function postgresTokenBudget(
  pool: Pick<pg.Pool, "query">,
  opts: { dailyCeiling: number; perRequestCap: number },
): TokenBudget {
  const resized = new Set<string>();
  const resizedReservations = new Map<string, BudgetReservation>();
  const terminalReservations = new Map<string, BudgetReservation>();
  const utcDay = () => new Date().toISOString().slice(0, 10);
  return {
    async check(tenant) {
      const key = ownerBudgetKey(tenant.owner);
      const r = await pool.query<{ reserved: string | null }>(
        `SELECT reserved::text AS reserved FROM pubchi_budget_day
         WHERE mention_key = $1 AND utc_day = ${UTC_DAY_SQL}`,
        [key],
      );
      const used = r.rows[0]?.reserved ? parseInt(r.rows[0].reserved, 10) : 0;
      if (!Number.isFinite(used) || used >= opts.dailyCeiling) return { ok: false, code: "BUDGET_EXCEEDED" };
      if (used + opts.perRequestCap > opts.dailyCeiling) return { ok: false, code: "BUDGET_EXCEEDED" };
      return { ok: true };
    },
    async reserve(tenant, tokens) {
      const add = clampCharge(tokens, opts.perRequestCap);
      const key = ownerBudgetKey(tenant.owner);
      if (add <= 0) {
        const day = await pool.query<{ utc_day: string }>(`SELECT ${UTC_DAY_SQL}::text AS utc_day`);
        return { ok: true, reservation: { id: randomUUID(), key, tokens: 0, owner: tenant.owner, utcDay: day.rows[0].utc_day } };
      }
      const r = await pool.query<{ reserved: string; utc_day: string }>(
        `INSERT INTO pubchi_budget_day (mention_key, utc_day, reserved)
         VALUES ($1, ${UTC_DAY_SQL}, $2)
         ON CONFLICT (mention_key, utc_day) DO UPDATE
         SET reserved = pubchi_budget_day.reserved + EXCLUDED.reserved
         WHERE pubchi_budget_day.reserved + EXCLUDED.reserved <= $3
         RETURNING reserved::text AS reserved, utc_day::text AS utc_day`,
        [key, add, opts.dailyCeiling],
      );
      if (r.rows.length !== 1) return { ok: false, code: "BUDGET_EXCEEDED" };
      return { ok: true, reservation: { id: randomUUID(), key, tokens: add, owner: tenant.owner, utcDay: r.rows[0].utc_day } };
    },
    async settle(reservation) {
      pruneTerminalReservations(terminalReservations, utcDay());
      if (terminalReservations.has(reservation.id)) return;
      try {
        if (reservation.tokens > 0) {
          await pool.query(
            `INSERT INTO token_usage (mention_key, public_key, phase, provider, model, input_tokens, output_tokens, total_tokens)
             VALUES ($1, $2, 'pubchi', 'pubchi', 'pubchi', NULL, NULL, $3)`,
            [reservation.key, reservation.owner, reservation.tokens],
          );
        }
        terminalReservations.set(reservation.id, reservation);
      } finally {
        resized.delete(reservation.id);
        resizedReservations.delete(reservation.id);
      }
    },
    async resize(reservation, tokens) {
      pruneTerminalReservations(terminalReservations, utcDay());
      const terminal = terminalReservations.get(reservation.id);
      if (terminal) return terminal;
      const previous = resizedReservations.get(reservation.id);
      if (previous) return previous;
      const next = Math.max(0, Math.min(reservation.tokens, Math.floor(tokens)));
      const delta = reservation.tokens - next;
      if (delta > 0) {
        await pool.query(
          `UPDATE pubchi_budget_day SET reserved = GREATEST(0, reserved - $2)
           WHERE mention_key = $1 AND utc_day = $3`,
          [reservation.key, delta, reservation.utcDay],
        );
      }
      resized.add(reservation.id);
      const resizedReservation = { ...reservation, tokens: next };
      resizedReservations.set(reservation.id, resizedReservation);
      return resizedReservation;
    },
    async refund(reservation) {
      pruneTerminalReservations(terminalReservations, utcDay());
      if (terminalReservations.has(reservation.id)) return;
      const resizedReservation = resizedReservations.get(reservation.id);
      if (resizedReservation) {
        resizedReservations.delete(reservation.id);
        resized.delete(reservation.id);
        terminalReservations.set(reservation.id, { ...resizedReservation, tokens: 0 });
        return;
      }
      if (reservation.tokens > 0) {
        await pool.query(
          `UPDATE pubchi_budget_day SET reserved = GREATEST(0, reserved - $2)
           WHERE mention_key = $1 AND utc_day = $3`,
          [reservation.key, reservation.tokens, reservation.utcDay],
        );
      }
      terminalReservations.set(reservation.id, { ...reservation, tokens: 0 });
    },
    async charge(tenant, tokens) {
      const reserved = await this.reserve(tenant, tokens);
      if (!reserved.ok) return;
      await this.settle(reserved.reservation);
    },
  };
}

export function memoryTokenBucket(opts: { ratePerSec: number; burst: number }): TokenBucket {
  const state = new Map<string, { tokens: number; updated: number }>();
  return {
    take(tenant) {
      const key = ownerBudgetKey(tenant.owner);
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
