import { createHash } from "node:crypto";
import type pg from "pg";
import type { PersonaLedgerIdentity } from "../../src/bot-kit/policy/persona-ledger.js";

const Z_BASE32 = "ybndrfg8ejkmcpqxot1uwisza345h769";

/**
 * Registered second persona for isolation tests. `personas` and
 * `persona_versions` reference each other without deferral, so both rows are
 * written and removed in one statement.
 */
export function probePersonaIdentity(id: string): PersonaLedgerIdentity {
  const digest = createHash("sha256").update(`probe-persona:${id}`).digest();
  const botPk = Array.from({ length: 52 }, (_, i) => Z_BASE32[digest[i % digest.length]! % 32]).join("");
  return {
    id,
    version: "1.0.0",
    manifestHash: createHash("sha256").update(`probe-persona-manifest:${id}`).digest("hex"),
    botPk,
  };
}

export async function createProbePersona(pool: pg.Pool, id: string): Promise<PersonaLedgerIdentity> {
  const identity = probePersonaIdentity(id);
  await deleteProbePersona(pool, id);
  await pool.query(
    `WITH persona AS (
       INSERT INTO personas (id, current_version, bot_pk, enabled, manifest_hash)
       VALUES ($1, $2, $3, TRUE, $4)
       RETURNING id
     )
     INSERT INTO persona_versions (
       persona_id, version, manifest_hash, profile_json, capability_json,
       budget_json, tag_json, corpus_namespace, status, reviewed_at
     )
     SELECT id, $2, $4, '{}'::jsonb, '{"allow":[]}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'global', 'active', now()
       FROM persona`,
    [identity.id, identity.version, identity.botPk, identity.manifestHash],
  );
  return identity;
}

/** Callers remove the probe's ledger rows first; this removes its switches and registry rows. */
export async function deleteProbePersona(pool: pg.Pool, id: string): Promise<void> {
  await pool.query("DELETE FROM persona_switches WHERE persona_id = $1", [id]);
  await pool.query(
    `WITH versions AS (DELETE FROM persona_versions WHERE persona_id = $1)
     DELETE FROM personas WHERE id = $1`,
    [id],
  );
}

export async function currentPersonaIdentity(pool: pg.Pool, id: string): Promise<PersonaLedgerIdentity> {
  const result = await pool.query<{ current_version: string; manifest_hash: string; bot_pk: string }>(
    "SELECT current_version, manifest_hash, bot_pk FROM personas WHERE id = $1",
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`persona ${id} is not registered`);
  return { id, version: row.current_version, manifestHash: row.manifest_hash, botPk: row.bot_pk };
}
