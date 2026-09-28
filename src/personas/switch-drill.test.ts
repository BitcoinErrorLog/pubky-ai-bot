import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "../db.js";
import { DEFAULT_POLL_MS } from "../config.js";
import { runIngest as kitRunIngest } from "../bot-kit/ingest.js";
import { REASON_TICK_MS, runReasonLoop } from "../bot-kit/queue/reason-loop.js";
import { PUBLISH_TICK_MS, runPublish as kitRunPublish } from "../bot-kit/publish/publisher.js";
import type { Transport } from "../homeserver.js";
import { personaIngestGate } from "../ingest.js";
import { createRunPublishHooks } from "../publish.js";
import { loadRuntimePersona } from "./runtime.js";
import { createPersonaStageGates, type PersonaSwitchName } from "./switches.js";
import { createProbePersona, deleteProbePersona } from "../../tests/helpers/probe-persona.js";

/** Stage 1 gate: a switch takes effect on every write path within one minute. */
const OBSERVATION_DEADLINE_MS = 60_000;
const PROBE = "drill-probe";
const DRILL_BOT = "7".repeat(52);
const DRILL_NEXUS = "http://persona-switch-drill.invalid";

let store: Store;

/**
 * Loop timers are fake, so virtual time advances instantly; Postgres I/O stays
 * real. Each loop reschedules itself with its production interval only after
 * a tick finishes, so counting those reschedules tells exactly when one tick
 * (including its switch read) has completed.
 */
