import type pg from "pg";
import { assertCeiling, type PersonaLedgerIdentity } from "./bot-kit/policy/persona-ledger.js";

/**
 * Fleet token-ledger lock. Every token admission, resize, settlement, refund,
 * and stale cleanup takes it first, so fleet, fleet-user, persona,
 * persona-user, and persona-image totals are read and written as one unit.
 */
const VISUAL_BUDGET_LOCK = 0x4a454249;
const UTC_DAY_START = "(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')";

export const VISUAL_RESERVATION_KIND = "prospective_visual_tokens";
export const TEXT_RESERVATION_KIND = "prospective_text_tokens";
export const TEXT_RESERVE_PHASE = "token_reserve";
export const TEXT_RESERVE_EXPIRED_PHASE = "token_reserve_expired";
const IMAGE_RESERVE_PHASE = "image_reserve";

type LedgerKind = "image" | "text";

const LEDGER: Record<LedgerKind, { phase: string; kind: string }> = {
  image: { phase: IMAGE_RESERVE_PHASE, kind: VISUAL_RESERVATION_KIND },
  text: { phase: TEXT_RESERVE_PHASE, kind: TEXT_RESERVATION_KIND },
};

export type VisualTokenReservation = {
  id: string;
  mentionKey: string;
  publicKey: string;
  estimatedTokens: number;
};

export type TextTokenReservation = VisualTokenReservation;

/** Binding ceilings; each is enforced in the same transaction as the fleet ceilings. */
export type TokenLedgerPersona = {
  identity: PersonaLedgerIdentity;
  dailyTokens: number;
  userDailyTokens: number;
  imageDailyTokens: number;
};

type ReserveArgs = {
  mentionKey: string;
  publicKey: string;
  targetTokens: number;
  globalCeiling: number;
  userCeiling: number;
  staleAfterMs: number;
  reservation?: VisualTokenReservation;
  persona?: TokenLedgerPersona;
};

async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Stale image reservations are deleted (the canonical visual path). Stale text
 * reservations are kept as conservative usage: a crashed or unsettled answer may
 * already have spent them, so they are never refunded.
 */
async function cleanStale(client: pg.PoolClient, staleAfterMs: number): Promise<number> {
  const removed = await client.query(
    `DELETE FROM token_usage
      WHERE phase = 'image_reserve'
        AND created_at < now() - ($1::text || ' milliseconds')::interval`,
    [String(staleAfterMs)],
  );
  const expired = await client.query(
    `UPDATE token_usage
        SET phase = 'token_reserve_expired'
      WHERE phase = 'token_reserve'
        AND created_at < now() - ($1::text || ' milliseconds')::interval`,
    [String(staleAfterMs)],
  );
  return (removed.rowCount ?? 0) + (expired.rowCount ?? 0);
}

async function lockAndClean(client: pg.PoolClient, staleAfterMs: number): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [VISUAL_BUDGET_LOCK]);
  await cleanStale(client, staleAfterMs);
}

function validateReserveArgs(args: ReserveArgs): void {
  if (!Number.isSafeInteger(args.targetTokens) || args.targetTokens <= 0) {
    throw new Error("invalid token reservation");
  }
  assertCeiling(args.globalCeiling, "fleet token ceiling");
  assertCeiling(args.userCeiling, "fleet user token ceiling");
  if (args.persona) {
    assertCeiling(args.persona.dailyTokens, "persona token ceiling");
    assertCeiling(args.persona.userDailyTokens, "persona user token ceiling");
    assertCeiling(args.persona.imageDailyTokens, "persona image token ceiling");
  }
}

/**
 * Atomically create or resize one exact reservation row. All five layers are
 * summed from `token_usage` for the reservation's UTC day under the fleet
 * ledger lock; a refusal by any layer returns null before any write, so the
 * transaction leaves no partial state. A resize subtracts only this row.
 */
