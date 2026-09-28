import type pg from "pg";
import { envSwitchOn } from "../policy/switches.js";
import type { WebBudgetConfig } from "./web-config.js";
import { WebToolError } from "./error.js";
import { assertCeiling, type PersonaLedgerIdentity } from "../policy/persona-ledger.js";

export interface WebBudgetGate {
  blocked: boolean;
  reason?: string;
  reservationId?: string;
}

export async function webSwitchBlocked(storeSwitchOn: () => Promise<boolean>): Promise<boolean> {
  if (envSwitchOn("web") || envSwitchOn("global")) return true;
  return storeSwitchOn();
}

export async function checkWebBudgets(
  pool: pg.Pool,
  cfg: Pick<WebBudgetConfig, "webPerMentionCap" | "webDailyCeiling">,
  opts: { mentionKey?: string },
): Promise<WebBudgetGate> {
  const day = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
     FROM web_queries
     WHERE created_at >= date_trunc('day', now())
       AND (ok = TRUE OR provider LIKE '%:reserved')`,
  );
  if (Number(day.rows[0]?.n ?? 0) >= cfg.webDailyCeiling) {
    return { blocked: true, reason: "daily_web_ceiling" };
  }
  if (opts.mentionKey) {
    const m = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM web_queries WHERE mention_key = $1`,
      [opts.mentionKey],
    );
    if (Number(m.rows[0]?.n ?? 0) >= cfg.webPerMentionCap) {
      return { blocked: true, reason: "per_mention_web_cap" };
    }
  }
  return { blocked: false };
}

/** Persona web layer; admitted in the same transaction as the fleet web layer. */
export type WebPersonaBudget = {
  identity: PersonaLedgerIdentity;
  dailyCeiling: number;
};

export async function reserveWebCall(
  pool: pg.Pool,
  cfg: Pick<WebBudgetConfig, "webPerMentionCap" | "webDailyCeiling">,
  opts: { mentionKey?: string; provider: string; queryHash: string; persona?: WebPersonaBudget },
): Promise<WebBudgetGate> {
  if (opts.persona) assertCeiling(opts.persona.dailyCeiling, "persona web ceiling");
  if (typeof pool.connect !== "function") {
    if (opts.persona) return { blocked: true, reason: "budgets_unavailable" };
    return checkWebBudgets(pool, cfg, opts);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["web_search_budget"]);
    const gate = await checkWebBudgets(client as unknown as pg.Pool, cfg, opts);
    if (gate.blocked) {
      await client.query("ROLLBACK");
      return gate;
    }
    if (opts.persona) {
      const persona = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM web_queries
         WHERE persona_id = $1
           AND created_at >= date_trunc('day', now())
           AND (ok = TRUE OR provider LIKE '%:reserved')`,
        [opts.persona.identity.id],
      );
      if (Number(persona.rows[0]?.n ?? 0) >= opts.persona.dailyCeiling) {
        await client.query("ROLLBACK");
        return { blocked: true, reason: "persona_daily_web_ceiling" };
      }
    }
    const inserted = opts.persona
      ? await client.query<{ id: string }>(
          `INSERT INTO web_queries (
             provider, query_hash, ok, sources_count, duration_ms, mention_key,
             persona_id, persona_version, persona_manifest_hash, target_bot_pk
           )
           VALUES ($1, $2, FALSE, 0, 0, $3, $4, $5, $6, $7)
           RETURNING id::text`,
          [
            `${opts.provider}:reserved`,
            opts.queryHash,
            opts.mentionKey ?? null,
            opts.persona.identity.id,
            opts.persona.identity.version,
            opts.persona.identity.manifestHash,
            opts.persona.identity.botPk,
          ],
        )
      : await client.query<{ id: string }>(
          `INSERT INTO web_queries (provider, query_hash, ok, sources_count, duration_ms, mention_key)
           VALUES ($1, $2, FALSE, 0, 0, $3)
           RETURNING id::text`,
          [`${opts.provider}:reserved`, opts.queryHash, opts.mentionKey ?? null],
        );
    await client.query("COMMIT");
    const reservationId = inserted.rows[0]?.id;
    if (!reservationId) throw new Error("web budget reservation missing id");
    return { blocked: false, reservationId };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original reservation failure remains authoritative.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizeWebCall(
  pool: pg.Pool,
  reservationId: string,
  row: { provider: string; ok: boolean; sourcesCount: number; durationMs: number },
): Promise<void> {
  await pool.query(
    `UPDATE web_queries
     SET provider = $2, ok = $3, sources_count = $4, duration_ms = $5
     WHERE id = $1`,
    [reservationId, row.provider, row.ok, row.sourcesCount, row.durationMs],
  );
}

export function webBudgetError(reason: string): WebToolError {
  return new WebToolError("BUDGET", `web search unavailable (${reason})`);
}
