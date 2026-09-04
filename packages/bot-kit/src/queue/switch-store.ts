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

export async function killSwitchOn(db: Queryable): Promise<boolean> {
  const r = await db.query("SELECT disabled FROM kill_switch WHERE id = 1");
  return r.rows[0]?.disabled === true;
}

export async function switchOn(db: Queryable, name: SwitchName): Promise<boolean> {
  if (await killSwitchOn(db)) return true;
  const g = await db.query("SELECT on_flag FROM switches WHERE name = 'global'");
  if (g.rows[0]?.on_flag === true) return true;
  const r = await db.query("SELECT on_flag FROM switches WHERE name = $1", [name]);
  return r.rows[0]?.on_flag === true;
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
    return;
  }
  await db.query(
    `INSERT INTO switches (name, on_flag) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET on_flag = EXCLUDED.on_flag, updated_at = now()`,
    [name, on],
  );
  if (name === "consumption" || name === "generation" || name === "replies") {
    if (on) await db.query("UPDATE kill_switch SET disabled = TRUE WHERE id = 1");
  }
}
