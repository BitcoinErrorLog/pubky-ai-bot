import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../db.js";
import { configFromProcessEnv, type Config } from "../config.js";
import { runIngest as kitRunIngest, type IngestConfig, type IngestDeps } from "../bot-kit/ingest.js";
import type { Notification } from "../bot-kit/types.js";
import { personaIngestGate } from "../ingest.js";
import { createScoutTools } from "../scout/tools.js";
import { createSearchWebTool } from "../web/tools.js";
import {
  PERSONA_SWITCH_NAMES,
  createPersonaStageGates,
  personaSwitchOn,
  setPersonaSwitch,
  type PersonaStageSwitch,
  type PersonaSwitchName,
} from "./switches.js";
import { createProbePersona, deleteProbePersona } from "../../tests/helpers/probe-persona.js";

const PROBE = "switch-probe";
const STAGES = PERSONA_SWITCH_NAMES.filter((name): name is PersonaStageSwitch => name !== "global");
const INGEST_BOT = "8".repeat(52);

let store: Store;

async function clearSwitches(): Promise<void> {
  await store.pool.query("DELETE FROM persona_switches WHERE persona_id IN ($1, 'jeb')", [PROBE]);
}

async function set(personaId: string, name: PersonaSwitchName, on: boolean): Promise<void> {
  await store.setPersonaSwitch(personaId, name, on, "switch-test");
}

beforeAll(async () => {
  store = new Store(process.env.DATABASE_URL!);
  await store.migrate();
  await createProbePersona(store.pool, PROBE);
  await clearSwitches();
});

afterEach(clearSwitches);

afterAll(async () => {
  await clearSwitches();
  await store.pool.query("DELETE FROM cursor_state WHERE bot_id = $1", [INGEST_BOT]);
  await deleteProbePersona(store.pool, PROBE);
  await store.close();
});

