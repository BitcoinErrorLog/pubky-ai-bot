import type pg from "pg";
import { CLOCK_SKEW_SECONDS, type NonceStore } from "../pubchi-schemas/index.js";

export const NONCE_CLEANUP_EVERY = 32;
export const NONCE_RETENTION_SECONDS = CLOCK_SKEW_SECONDS;

export async function sweepExpiredNonces(pool: Pick<pg.Pool, "query">): Promise<number> {
  const deleted = await pool.query(
    `DELETE FROM pubchi_nonces WHERE expires_at < now() - ($1 * interval '1 second')`,
    [NONCE_RETENTION_SECONDS],
  );
  return deleted.rowCount ?? 0;
}

/**
 * Unique nonce per (bot, asker). The schema `NonceStore` interface only
 * receives (bot, nonce); the factory closes over asker from the request
 * object — never from the hashed body.
 */
export function postgresNonceStore(pool: Pick<pg.Pool, "query">, asker: string): NonceStore {
  let inserts = 0;
  return {
    async consume(bot: string, nonce: string, expiresAt: number): Promise<boolean> {
      const inserted = await pool.query<{ nonce: string }>(
        `INSERT INTO pubchi_nonces (bot, asker, nonce, expires_at)
         VALUES ($1, $2, $3, to_timestamp($4))
         ON CONFLICT (bot, asker, nonce) DO NOTHING
         RETURNING nonce`,
        [bot, asker, nonce, expiresAt],
      );
      inserts += 1;
      if (inserts % NONCE_CLEANUP_EVERY === 0) {
        await sweepExpiredNonces(pool);
      }
      return inserted.rows.length === 1;
    },
  };
}

export function nonceStoreForAsker(
  factory: (asker: string) => NonceStore,
  asker: string,
): NonceStore {
  return factory(asker);
}
