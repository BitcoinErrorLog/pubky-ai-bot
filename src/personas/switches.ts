import type pg from "pg";

/** Must match the `persona_switches.name` CHECK in migration 110. */
export const PERSONA_SWITCH_NAMES = [
  "global",
  "ingest",
  "generation",
  "replies",
  "web",
  "scout",
  "images",
  "tags",
] as const;

export type PersonaSwitchName = (typeof PERSONA_SWITCH_NAMES)[number];
export type PersonaStageSwitch = Exclude<PersonaSwitchName, "global">;

type Queryable = Pick<pg.Pool, "query">;

const PERSONA_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isPersonaSwitchName(name: string): name is PersonaSwitchName {
  return (PERSONA_SWITCH_NAMES as readonly string[]).includes(name);
}

function assertPersonaId(personaId: string): void {
  if (!PERSONA_ID.test(personaId)) throw new Error("invalid persona id");
}

/**
 * True when this persona's `global` row or its stage row is on. Only the named
 * persona is consulted; a missing row is off.
 */
export async function personaSwitchOn(
  db: Queryable,
  personaId: string,
  stage: PersonaStageSwitch,
): Promise<boolean> {
  assertPersonaId(personaId);
  if (stage === ("global" as string) || !isPersonaSwitchName(stage)) {
    throw new Error(`unknown persona stage switch: ${String(stage)}`);
  }
  const result = await db.query<{ on: boolean | null }>(
    `SELECT bool_or(on_flag) AS on
       FROM persona_switches
      WHERE persona_id = $1 AND name IN ('global', $2)`,
    [personaId, stage],
  );
  return result.rows[0]?.on === true;
}

export type PersonaGateStore = {
  switchOn(name: "scout" | "web"): Promise<boolean>;
  personaSwitchOn(personaId: string, stage: PersonaStageSwitch): Promise<boolean>;
};

/**
 * Reason-stage gates for one persona. Every gate re-reads Postgres on each
 * call; each is the fleet gate OR the persona `global`/stage switch. Without a
 * persona only the fleet gates apply.
 */
export function createPersonaStageGates(store: PersonaGateStore, personaId: string | undefined) {
  const stageOn = async (stage: PersonaStageSwitch): Promise<boolean> =>
    personaId ? store.personaSwitchOn(personaId, stage) : false;
  return {
    stageOn,
    generationBlocked:
      (fleetBlocked?: () => Promise<boolean>) =>
      async (): Promise<boolean> =>
        (fleetBlocked ? await fleetBlocked() : false) || (await stageOn("generation")),
    scoutSwitchOn: async (): Promise<boolean> => (await store.switchOn("scout")) || (await stageOn("scout")),
    webSwitchOn: async (): Promise<boolean> => (await store.switchOn("web")) || (await stageOn("web")),
  };
}

export async function setPersonaSwitch(
  db: Queryable,
  personaId: string,
  name: PersonaSwitchName,
  on: boolean,
  actor: string,
): Promise<void> {
  assertPersonaId(personaId);
  if (!isPersonaSwitchName(name)) throw new Error(`unknown persona switch: ${String(name)}`);
  if (typeof on !== "boolean") throw new Error("persona switch state must be boolean");
  const who = actor.trim();
  if (!who) throw new Error("persona switch actor is required");
  await db.query(
    `INSERT INTO persona_switches (persona_id, name, on_flag, actor)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (persona_id, name) DO UPDATE
       SET on_flag = EXCLUDED.on_flag, actor = EXCLUDED.actor, updated_at = now()`,
    [personaId, name, on, who.slice(0, 200)],
  );
}