async function reserveLedgerTokens(
  pool: pg.Pool,
  ledger: LedgerKind,
  args: ReserveArgs,
): Promise<VisualTokenReservation | null> {
  validateReserveArgs(args);
  const { phase, kind } = LEDGER[ledger];
  const persona = args.persona;
  return transaction(pool, async (client) => {
    await lockAndClean(client, args.staleAfterMs);
    let current = 0;
    let reservationCreatedAt: Date | null = null;
    if (args.reservation) {
      const row = await client.query<{ total_tokens: number | null; created_at: Date; persona_id: string }>(
        `SELECT total_tokens, created_at, persona_id
           FROM token_usage
          WHERE id = $1 AND mention_key = $2 AND public_key = $3 AND phase = $4
          FOR UPDATE`,
        [args.reservation.id, args.mentionKey, args.publicKey, phase],
      );
      if (row.rowCount !== 1) return null;
      if (persona && row.rows[0]!.persona_id !== persona.identity.id) return null;
      current = Number(row.rows[0]?.total_tokens ?? 0);
      reservationCreatedAt = row.rows[0]!.created_at;
    }
    const dayPredicate = reservationCreatedAt
      ? `created_at >= (date_trunc('day', $3::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
         AND created_at < (date_trunc('day', $3::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + interval '1 day'`
      : `created_at >= ${UTC_DAY_START}`;
    const totals = await client.query<{
      global_total: string;
      user_total: string;
      persona_total: string;
      persona_user_total: string;
      persona_image_total: string;
    }>(
      `SELECT
         COALESCE(SUM(total_tokens), 0)::text AS global_total,
         COALESCE(SUM(total_tokens) FILTER (WHERE public_key = $1), 0)::text AS user_total,
         COALESCE(SUM(total_tokens) FILTER (WHERE persona_id = $2), 0)::text AS persona_total,
         COALESCE(SUM(total_tokens) FILTER (WHERE persona_id = $2 AND public_key = $1), 0)::text AS persona_user_total,
         COALESCE(SUM(total_tokens) FILTER (
           WHERE persona_id = $2 AND meta_json->>'kind' = '${VISUAL_RESERVATION_KIND}'
         ), 0)::text AS persona_image_total
       FROM token_usage
       WHERE ${dayPredicate}`,
      reservationCreatedAt
        ? [args.publicKey, persona?.identity.id ?? null, reservationCreatedAt]
        : [args.publicKey, persona?.identity.id ?? null],
    );
    const row = totals.rows[0];
    const next = (total: string | undefined) => Number(total ?? 0) - current + args.targetTokens;
    if (next(row?.global_total) > args.globalCeiling) return null;
    if (next(row?.user_total) > args.userCeiling) return null;
    if (persona) {
      if (next(row?.persona_total) > persona.dailyTokens) return null;
      if (next(row?.persona_user_total) > persona.userDailyTokens) return null;
      if (ledger === "image" && next(row?.persona_image_total) > persona.imageDailyTokens) return null;
    }
    if (args.reservation) {
      await client.query(
        `UPDATE token_usage SET total_tokens = $1
          WHERE id = $2 AND mention_key = $3 AND public_key = $4 AND phase = $5`,
        [args.targetTokens, args.reservation.id, args.mentionKey, args.publicKey, phase],
      );
      return { ...args.reservation, estimatedTokens: args.targetTokens };
    }
    const meta = JSON.stringify({ kind, estimate: args.targetTokens });
    const inserted = persona
      ? await client.query<{ id: string }>(
          `INSERT INTO token_usage (
             mention_key, public_key, phase, total_tokens, meta_json,
             persona_id, persona_version, persona_manifest_hash, target_bot_pk
           )
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
           RETURNING id::text`,
          [
            args.mentionKey,
            args.publicKey,
            phase,
            args.targetTokens,
            meta,
            persona.identity.id,
            persona.identity.version,
            persona.identity.manifestHash,
            persona.identity.botPk,
          ],
        )
      : await client.query<{ id: string }>(
          `INSERT INTO token_usage (mention_key, public_key, phase, total_tokens, meta_json)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING id::text`,
          [args.mentionKey, args.publicKey, phase, args.targetTokens, meta],
        );
    return {
      id: inserted.rows[0]!.id,
      mentionKey: args.mentionKey,
      publicKey: args.publicKey,
      estimatedTokens: args.targetTokens,
    };
  });
}

/**
 * Admit an image-bearing model call. The row covers the whole call bound and
 * counts toward fleet, fleet-user, persona, persona-user, and persona-image.
 */
export async function reserveVisualTokens(
  pool: pg.Pool,
  args: ReserveArgs,
): Promise<VisualTokenReservation | null> {
  return reserveLedgerTokens(pool, "image", args);
}

/** Admit a text-only model call against fleet, fleet-user, persona, and persona-user. */
export async function reserveTextTokens(
  pool: pg.Pool,
  args: ReserveArgs,
): Promise<TextTokenReservation | null> {
  return reserveLedgerTokens(pool, "text", args);
}

