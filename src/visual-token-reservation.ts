import type pg from "pg";

const VISUAL_BUDGET_LOCK = 0x4a454249;
const UTC_DAY_START = "(date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')";

export type VisualTokenReservation = {
  id: string;
  mentionKey: string;
  publicKey: string;
  estimatedTokens: number;
};

type ReserveArgs = {
  mentionKey: string;
  publicKey: string;
  targetTokens: number;
  globalCeiling: number;
  userCeiling: number;
  staleAfterMs: number;
  reservation?: VisualTokenReservation;
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

async function lockAndClean(client: pg.PoolClient, staleAfterMs: number): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1)", [VISUAL_BUDGET_LOCK]);
  await client.query(
    `DELETE FROM token_usage
      WHERE phase = 'image_reserve'
        AND created_at < now() - ($1::text || ' milliseconds')::interval`,
    [String(staleAfterMs)],
  );
}

/**
 * Atomically create or resize one exact image reservation. The advisory lock
 * serializes every process for the UTC-day global ceiling; the same transaction
 * checks both global and per-user totals. Existing reservation tokens remain in
 * SUM(total_tokens), so a resize subtracts only this row before adding target.
 */
export async function reserveVisualTokens(
  pool: pg.Pool,
  args: ReserveArgs,
): Promise<VisualTokenReservation | null> {
  if (!Number.isSafeInteger(args.targetTokens) || args.targetTokens <= 0) {
    throw new Error("invalid visual token reservation");
  }
  return transaction(pool, async (client) => {
    await lockAndClean(client, args.staleAfterMs);
    let current = 0;
    let reservationCreatedAt: Date | null = null;
    if (args.reservation) {
      const row = await client.query<{ total_tokens: number | null; created_at: Date }>(
        `SELECT total_tokens, created_at
           FROM token_usage
          WHERE id = $1 AND mention_key = $2 AND public_key = $3 AND phase = 'image_reserve'
          FOR UPDATE`,
        [args.reservation.id, args.mentionKey, args.publicKey],
      );
      if (row.rowCount !== 1) return null;
      current = Number(row.rows[0]?.total_tokens ?? 0);
      reservationCreatedAt = row.rows[0]!.created_at;
    }
    const dayPredicate = reservationCreatedAt
      ? `created_at >= (date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
         AND created_at < (date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') + interval '1 day'`
      : `created_at >= ${UTC_DAY_START}`;
    const totals = await client.query<{ global_total: string; user_total: string }>(
      `SELECT
         COALESCE(SUM(total_tokens), 0)::text AS global_total,
         COALESCE(SUM(total_tokens) FILTER (WHERE public_key = $1), 0)::text AS user_total
       FROM token_usage
       WHERE ${dayPredicate}`,
      reservationCreatedAt ? [args.publicKey, reservationCreatedAt] : [args.publicKey],
    );
    const globalTarget = Number(totals.rows[0]?.global_total ?? 0) - current + args.targetTokens;
    const userTarget = Number(totals.rows[0]?.user_total ?? 0) - current + args.targetTokens;
    if (globalTarget > args.globalCeiling || userTarget > args.userCeiling) return null;
    if (args.reservation) {
      await client.query(
        `UPDATE token_usage SET total_tokens = $1
          WHERE id = $2 AND mention_key = $3 AND public_key = $4 AND phase = 'image_reserve'`,
        [args.targetTokens, args.reservation.id, args.mentionKey, args.publicKey],
      );
      return { ...args.reservation, estimatedTokens: args.targetTokens };
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO token_usage (mention_key, public_key, phase, total_tokens, meta_json)
       VALUES ($1, $2, 'image_reserve', $3, $4::jsonb)
       RETURNING id::text`,
      [
        args.mentionKey,
        args.publicKey,
        args.targetTokens,
        JSON.stringify({ kind: "prospective_visual_tokens", estimate: args.targetTokens }),
      ],
    );
    return {
      id: inserted.rows[0]!.id,
      mentionKey: args.mentionKey,
      publicKey: args.publicKey,
      estimatedTokens: args.targetTokens,
    };
  });
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

/**
 * Idempotently turn the exact reservation row into final usage. Provider usage
 * above the pre-call hard upper bound is an invariant failure and can never
 * enlarge the charge after spend.
 */
export async function settleVisualTokens(
  pool: pg.Pool,
  reservation: VisualTokenReservation,
  usage: {
    phase: string;
    provider?: string;
    model?: string;
    totalTokens?: number | null;
  },
): Promise<number | null> {
  const actual = Number.isSafeInteger(usage.totalTokens) && (usage.totalTokens ?? 0) > 0
    ? usage.totalTokens!
    : 0;
  const charged = actual || reservation.estimatedTokens;
  const outcome = await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [VISUAL_BUDGET_LOCK]);
    if (actual > reservation.estimatedTokens) {
      const failed = await client.query(
        `UPDATE token_usage
            SET phase = 'image_usage_invariant',
                provider = $1, model = $2,
                meta_json = COALESCE(meta_json, '{}'::jsonb) ||
                  jsonb_build_object('reported_total_tokens', $3::integer, 'hard_upper_bound', $4::integer)
          WHERE id = $5 AND mention_key = $6 AND public_key = $7 AND phase = 'image_reserve'`,
        [
          usage.provider ?? null,
          usage.model ?? null,
          actual,
          reservation.estimatedTokens,
          reservation.id,
          reservation.mentionKey,
          reservation.publicKey,
        ],
      );
      return failed.rowCount === 1 ? "invariant" as const : null;
    }
    const result = await client.query<{ total_tokens: number }>(
      `UPDATE token_usage
          SET phase = $1, provider = $2, model = $3, total_tokens = $4,
              meta_json = COALESCE(meta_json, '{}'::jsonb) ||
                jsonb_build_object('reserved_hard_upper_bound', $5::integer)
        WHERE id = $6 AND mention_key = $7 AND public_key = $8 AND phase = 'image_reserve'
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
      ],
    );
    return result.rowCount === 1 ? Number(result.rows[0]!.total_tokens) : null;
  });
  if (outcome === "invariant") throw new Error("provider usage exceeded reserved hard upper bound");
  return outcome;
}

export async function cleanStaleVisualReservations(pool: pg.Pool, staleAfterMs: number): Promise<number> {
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [VISUAL_BUDGET_LOCK]);
    const result = await client.query(
      `DELETE FROM token_usage
        WHERE phase = 'image_reserve'
          AND created_at < now() - ($1::text || ' milliseconds')::interval`,
      [String(staleAfterMs)],
    );
    return result.rowCount ?? 0;
  });
}
