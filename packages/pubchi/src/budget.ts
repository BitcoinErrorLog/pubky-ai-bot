import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { TenantV1 } from "../pubchi-schemas/index.js";
import { ownerBudgetKey } from "./env.js";

export type BudgetCheck = { ok: true } | { ok: false; code: "BUDGET_EXCEEDED" };

export type BudgetReservation = {
  id: string;
  key: string;
  signerKey?: string;
  tokens: number;
  owner: string;
  utcDay: string;
};

export type TokenBudget = {
  check(tenant: TenantV1): Promise<BudgetCheck>;
  reserve(
    tenant: TenantV1,
    tokens: number,
    signer?: string,
  ): Promise<{ ok: true; reservation: BudgetReservation } | { ok: false; code: "BUDGET_EXCEEDED" }>;
  settle(reservation: BudgetReservation): Promise<void>;
  resize(reservation: BudgetReservation, tokens: number): Promise<BudgetReservation>;
  refund(reservation: BudgetReservation): Promise<void>;
  charge(tenant: TenantV1, tokens: number): Promise<void>;
};

export type TokenBucket = {
  take(tenant: TenantV1): boolean;
};

export function signerBudgetKey(owner: string, signer: string): string {
  return `pubchi:${owner}:signer:${signer}`;
}