/** Idempotently refund only the exact still-pending reservation. */
export async function refundVisualTokens(pool: pg.Pool, reservation: VisualTokenReservation): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM token_usage
      WHERE id = $1 AND mention_key = $2 AND public_key = $3 AND phase = 'image_reserve'`,
    [reservation.id, reservation.mentionKey, reservation.publicKey],
  );
  return result.rowCount === 1;
}

/** Release an exact text reservation after the answer failed before settlement. */
export async function releaseTextTokens(pool: pg.Pool, reservation: TextTokenReservation): Promise<boolean> {
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [VISUAL_BUDGET_LOCK]);
    const result = await client.query(
      `DELETE FROM token_usage
        WHERE id = $1 AND mention_key = $2 AND public_key = $3 AND phase = 'token_reserve'`,
      [reservation.id, reservation.mentionKey, reservation.publicKey],
    );
    return result.rowCount === 1;
  });
}

type SettleUsage = {
  phase: string;
  provider?: string;
  model?: string;
  totalTokens?: number | null;
};

async function settleLedgerTokens(
  pool: pg.Pool,
  ledger: LedgerKind,
  reservation: VisualTokenReservation,
  usage: SettleUsage,
  actual: number,
  charged: number,
): Promise<number | null> {
  const { phase } = LEDGER[ledger];
  const invariantPhase = ledger === "image" ? "image_usage_invariant" : "token_usage_invariant";
  const outcome = await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [VISUAL_BUDGET_LOCK]);
    if (actual > reservation.estimatedTokens) {
      const failed = await client.query(
        `UPDATE token_usage
            SET phase = $1,
                provider = $2, model = $3,
                meta_json = COALESCE(meta_json, '{}'::jsonb) ||
                  jsonb_build_object('reported_total_tokens', $4::integer, 'hard_upper_bound', $5::integer)
          WHERE id = $6 AND mention_key = $7 AND public_key = $8 AND phase = $9`,
        [
          invariantPhase,
          usage.provider ?? null,
          usage.model ?? null,
          actual,
          reservation.estimatedTokens,
          reservation.id,
          reservation.mentionKey,
          reservation.publicKey,
          phase,
        ],
      );
      return failed.rowCount === 1 ? "invariant" as const : null;
    }
    const result = await client.query<{ total_tokens: number }>(
      `UPDATE token_usage
          SET phase = $1, provider = $2, model = $3, total_tokens = $4,
              meta_json = COALESCE(meta_json, '{}'::jsonb) ||
                jsonb_build_object('reserved_hard_upper_bound', $5::integer)
        WHERE id = $6 AND mention_key = $7 AND public_key = $8 AND phase = $9
        RETURNING total_tokens`,
      [
        usage.phase,
        usage.provider ?? null,
        usage.model ?? null,
        charged,
        reservation.estimatedTokens,
        reservation.id,
        reservation.mentionKey,
        reservation.publicKey,
        phase,
      ],
    );
    return result.rowCount === 1 ? Number(result.rows[0]!.total_tokens) : null;
  });
  if (outcome === "invariant") throw new Error("provider usage exceeded reserved hard upper bound");
  return outcome;
}

/**
 * Idempotently turn the exact reservation row into final usage. Provider usage
 * above the pre-call hard upper bound is an invariant failure and can never
 * enlarge the charge after spend.
 */
export async function settleVisualTokens(
  pool: pg.Pool,
  reservation: VisualTokenReservation,
  usage: SettleUsage,
): Promise<number | null> {
  const actual = Number.isSafeInteger(usage.totalTokens) && (usage.totalTokens ?? 0) > 0
    ? usage.totalTokens!
    : 0;
  return settleLedgerTokens(pool, "image", reservation, usage, actual, actual || reservation.estimatedTokens);
}

/**
 * Settle the exact text reservation on its own UTC reservation day. Reported
 * usage (including zero) is charged; unknown usage keeps the full reservation.
 */
export async function settleTextTokens(
  pool: pg.Pool,
  reservation: TextTokenReservation,
  usage: SettleUsage,
): Promise<number | null> {
  const reported = Number.isSafeInteger(usage.totalTokens) && (usage.totalTokens ?? -1) >= 0;
  const actual = reported ? usage.totalTokens! : 0;
  return settleLedgerTokens(
    pool,
    "text",
    reservation,
    usage,
    actual,
    reported ? actual : reservation.estimatedTokens,
  );
}

export async function cleanStaleVisualReservations(pool: pg.Pool, staleAfterMs: number): Promise<number> {
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [VISUAL_BUDGET_LOCK]);
    return cleanStale(client, staleAfterMs);
  });
}
