import { ALL_SWITCHES, type SwitchName } from "../policy/switches.js";
import type { Queryable } from "./ingest-store.js";

/**
 * Queue subset for named kill switches + the legacy kill_switch row.
 * Jeb's Store implements this; SQL lives here so Kit consumers share it.
 */
export interface SwitchStore {
  killSwitchOn(): Promise<boolean>;
  switchOn(name: SwitchName): Promise<boolean>;
  setSwitch(name: SwitchName | "global", on: boolean): Promise<void>;
}

export const SWITCH_CACHE_TTL_MS = 1_500;

type CachedSwitch = { value: boolean; at: number; epoch: number };
const switchCache = new WeakMap<Queryable, Map<string, CachedSwitch>>();
let switchCacheEpoch = 0;

export function clearSwitchCache(): void {
  switchCacheEpoch += 1;
}

export async function killSwitchOn(db: Queryable): Promise<boolean> {
  const r = await db.query("SELECT disabled FROM kill_switch WHERE id = 1");
  return r.rows[0]?.disabled === true;
}

export async function switchOn(
  db: Queryable,
  name: SwitchName,
  opts?: { cacheTtlMs?: number; now?: () => number },
): Promise<boolean> {
  const ttlMs = opts?.cacheTtlMs ?? SWITCH_CACHE_TTL_MS;
  const nowMs = (opts?.now ?? Date.now)();
  const startEpoch = switchCacheEpoch;
  if (ttlMs > 0) {
    const cached = switchCache.get(db)?.get(name);
    if (cached && cached.epoch === startEpoch && nowMs - cached.at < ttlMs) {
      return cached.value;
    }
  }
  const r = await db.query(
    `SELECT
       COALESCE((SELECT disabled FROM kill_switch WHERE id = 1), FALSE) AS legacy_disabled,
       COALESCE((SELECT bool_or(on_flag) FROM switches WHERE name IN ('global', $1)), FALSE) AS switch_on`,
    [name],
  );
  const row = r.rows[0] as { legacy_disabled?: boolean; switch_on?: boolean } | undefined;
  const value = row?.legacy_disabled === true || row?.switch_on === true;
  if (ttlMs > 0 && switchCacheEpoch === startEpoch) {
    let entries = switchCache.get(db);
    if (!entries) {
      entries = new Map();
      switchCache.set(db, entries);
    }
    entries.set(name, { value, at: nowMs, epoch: startEpoch });
  }
  return value;
}

export async function setSwitch(db: Queryable, name: SwitchName | "global", on: boolean): Promise<void> {
  if (name === "global") {
    await db.query(
      `INSERT INTO switches (name, on_flag) VALUES ('global', $1)
         ON CONFLICT (name) DO UPDATE SET on_flag = EXCLUDED.on_flag, updated_at = now()`,
      [on],
    );
    for (const n of ALL_SWITCHES) {
      await db.query(
        `INSERT INTO switches (name, on_flag) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET on_flag = EXCLUDED.on_flag, updated_at = now()`,
        [n, on],
      );
    }
    await db.query("UPDATE kill_switch SET disabled = $1 WHERE id = 1", [on]);
    clearSwitchCache();
    return;
  }
  await db.query(
    `INSERT INTO switches (name, on_flag) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET on_flag = EXCLUDED.on_flag, updated_at = now()`,
    [name, on],
  );
  if (!on && (name === "consumption" || name === "generation" || name === "replies")) {
    await db.query(
      `UPDATE kill_switch
       SET disabled = FALSE
       WHERE id = 1
         AND disabled = TRUE
         AND NOT COALESCE((SELECT bool_or(on_flag) FROM switches WHERE name IN ('global', 'consumption', 'generation', 'replies')), FALSE)`,
    );
  }
  clearSwitchCache();
}
