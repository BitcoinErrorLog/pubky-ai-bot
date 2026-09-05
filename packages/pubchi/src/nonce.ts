import type pg from "pg";
import type { NonceStore } from "../pubchi-schemas/index.js";

/**
 * Unique nonce per (bot, asker). The schema `NonceStore` interface only
 * receives (bot, nonce); the factory closes over asker from the request
 * object — never from the hashed body.
 */
export function postgresNonceStore(pool: pg.Pool, asker: string): NonceStore {
  return {
    async consume(bot: string, nonce: string, expiresAt: number): Promise<boolean> {
      const inserted = await pool.query<{ nonce: string }>(
        `INSERT INTO pubchi_nonces (bot, asker, nonce, expires_at)
         VALUES ($1, $2, $3, to_timestamp($4))
         ON CONFLICT (bot, asker, nonce) DO NOTHING
         RETURNING nonce`,
        [bot, asker, nonce, expiresAt],
      );
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