describe("persona switch store helpers", () => {
  it("declares exactly the names the migration CHECK accepts", async () => {
    const check = await store.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.conrelid = 'persona_switches'::regclass AND c.contype = 'c'`,
    );
    const declared = check.rows.map((row) => row.def).join(" ");
    const quoted = [...declared.matchAll(/'([a-z]+)'::text/g)].map((match) => match[1]).sort();
    expect(quoted).toEqual([...PERSONA_SWITCH_NAMES].sort());
  });

  it("reads each stage as global OR that stage, with missing rows off", async () => {
    for (const stage of STAGES) expect(await store.personaSwitchOn(PROBE, stage)).toBe(false);
    for (const stage of STAGES) {
      await set(PROBE, stage, true);
      for (const other of STAGES) {
        expect(await store.personaSwitchOn(PROBE, other), `${stage} on, reading ${other}`).toBe(other === stage);
      }
      await set(PROBE, stage, false);
    }
    await set(PROBE, "global", true);
    for (const stage of STAGES) expect(await store.personaSwitchOn(PROBE, stage)).toBe(true);
    await set(PROBE, "global", false);
    for (const stage of STAGES) expect(await store.personaSwitchOn(PROBE, stage)).toBe(false);
  });

  it("stops only the named persona", async () => {
    await set(PROBE, "global", true);
    for (const stage of STAGES) expect(await store.personaSwitchOn("jeb", stage)).toBe(false);
    await set("jeb", "generation", true);
    expect(await store.personaSwitchOn(PROBE, "generation")).toBe(true);
    expect(await store.personaSwitchOn("jeb", "generation")).toBe(true);
    expect(await store.personaSwitchOn("jeb", "replies")).toBe(false);
  });

  it("records the actor and updates in place", async () => {
    await set(PROBE, "web", true);
    await store.setPersonaSwitch(PROBE, "web", false, "  second-operator  ");
    const rows = await store.pool.query<{ on_flag: boolean; actor: string }>(
      "SELECT on_flag, actor FROM persona_switches WHERE persona_id = $1 AND name = 'web'",
      [PROBE],
    );
    expect(rows.rows).toEqual([{ on_flag: false, actor: "second-operator" }]);
  });

  it("rejects unrecognized names, persona ids, states, and actors before SQL", async () => {
    await expect(setPersonaSwitch(store.pool, PROBE, "consumption" as PersonaSwitchName, true, "t"))
      .rejects.toThrow("unknown persona switch");
    await expect(personaSwitchOn(store.pool, PROBE, "global" as PersonaStageSwitch))
      .rejects.toThrow("unknown persona stage switch");
    await expect(personaSwitchOn(store.pool, PROBE, "feed" as PersonaStageSwitch))
      .rejects.toThrow("unknown persona stage switch");
    await expect(personaSwitchOn(store.pool, "Bad_Id", "web")).rejects.toThrow("invalid persona id");
    await expect(setPersonaSwitch(store.pool, "x'; DROP", "web", true, "t")).rejects.toThrow("invalid persona id");
    await expect(setPersonaSwitch(store.pool, PROBE, "web", "yes" as unknown as boolean, "t"))
      .rejects.toThrow("must be boolean");
    await expect(setPersonaSwitch(store.pool, PROBE, "web", true, "   ")).rejects.toThrow("actor is required");
    await expect(store.pool.query(
      "INSERT INTO persona_switches (persona_id, name, on_flag, actor) VALUES ($1, 'consumption', TRUE, 't')",
      [PROBE],
    )).rejects.toThrow(/check constraint/);
    await expect(set("unregistered-persona", "web", true)).rejects.toThrow(/foreign key/);
  });
});

describe("ingest stage: persona global OR ingest, with the fleet consumption gate", () => {
  type Harness = { stop: () => Promise<void>; polls: () => number; evaluations: () => number; loopStore: Store };

  async function startIngest(
    personaId: string,
    nexusUrl: string,
    notifications: () => Promise<Notification[]> = async () => [],
  ): Promise<Harness> {
    const loopStore = new Store(process.env.DATABASE_URL!);
    const gate = personaIngestGate(personaId);
    let polls = 0;
    let evaluations = 0;
    const cfg: IngestConfig = {
      botPk: INGEST_BOT,
      databaseUrl: process.env.DATABASE_URL!,
      nexusUrl,
      nexusTimeoutMs: 1_000,
      disabledEnv: false,
      maxAgeMinutes: 30,
      workStaleMs: 180_000,
      pollMs: 5,
    };
    const deps: IngestDeps = {
      createStore: () => loopStore,
      createNexus: () => ({
        notifications: async () => {
          polls += 1;
          return notifications();
        },
      }),
      listenHealth: () => {
        throw new Error("health listener is not configured in this test");
      },
      closeServer: async () => undefined,
      envSwitchOn: () => false,
      personaIngestBlocked: async (ingestStore) => {
        const blocked = await gate(ingestStore);
        evaluations += 1;
        return blocked;
      },
      assertNoKeyMaterial: () => undefined,
      incrementMentions: () => undefined,
    };
    const stop = await kitRunIngest(cfg, deps);
    return { stop, polls: () => polls, evaluations: () => evaluations, loopStore };
  }

  async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("ingest harness did not reach the expected state");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  async function clearCursor(nexusUrl: string): Promise<void> {
    await store.pool.query("DELETE FROM cursor_state WHERE bot_id = $1 AND nexus_url = $2", [INGEST_BOT, nexusUrl]);
  }

  for (const name of ["ingest", "global"] as const) {
    it(`persona ${name} stops polling for that persona only`, async () => {
      const probeUrl = `http://ingest-${name}-probe.invalid`;
      const jebUrl = `http://ingest-${name}-jeb.invalid`;
      await set(PROBE, name, true);
      const probe = await startIngest(PROBE, probeUrl);
      const jeb = await startIngest("jeb", jebUrl);
      try {
        await until(() => probe.evaluations() >= 3 && jeb.polls() >= 2);
        expect(probe.polls()).toBe(0);
        await set(PROBE, name, false);
        await until(() => probe.polls() >= 1);
      } finally {
        await probe.stop();
        await jeb.stop();
        await clearCursor(probeUrl);
        await clearCursor(jebUrl);
      }
    });
  }

  it("the fleet consumption switch still stops ingest with persona switches off", async () => {
    const nexusUrl = "http://ingest-fleet.invalid";
    await store.setSwitch("consumption", true);
    const probe = await startIngest(PROBE, nexusUrl);
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(probe.polls()).toBe(0);
      expect(probe.evaluations()).toBe(0);
    } finally {
      await probe.stop();
      await store.setSwitch("consumption", false);
      await store.pool.query("UPDATE kill_switch SET disabled = FALSE WHERE id = 1");
      await clearCursor(nexusUrl);
    }
  });

  it("a switch flipped mid-poll enqueues nothing and holds the cursor below the batch", async () => {
    const nexusUrl = "http://ingest-mid-batch.invalid";
    const now = Date.now();
    const keys = [1, 2].map((i) => `pubky://${"9".repeat(52)}/pub/pubky.app/posts/MIDBATCH0000${i}`);
    const items: Notification[] = keys.map((postUri, i) => ({
      timestamp: now - i,
      body: { type: "mention", post_uri: postUri, mentioned_by: "9".repeat(52) },
    }));
    let served = false;
    const probe = await startIngest(PROBE, nexusUrl, async () => {
      if (served) return [];
      served = true;
      await set(PROBE, "ingest", true);
      return items;
    });
    try {
      await until(() => probe.evaluations() >= 3);
    } finally {
      await probe.stop();
    }
    const handled = await store.pool.query("SELECT 1 FROM handled_mentions WHERE mention_key = ANY($1::text[])", [keys]);
    expect(handled.rowCount).toBe(0);
    const cursor = await store.getCursor(INGEST_BOT, nexusUrl);
    expect(cursor.lastTs).toBe(now - 2);
    await clearCursor(nexusUrl);
  });
});