function countReschedules(intervalMs: number): { count: () => number; restore: () => void } {
  const fakeSetTimeout = globalThis.setTimeout;
  let count = 0;
  globalThis.setTimeout = ((handler: () => void, timeout?: number, ...args: unknown[]) => {
    if (timeout === intervalMs) count += 1;
    return fakeSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;
  return {
    count: () => count,
    restore: () => {
      globalThis.setTimeout = fakeSetTimeout;
    },
  };
}

async function settle(condition: () => boolean, label: string): Promise<void> {
  const wallDeadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > wallDeadline) throw new Error(`drill tick did not complete: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

type DrillLoop = {
  label: string;
  intervalMs: number;
  start: () => Promise<() => Promise<void>>;
  flip: (on: boolean) => Promise<void>;
  /** Count of guarded actions; every unblocked tick performs one. */
  actions: () => number;
};

type DrillResult = { effectMs: number; recoverMs: number; actionsWhileOn: number };

async function drill(loop: DrillLoop): Promise<DrillResult> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const reschedules = countReschedules(loop.intervalMs);
  let stop: (() => Promise<void>) | null = null;
  try {
    stop = await loop.start();
    await settle(() => reschedules.count() >= 1, `${loop.label} first tick`);
    expect(loop.actions(), `${loop.label} acts while its switches are off`).toBeGreaterThan(0);

    const tick = async (): Promise<void> => {
      const before = reschedules.count();
      await vi.advanceTimersByTimeAsync(loop.intervalMs);
      await settle(() => reschedules.count() > before, loop.label);
    };

    await loop.flip(true);
    const actionsAtFlip = loop.actions();
    let effectMs = -1;
    let elapsed = 0;
    while (elapsed < OBSERVATION_DEADLINE_MS) {
      const before = loop.actions();
      await tick();
      elapsed += loop.intervalMs;
      if (loop.actions() === before) {
        effectMs = elapsed;
        break;
      }
    }
    for (let held = 0; held < 5; held += 1) await tick();
    const actionsWhileOn = loop.actions() - actionsAtFlip;

    await loop.flip(false);
    let recoverMs = -1;
    elapsed = 0;
    while (elapsed < OBSERVATION_DEADLINE_MS) {
      const before = loop.actions();
      await tick();
      elapsed += loop.intervalMs;
      if (loop.actions() > before) {
        recoverMs = elapsed;
        break;
      }
    }
    return { effectMs, recoverMs, actionsWhileOn };
  } finally {
    reschedules.restore();
    vi.useRealTimers();
    if (stop) await stop();
  }
}

function expectWithinDeadline(result: DrillResult, intervalMs: number): void {
  expect(intervalMs).toBeLessThanOrEqual(OBSERVATION_DEADLINE_MS);
  expect(result.effectMs).toBeGreaterThan(0);
  expect(result.effectMs).toBeLessThanOrEqual(Math.min(intervalMs, OBSERVATION_DEADLINE_MS));
  expect(result.actionsWhileOn).toBe(0);
  expect(result.recoverMs).toBeGreaterThan(0);
  expect(result.recoverMs).toBeLessThanOrEqual(Math.min(intervalMs, OBSERVATION_DEADLINE_MS));
}

async function flipper(personaId: string, name: PersonaSwitchName): Promise<(on: boolean) => Promise<void>> {
  return async (on) => store.setPersonaSwitch(personaId, name, on, "persona-switch-drill");
}

beforeAll(async () => {
  store = new Store(process.env.DATABASE_URL!);
  await store.migrate();
  await createProbePersona(store.pool, PROBE);
});

afterEach(async () => {
  await store.pool.query("DELETE FROM persona_switches WHERE persona_id IN ($1, 'jeb')", [PROBE]);
});

afterAll(async () => {
  await store.pool.query("DELETE FROM cursor_state WHERE bot_id = $1", [DRILL_BOT]);
  await deleteProbePersona(store.pool, PROBE);
  await store.close();
});

describe("persona switch drill: observed within 60 s at production cadence", () => {
  for (const name of ["ingest", "global"] as const) {
    it(`ingest stops polling on persona ${name} within one ${DEFAULT_POLL_MS} ms poll`, async () => {
      let polls = 0;
      const result = await drill({
        label: `ingest/${name}`,
        intervalMs: DEFAULT_POLL_MS,
        start: () => kitRunIngest(
          {
            botPk: DRILL_BOT,
            databaseUrl: process.env.DATABASE_URL!,
            nexusUrl: DRILL_NEXUS,
            nexusTimeoutMs: 1_000,
            disabledEnv: false,
            maxAgeMinutes: 30,
            workStaleMs: 180_000,
            pollMs: DEFAULT_POLL_MS,
          },
          {
            createStore: (url) => new Store(url),
            createNexus: () => ({
              notifications: async () => {
                polls += 1;
                return [];
              },
            }),
            listenHealth: () => {
              throw new Error("health listener is not configured in the drill");
            },
            closeServer: async () => undefined,
            envSwitchOn: () => false,
            personaIngestBlocked: personaIngestGate(PROBE),
            assertNoKeyMaterial: () => undefined,
            incrementMentions: () => undefined,
          },
        ),
        flip: await flipper(PROBE, name),
        actions: () => polls,
      });
      expectWithinDeadline(result, DEFAULT_POLL_MS);
    });
  }

  for (const name of ["generation", "global"] as const) {
    it(`reason stops claiming on persona ${name} within one ${REASON_TICK_MS} ms tick`, async () => {
      const loopStore = new Store(process.env.DATABASE_URL!);
      let claims = 0;
      const claimWork = loopStore.claimWork.bind(loopStore);
      loopStore.claimWork = async (personaId) => {
        claims += 1;
        return claimWork(personaId);
      };
      const claimBlocked = createPersonaStageGates(loopStore, PROBE)
        .generationBlocked(async () => loopStore.switchOn("generation"));
      try {
        const result = await drill({
          label: `reason/${name}`,
          intervalMs: REASON_TICK_MS,
          start: () => runReasonLoop({
            store: loopStore,
            handle: async () => {
              throw new Error("the drill persona has no queued work");
            },
            workStaleMs: 1_000_000_000,
            workMaxAttempts: 3,
            concurrency: 1,
            shouldClaim: async () => !(await claimBlocked()),
            personaId: PROBE,
          }),
          flip: await flipper(PROBE, name),
          actions: () => claims,
        });
        expectWithinDeadline(result, REASON_TICK_MS);
      } finally {
        await loopStore.close();
      }
    });
  }

  for (const name of ["replies", "global"] as const) {
    it(`publish stops claiming on persona ${name} within one ${PUBLISH_TICK_MS} ms tick`, async () => {
      const persona = loadRuntimePersona({ appUrl: "https://pubky.app" });
      const loopStore = new Store(process.env.DATABASE_URL!);
      let claims = 0;
      loopStore.claimPublish = async () => {
        claims += 1;
        return null;
      };
      loopStore.failExhaustedPublishes = async () => 0;
      loopStore.failExhaustedArtifactTags = async () => 0;
      loopStore.claimPendingTags = async () => null;
      loopStore.claimPendingArtifactTag = async () => null;
      const unexpected = async (): Promise<never> => {
        throw new Error("the drill publishes nothing");
      };
      const transport = {
        botPk: DRILL_BOT,
        putJson: unexpected,
        putBytes: unexpected,
        getJson: unexpected,
        listPosts: unexpected,
        deleteJson: unexpected,
        reauth: unexpected,
      } as unknown as Transport;
      const result = await drill({
        label: `publish/${name}`,
        intervalMs: PUBLISH_TICK_MS,
        start: () => kitRunPublish(
          { databaseUrl: process.env.DATABASE_URL!, disabledEnv: false, maxPublishAttempts: 5, selfTags: true },
          {
            createStore: () => loopStore,
            listenHealth: () => {
              throw new Error("health listener is not configured in the drill");
            },
            listenAdmin: () => {
              throw new Error("admin listener is not configured in the drill");
            },
            closeServer: async () => undefined,
            hooks: createRunPublishHooks(() => loopStore, persona),
            transport,
          },
        ),
        flip: await flipper(persona.snapshot.pack.id, name),
        actions: () => claims,
      });
      expectWithinDeadline(result, PUBLISH_TICK_MS);
    });
  }
});