const TERMINAL_RESERVATION_CAP = 100_000;

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
  const yesterday = new Date(`${utcDay}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const cutoff = yesterday.toISOString().slice(0, 10);
  for (const [id, reservation] of terminalReservations) {
    if (reservation.utcDay < cutoff) terminalReservations.delete(id);
  }
}

function rememberTerminalReservation(
  terminalReservations: Map<string, BudgetReservation>,
  reservation: BudgetReservation,
): void {
  terminalReservations.set(reservation.id, reservation);
  if (terminalReservations.size > TERMINAL_RESERVATION_CAP) {
    const oldest = terminalReservations.keys().next().value;
    if (oldest) terminalReservations.delete(oldest);
  }
}

export function memoryTokenBudget(opts: {
  dailyCeiling: number;
  perRequestCap: number;
  signerDailyCeiling?: number;
}): TokenBudget & {
  spent: Map<string, number>;
  resized: Set<string>;
  terminalReservations: Map<string, BudgetReservation>;
} {
  const spent = new Map<string, number>();
  const signerSpent = new Map<string, number>();
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
    reserve(tenant, tokens, signer) {
      return withLock(lock, () => {
        const add = clampCharge(tokens, opts.perRequestCap);
        const key = keyOf(tenant);
        const signerKey = signer ? signerBudgetKey(tenant.owner, signer) : undefined;
        const used = spent.get(key) ?? 0;
        const signerUsed = signerKey ? signerSpent.get(signerKey) ?? 0 : 0;
        const signerCeiling = opts.signerDailyCeiling ?? Math.floor(opts.dailyCeiling * 0.25);
        if (add <= 0) return {
          ok: true as const,
          reservation: { id: randomUUID(), key, signerKey, tokens: 0, owner: tenant.owner, utcDay: utcDay() },
        };
        if (used + add > opts.dailyCeiling || signerKey && signerUsed + add > signerCeiling) {
          return { ok: false as const, code: "BUDGET_EXCEEDED" as const };
        }
        spent.set(key, used + add);
        if (signerKey) signerSpent.set(signerKey, signerUsed + add);
        return { ok: true as const, reservation: { id: randomUUID(), key, signerKey, tokens: add, owner: tenant.owner, utcDay: utcDay() } };
      });
    },
    settle(reservation) {
      return withLock(lock, () => {
        const today = utcDay();
        pruneTerminalReservations(terminalReservations, today);
        if (terminalReservations.has(reservation.id)) return;
        if (reservation.utcDay < today) return;
        rememberTerminalReservation(terminalReservations, reservation);
        resized.delete(reservation.id);
        resizedReservations.delete(reservation.id);
      });
    },
    resize(reservation, tokens) {
      return withLock(lock, () => {
        const today = utcDay();
        pruneTerminalReservations(terminalReservations, today);
        const terminal = terminalReservations.get(reservation.id);
        if (terminal) return terminal;
        if (reservation.utcDay < today) return reservation;
        const previous = resizedReservations.get(reservation.id);
        if (previous) return previous;
        const next = Math.max(0, Math.min(reservation.tokens, Math.floor(tokens)));
        spent.set(reservation.key, Math.max(0, (spent.get(reservation.key) ?? 0) - (reservation.tokens - next)));
        if (reservation.signerKey) {
          signerSpent.set(
            reservation.signerKey,
            Math.max(0, (signerSpent.get(reservation.signerKey) ?? 0) - (reservation.tokens - next)),
          );
        }
        resized.add(reservation.id);
        const resizedReservation = { ...reservation, tokens: next };
        resizedReservations.set(reservation.id, resizedReservation);
        return resizedReservation;
      });
    },
    refund(reservation) {
      return withLock(lock, () => {
        const today = utcDay();
        pruneTerminalReservations(terminalReservations, today);
        if (terminalReservations.has(reservation.id)) return;
        if (reservation.utcDay < today) return;
        const resizedReservation = resizedReservations.get(reservation.id);
        if (resizedReservation) {
          resizedReservations.delete(reservation.id);
          resized.delete(reservation.id);
          if (resizedReservation.tokens > 0) {
            spent.set(
              resizedReservation.key,
              Math.max(0, (spent.get(resizedReservation.key) ?? 0) - resizedReservation.tokens),
            );
          }
          if (resizedReservation.signerKey && resizedReservation.tokens > 0) {
            signerSpent.set(
              resizedReservation.signerKey,
              Math.max(0, (signerSpent.get(resizedReservation.signerKey) ?? 0) - resizedReservation.tokens),
            );
          }
          rememberTerminalReservation(terminalReservations, { ...resizedReservation, tokens: 0 });
          return;
        }
        if (reservation.tokens > 0) {
          spent.set(reservation.key, Math.max(0, (spent.get(reservation.key) ?? 0) - reservation.tokens));
        }
        if (reservation.signerKey && reservation.tokens > 0) {
          signerSpent.set(reservation.signerKey, Math.max(0, (signerSpent.get(reservation.signerKey) ?? 0) - reservation.tokens));
        }
        rememberTerminalReservation(terminalReservations, { ...reservation, tokens: 0 });
      });
    },
    terminalReservations,
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
  opts: { dailyCeiling: number; perRequestCap: number; signerDailyCeiling?: number },
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
    async reserve(tenant, tokens, signer) {
      const add = clampCharge(tokens, opts.perRequestCap);
      const key = ownerBudgetKey(tenant.owner);
      const signerKey = signer ? signerBudgetKey(tenant.owner, signer) : undefined;
      if (add <= 0) {
        const day = await pool.query<{ utc_day: string }>(`SELECT ${UTC_DAY_SQL}::text AS utc_day`);
        return { ok: true, reservation: { id: randomUUID(), key, signerKey, tokens: 0, owner: tenant.owner, utcDay: day.rows[0].utc_day } };
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
      if (signerKey) {
        const signerLimit = opts.signerDailyCeiling ?? Math.floor(opts.dailyCeiling * 0.25);
        const signerResult = await pool.query(
          `INSERT INTO pubchi_budget_day (mention_key, utc_day, reserved)
           VALUES ($1, ${UTC_DAY_SQL}, $2)
           ON CONFLICT (mention_key, utc_day) DO UPDATE
           SET reserved = pubchi_budget_day.reserved + EXCLUDED.reserved
           WHERE pubchi_budget_day.reserved + EXCLUDED.reserved <= $3
           RETURNING reserved`,
          [signerKey, add, signerLimit],
        );
        if (signerResult.rows.length !== 1) {
          await pool.query(
            `UPDATE pubchi_budget_day SET reserved = GREATEST(0, reserved - $2)
             WHERE mention_key = $1 AND utc_day = $3`,
            [key, add, r.rows[0].utc_day],
          );
          return { ok: false, code: "BUDGET_EXCEEDED" };
        }
      }
      return { ok: true, reservation: { id: randomUUID(), key, signerKey, tokens: add, owner: tenant.owner, utcDay: r.rows[0].utc_day } };
    },
    async settle(reservation) {
      const today = utcDay();
      pruneTerminalReservations(terminalReservations, today);
      if (terminalReservations.has(reservation.id)) return;
      if (reservation.utcDay < today) return;
      try {
        if (reservation.tokens > 0) {
          await pool.query(
            `INSERT INTO token_usage (mention_key, public_key, phase, provider, model, input_tokens, output_tokens, total_tokens)
             VALUES ($1, $2, 'pubchi', 'pubchi', 'pubchi', NULL, NULL, $3)`,
            [reservation.key, reservation.owner, reservation.tokens],
          );
        }
        rememberTerminalReservation(terminalReservations, reservation);
      } finally {
        resized.delete(reservation.id);
        resizedReservations.delete(reservation.id);
      }
    },
    async resize(reservation, tokens) {
      const today = utcDay();
      pruneTerminalReservations(terminalReservations, today);
      const terminal = terminalReservations.get(reservation.id);
      if (terminal) return terminal;
      if (reservation.utcDay < today) return reservation;
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
        if (reservation.signerKey) {
          await pool.query(
            `UPDATE pubchi_budget_day SET reserved = GREATEST(0, reserved - $2)
             WHERE mention_key = $1 AND utc_day = $3`,
            [reservation.signerKey, delta, reservation.utcDay],
          );
        }
      }
      resized.add(reservation.id);
      const resizedReservation = { ...reservation, tokens: next };
      resizedReservations.set(reservation.id, resizedReservation);
      return resizedReservation;
    },
    async refund(reservation) {
      const today = utcDay();
      pruneTerminalReservations(terminalReservations, today);
      if (terminalReservations.has(reservation.id)) return;
      if (reservation.utcDay < today) return;
      const resizedReservation = resizedReservations.get(reservation.id);
      if (resizedReservation) {
        resizedReservations.delete(reservation.id);
        resized.delete(reservation.id);
        if (resizedReservation.tokens > 0) {
          await pool.query(
            `UPDATE pubchi_budget_day SET reserved = GREATEST(0, reserved - $2)
             WHERE mention_key = $1 AND utc_day = $3`,
            [resizedReservation.key, resizedReservation.tokens, resizedReservation.utcDay],
          );
          if (resizedReservation.signerKey) {
            await pool.query(
              `UPDATE pubchi_budget_day SET reserved = GREATEST(0, reserved - $2)
               WHERE mention_key = $1 AND utc_day = $3`,
              [resizedReservation.signerKey, resizedReservation.tokens, resizedReservation.utcDay],
            );
          }
        }
        rememberTerminalReservation(terminalReservations, { ...resizedReservation, tokens: 0 });
        return;
      }
      if (reservation.tokens > 0) {
        await pool.query(
          `UPDATE pubchi_budget_day SET reserved = GREATEST(0, reserved - $2)
           WHERE mention_key = $1 AND utc_day = $3`,
          [reservation.key, reservation.tokens, reservation.utcDay],
        );
        if (reservation.signerKey) {
          await pool.query(
            `UPDATE pubchi_budget_day SET reserved = GREATEST(0, reserved - $2)
             WHERE mention_key = $1 AND utc_day = $3`,
            [reservation.signerKey, reservation.tokens, reservation.utcDay],
          );
        }
      }
      rememberTerminalReservation(terminalReservations, { ...reservation, tokens: 0 });
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