describe("reason stage gates: generation, scout, web, images, tags", () => {
  it("generation is the fleet gate OR persona global/generation", async () => {
    const gates = createPersonaStageGates(store, PROBE);
    let fleet = false;
    const blocked = gates.generationBlocked(async () => fleet);
    expect(await blocked()).toBe(false);
    fleet = true;
    expect(await blocked()).toBe(true);
    fleet = false;
    for (const name of ["generation", "global"] as const) {
      await set(PROBE, name, true);
      expect(await blocked(), name).toBe(true);
      expect(await createPersonaStageGates(store, "jeb").generationBlocked(async () => false)()).toBe(false);
      await set(PROBE, name, false);
    }
    await set(PROBE, "replies", true);
    expect(await blocked()).toBe(false);
  });

  it("scout and web are the fleet switch OR persona global/stage, and only for that persona", async () => {
    const gates = createPersonaStageGates(store, PROBE);
    const jebGates = createPersonaStageGates(store, "jeb");
    expect(await gates.scoutSwitchOn()).toBe(false);
    expect(await gates.webSwitchOn()).toBe(false);
    await set(PROBE, "scout", true);
    expect(await gates.scoutSwitchOn()).toBe(true);
    expect(await gates.webSwitchOn()).toBe(false);
    expect(await jebGates.scoutSwitchOn()).toBe(false);
    await set(PROBE, "scout", false);
    await set(PROBE, "web", true);
    expect(await gates.webSwitchOn()).toBe(true);
    expect(await gates.scoutSwitchOn()).toBe(false);
    await set(PROBE, "web", false);
    await set(PROBE, "global", true);
    expect(await gates.webSwitchOn()).toBe(true);
    expect(await gates.scoutSwitchOn()).toBe(true);
    await set(PROBE, "global", false);
    await store.setSwitch("web", true);
    try {
      expect(await gates.webSwitchOn()).toBe(true);
      expect(await createPersonaStageGates(store, undefined).webSwitchOn()).toBe(true);
    } finally {
      await store.setSwitch("web", false);
    }
    expect(await createPersonaStageGates(store, undefined).stageOn("images")).toBe(false);
  });

  it("images and tags stages read persona global OR the stage", async () => {
    const gates = createPersonaStageGates(store, PROBE);
    for (const stage of ["images", "tags"] as const) {
      expect(await gates.stageOn(stage)).toBe(false);
      await set(PROBE, stage, true);
      expect(await gates.stageOn(stage)).toBe(true);
      await set(PROBE, stage, false);
      await set(PROBE, "global", true);
      expect(await gates.stageOn(stage)).toBe(true);
      await set(PROBE, "global", false);
    }
  });

  it("the Scout and web tool executors refuse with SWITCH when the persona stage is on", async () => {
    const cfg: Config = {
      ...configFromProcessEnv({ requireSecret: false }),
      scoutEnabled: true,
      webProvider: "kimi",
    };
    const gates = createPersonaStageGates(store, PROBE);
    const scout = createScoutTools({
      cfg,
      pool: store.pool,
      mentionKey: "switch-test:scout",
      storeSwitchOn: gates.scoutSwitchOn,
    });
    const web = createSearchWebTool({
      cfg,
      pool: store.pool,
      mentionKey: "switch-test:web",
      storeSwitchOn: gates.webSwitchOn,
      kimi: async () => {
        throw new Error("web provider must not be called while switched off");
      },
    });
    await set(PROBE, "scout", true);
    await set(PROBE, "web", true);
    expect(await scout.search_posts.execute({ query: "x" })).toMatchObject({ error: "SWITCH" });
    expect(await web.execute({ query: "x" })).toMatchObject({ error: "SWITCH" });
    const rows = await store.pool.query(
      `SELECT 1 FROM scout_queries WHERE mention_key = 'switch-test:scout'
       UNION ALL SELECT 1 FROM web_queries WHERE mention_key = 'switch-test:web'`,
    );
    expect(rows.rowCount).toBe(0);
  });
});
