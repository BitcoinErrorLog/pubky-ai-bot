import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { CLOCK_SKEW_SECONDS } from "@pubky/pubchi-schemas";
import { NONCE_RETENTION_SECONDS, postgresNonceStore, sweepExpiredNonces } from "./nonce.js";

const pgUrl = process.env.DATABASE_URL?.trim() || "postgres://johncarvalho@127.0.0.1:5432/jeb_pubchi_w3";

describe("pubchi_nonces cleanup", () => {
  const pool = new pg.Pool({ connectionString: pgUrl });
  afterAll(async () => {
    await pool.end();
  });

  it("retains a nonce inside the verifier skew window and rejects its replay", async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pubchi_nonces (
        bot TEXT NOT NULL,
        asker TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (bot, asker, nonce)
      )
    `);
    const bot = "k1noncebot".padEnd(52, "b");
    const asker = "k1nonceask".padEnd(52, "a");
    const nonce = "ab".repeat(32);
    await pool.query(
      `INSERT INTO pubchi_nonces (bot, asker, nonce, expires_at)
       VALUES ($1, $2, $3, now() - interval '60.5 seconds')
       ON CONFLICT (bot, asker, nonce) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [bot, asker, nonce],
    );
    const deleted = await sweepExpiredNonces(pool);
    expect(deleted).toBe(0);
    const left = await pool.query(
      `SELECT 1 FROM pubchi_nonces WHERE bot = $1 AND asker = $2 AND nonce = $3`,
      [bot, asker, nonce],
    );
    expect(left.rowCount).toBe(1);
    const replay = await postgresNonceStore(pool, asker).consume(bot, nonce, Math.floor(Date.now() / 1000) - 10);
    expect(replay).toBe(false);
  });

  it("sweeps a nonce older than the accepted expiry window", async () => {
    const bot = "k1noncebot".padEnd(52, "b");
    const asker = "k1nonceask".padEnd(52, "a");
    const nonce = "ac".repeat(32);
    await pool.query(
      `INSERT INTO pubchi_nonces (bot, asker, nonce, expires_at)
       VALUES ($1, $2, $3, now() - interval '62 seconds')
       ON CONFLICT (bot, asker, nonce) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [bot, asker, nonce],
    );
    const deleted = await sweepExpiredNonces(pool);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(
      (await pool.query(`SELECT 1 FROM pubchi_nonces WHERE bot = $1 AND asker = $2 AND nonce = $3`, [bot, asker, nonce])).rowCount,
    ).toBe(0);
  });

  it("uses the verifier clock-skew tolerance as nonce retention", () => {
    expect(NONCE_RETENTION_SECONDS).toBe(CLOCK_SKEW_SECONDS);
  });

  it("delete-on-insert still consumes a fresh nonce", async () => {
    const store = postgresNonceStore(pool, "k1nonceask".padEnd(52, "a"));
    const nonce = "cd".repeat(32);
    const first = await store.consume("k1noncebot".padEnd(52, "b"), nonce, Math.floor(Date.now() / 1000) + 600);
    expect(first).toBe(true);
    const replay = await store.consume("k1noncebot".padEnd(52, "b"), nonce, Math.floor(Date.now() / 1000) + 600);
    expect(replay).toBe(false);
    await pool.query(`DELETE FROM pubchi_nonces WHERE nonce = $1`, [nonce]);
  });
});
