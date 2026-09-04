import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "../src/db.js";
import type { Config } from "../src/config.js";
import {
  BaselineError,
  DbSwitchController,
  DrillTimeoutError,
  FakeClock,
  IngestHealthProbe,
  ProbeViolationError,
  PublishRefusalProbe,
  ScoutToolProbe,
  WebToolProbe,
  WorkSuppressionProbe,
  assertBaselineClean,
  buildJsonReport,
  drillOne,
  drillPostUri,
  executeDrill,
  formatTable,
  outcomeError,
  parseArgs,
  waitFor,
  type DrillOptions,
  type DrillResult,
  type DrillSwitchName,
  type FetchFn,
  type Probe,
  type Querier,
  type SwitchController,
  type SwitchSnapshot,
} from "./killswitch-drill.js";

/* ------------------------------------------------------------- fakes */

class FakeController implements SwitchController {
  sets: Array<[DrillSwitchName, boolean]> = [];
  restores = 0;
  constructor(public snap: SwitchSnapshot = { switches: {}, killSwitch: false }) {}
  async snapshot(): Promise<SwitchSnapshot> {
    return this.snap;
  }
  async set(name: DrillSwitchName, on: boolean): Promise<void> {
    this.sets.push([name, on]);
  }
  async restore(): Promise<void> {
    this.restores++;
  }
}

class ScriptedProbe implements Probe {
  calls: string[] = [];
  cleaned = false;
  constructor(
    private readonly clock: FakeClock,
    private readonly effectAt: number | null,
    private readonly recoverAt: number | null,
    private readonly violateAt?: number,
  ) {}
  async arm(): Promise<void> {
    this.calls.push("arm");
  }
  async effect(): Promise<boolean> {
    this.calls.push("effect");
    if (this.violateAt !== undefined && this.clock.now() >= this.violateAt) {
      throw new ProbeViolationError("counter-evidence");
    }
    return this.effectAt !== null && this.clock.now() >= this.effectAt;
  }
  async recovered(): Promise<boolean> {
    this.calls.push("recovered");
    return this.recoverAt !== null && this.clock.now() >= this.recoverAt;
  }
  async cleanup(): Promise<void> {
    this.cleaned = true;
  }
}

function fakeQuerier(handler: (text: string, params?: unknown[]) => Array<Record<string, unknown>>): Querier {
  return {
    query: (text, params) => Promise.resolve({ rows: handler(text, params) }),
  };
}

/* ------------------------------------------------------------- unit */

describe("parseArgs", () => {
  const env = { DATABASE_URL: "postgres://u@127.0.0.1:5432/jeb" } as NodeJS.ProcessEnv;

  it("defaults to all switches, 60 s deadline, local target", () => {
    const args = parseArgs(["--health-port", "9000"], env);
    expect(args.only).toEqual(["global", "replies", "generation", "consumption", "scout", "web", "proactive"]);
    expect(args.deadlineMs).toBe(60_000);
    expect(args.target).toBe("local");
    expect(args.json).toBe(false);
    expect(args.healthUrl).toBe("http://127.0.0.1:9000/healthz");
  });

  it("--only selects switches and skips the health-url requirement", () => {
    const args = parseArgs(["--only", "web", "--only", "scout,replies"], env);
    expect(args.only).toEqual(["web", "scout", "replies"]);
  });

  it("rejects unknown switch names and flags", () => {
    expect(() => parseArgs(["--only", "bogus"], env)).toThrow(/unknown switch/);
    expect(() => parseArgs(["--bogus"], env)).toThrow(/unknown flag/);
  });

  it("requires DATABASE_URL", () => {
    expect(() => parseArgs(["--only", "web"], {} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it("refuses non-loopback databases without --target railway", () => {
    const remote = { DATABASE_URL: "postgres://u@db.internal:5432/jeb" } as NodeJS.ProcessEnv;
    expect(() => parseArgs(["--only", "web"], remote)).toThrow(/non-loopback/);
    const args = parseArgs(["--only", "web", "--target", "railway"], remote);
    expect(args.target).toBe("railway");
  });

  it("requires --health-url for consumption", () => {
    expect(() => parseArgs(["--only", "consumption"], env)).toThrow(/health-url/);
  });
});

describe("waitFor", () => {
  it("returns elapsed time when the check turns true", async () => {
    const clock = new FakeClock();
    const ms = await waitFor(async () => clock.now() >= 700, clock, 5_000, 250);
    expect(ms).toBe(750);
  });

  it("throws DrillTimeoutError at the deadline", async () => {
    const clock = new FakeClock();
    await expect(waitFor(async () => false, clock, 1_000, 250)).rejects.toThrow(DrillTimeoutError);
    await expect(waitFor(async () => false, new FakeClock(), 60_000, 250)).rejects.toThrow(/60000/);
  });
});

describe("baseline guard", () => {
  it("accepts an all-off snapshot", () => {
    expect(() => assertBaselineClean({ switches: { replies: false }, killSwitch: false })).not.toThrow();
  });
  it("rejects any on switch or kill_switch", () => {
    expect(() => assertBaselineClean({ switches: { scout: true }, killSwitch: false })).toThrow(BaselineError);
    expect(() => assertBaselineClean({ switches: {}, killSwitch: true })).toThrow(/kill_switch/);
  });
});

describe("drillOne", () => {
  const opts = (
    controller: FakeController,
    probe: Probe,
    clock: FakeClock,
  ): DrillOptions => ({
    controller,
    probes: { replies: probe },
    clock,
    deadlineMs: 60_000,
    intervalMs: 250,
  });
  const snap: SwitchSnapshot = { switches: {}, killSwitch: false };

  it("happy path: flip on, observe, restore, recover, cleanup", async () => {
    const clock = new FakeClock();
    const controller = new FakeController();
    // effect at t=500 (3rd poll), recovery at t=750 (250 ms after restore)
    const probe = new ScriptedProbe(clock, 500, 750);
    const r = await drillOne("replies", opts(controller, probe, clock), snap);
    expect(r.ok).toBe(true);
    expect(r.effectMs).toBe(500);
    expect(r.recoverMs).toBe(250);
    expect(controller.sets).toEqual([["replies", true]]);
    expect(controller.restores).toBe(1);
    expect(probe.cleaned).toBe(true);
    expect(probe.calls[0]).toBe("arm");
  });

  it("effect timeout: fails, restores, cleans up", async () => {
    const clock = new FakeClock();
    const controller = new FakeController();
    const probe = new ScriptedProbe(clock, null, 0);
    const r = await drillOne("replies", opts(controller, probe, clock), snap);
    expect(r.ok).toBe(false);
    expect(r.effectMs).toBeNull();
    expect(r.error).toMatch(/60000/);
    expect(controller.restores).toBe(1);
    expect(probe.cleaned).toBe(true);
  });

  it("recovery timeout: effect recorded, recovery null", async () => {
    const clock = new FakeClock();
    const controller = new FakeController();
    const probe = new ScriptedProbe(clock, 0, null);
    const r = await drillOne("replies", opts(controller, probe, clock), snap);
    expect(r.ok).toBe(false);
    expect(r.effectMs).toBe(0);
    expect(r.recoverMs).toBeNull();
  });

  it("waits for a recovering baseline before flipping", async () => {
    const clock = new FakeClock();
    const controller = new FakeController();
    class PreflightProbe extends ScriptedProbe {
      async preflight(): Promise<boolean> {
        return clock.now() >= 1_000;
      }
    }
    const probe = new PreflightProbe(clock, 0, 0);
    const r = await drillOne("replies", opts(controller, probe, clock), snap);
    expect(r.ok).toBe(true);
    expect(clock.now()).toBeGreaterThanOrEqual(1_000);
  });

  it("a baseline that never recovers aborts without flipping", async () => {
    const clock = new FakeClock();
    const controller = new FakeController();
    class SickProbe extends ScriptedProbe {
      async preflight(): Promise<boolean> {
        return false;
      }
    }
    const probe = new SickProbe(clock, 0, 0);
    const r = await drillOne("replies", opts(controller, probe, clock), snap);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/baseline/);
    expect(controller.sets).toEqual([]);
  });

  it("probe violation fails immediately, before the deadline", async () => {
    const clock = new FakeClock();
    const controller = new FakeController();
    const probe = new ScriptedProbe(clock, 30_000, 0, 1_000);
    const r = await drillOne("replies", opts(controller, probe, clock), snap);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/counter-evidence/);
    expect(clock.now()).toBeLessThan(60_000);
  });
});

describe("executeDrill", () => {
  it("fails fast on a dirty baseline without flipping anything", async () => {
    const controller = new FakeController({ switches: { web: true }, killSwitch: false });
    const clock = new FakeClock();
    await expect(
      executeDrill(
        ["web"],
        { controller, probes: { web: new ScriptedProbe(clock, 0, 0) }, clock, deadlineMs: 1000, intervalMs: 100 },
        controller.snap,
      ),
    ).rejects.toThrow(BaselineError);
    expect(controller.sets).toEqual([]);
  });

  it("runs switches in order and reports per-switch results", async () => {
    const controller = new FakeController();
    const clock = new FakeClock();
    const probes: Partial<Record<DrillSwitchName, Probe>> = {
      scout: new ScriptedProbe(clock, 0, 0),
      web: new ScriptedProbe(clock, null, 0),
    };
    const results = await executeDrill(
      ["scout", "web"],
      { controller, probes, clock, deadlineMs: 1_000, intervalMs: 100 },
      controller.snap,
    );
    expect(results.map((r) => r.switch)).toEqual(["scout", "web"]);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(controller.sets).toEqual([
      ["scout", true],
      ["web", true],
    ]);
  });
});

describe("WorkSuppressionProbe", () => {
  it("confirms suppression only after the full window with the row queued", async () => {
    const clock = new FakeClock();
    const db = fakeQuerier(() => [{ status: "queued" }]);
    const probe = new WorkSuppressionProbe(db, clock, 10_000, 1);
    await probe.arm();
    expect(await probe.effect()).toBe(false);
    await clock.sleep(9_000);
    expect(await probe.effect()).toBe(false);
    await clock.sleep(1_000);
    expect(await probe.effect()).toBe(true);
    await probe.cleanup();
  });

  it("a claim while the switch is on is counter-evidence", async () => {
    const clock = new FakeClock();
    const db = fakeQuerier(() => [{ status: "claimed" }]);
    const probe = new WorkSuppressionProbe(db, clock, 10_000, 1);
    await probe.arm();
    await expect(probe.effect()).rejects.toThrow(ProbeViolationError);
  });

  it("recovered once the row leaves queued", async () => {
    const clock = new FakeClock();
    let status = "queued";
    const db = fakeQuerier((text) => (text.startsWith("SELECT status") ? [{ status }] : []));
    const probe = new WorkSuppressionProbe(db, clock, 10_000, 1);
    await probe.arm();
    expect(await probe.recovered()).toBe(false);
    status = "done";
    expect(await probe.recovered()).toBe(true);
  });
});

describe("PublishRefusalProbe", () => {
  it("maps publisher row states to effect/recovery signals", async () => {
    let row: Record<string, unknown> = { status: "queued", last_error: null };
    const queries: string[] = [];
    const db: Querier = {
      query: (text, params) => {
        queries.push(text);
        if (text.startsWith("SELECT status, last_error")) return Promise.resolve({ rows: [row] });
        void params;
        return Promise.resolve({ rows: [] });
      },
    };
    const probe = new PublishRefusalProbe(db, "unit", 7);
    await probe.arm();
    expect(queries.some((q) => q.includes("INSERT INTO handled_mentions"))).toBe(true);
    expect(queries.some((q) => q.includes("INSERT INTO publish_requests"))).toBe(true);
    expect(await probe.effect()).toBe(false);
    expect(await probe.recovered()).toBe(false);
    row = { status: "retry", last_error: "Error: replies switch on" };
    expect(await probe.effect()).toBe(true);
    expect(await probe.recovered()).toBe(false);
    row = { status: "published", last_error: null };
    expect(await probe.recovered()).toBe(true);
    await probe.cleanup();
    expect(queries.some((q) => q.startsWith("DELETE FROM publish_requests"))).toBe(true);
    expect(queries.some((q) => q.startsWith("DELETE FROM handled_mentions"))).toBe(true);
  });

  it("a vanished probe row is counter-evidence", async () => {
    const db = fakeQuerier(() => []);
    const probe = new PublishRefusalProbe(db, "unit", 8);
    await probe.arm();
    await expect(probe.effect()).rejects.toThrow(ProbeViolationError);
  });
});

describe("IngestHealthProbe", () => {
  const fetchWith =
    (age: number | null): FetchFn =>
    () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ lastPollAgeMs: age }) });

  it("preflight is false until ingest polls fresh", async () => {
    const probe = new IngestHealthProbe("http://x/healthz", 10_000, fetchWith(25_000));
    expect(await probe.preflight()).toBe(false);
    const never = new IngestHealthProbe("http://x/healthz", 10_000, fetchWith(null));
    expect(await never.preflight()).toBe(false);
  });

  it("effect when the poll age goes stale, recovery when fresh again", async () => {
    let age: number | null = 300;
    const probe = new IngestHealthProbe("http://x/healthz", 10_000, () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ lastPollAgeMs: age }) }),
    );
    expect(await probe.preflight()).toBe(true);
    expect(await probe.effect()).toBe(false);
    age = 10_500;
    expect(await probe.effect()).toBe(true);
    expect(await probe.recovered()).toBe(false);
    age = 400;
    expect(await probe.recovered()).toBe(true);
  });
});

describe("tool probes (real executors, fake store)", () => {
  const budgetsOk = fakeQuerier(() => [{ n: "0" }]);
  const storeWith = (on: boolean): Store =>
    ({ pool: budgetsOk, switchOn: () => Promise.resolve(on) }) as unknown as Store;

  const scoutCfg = {
    scoutEnabled: true,
    scoutUrl: "http://127.0.0.1:9/",
    scoutTimeoutMs: 2_000,
    scoutLimitMax: 50,
    scoutClaimantCap: 12,
    scoutPerMentionCap: 12,
    scoutDailyCeiling: 400,
    scoutRawPerUserDaily: 8,
    scoutRawGlobalDaily: 40,
  } as Config;

  const webCfg = {
    webProvider: "moonshot",
    modelBaseUrl: "http://127.0.0.1:9/",
    modelApiKey: undefined,
    webTimeoutMs: 2_000,
    webPerMentionCap: 2,
    webDailyCeiling: 200,
  } as Config;

  it("scout: SWITCH refusal while on, gate open after restore", async () => {
    expect(await new ScoutToolProbe(storeWith(true), scoutCfg).effect()).toBe(true);
    // Switch off: the gate passes and the (unreachable) upstream fails — any
    // outcome that is not a SWITCH refusal proves recovery.
    const probe = new ScoutToolProbe(storeWith(false), scoutCfg);
    expect(await probe.effect()).toBe(false);
    expect(await probe.recovered()).toBe(true);
  }, 15_000);

  it("web: SWITCH refusal while on, gate open after restore", async () => {
    expect(await new WebToolProbe(storeWith(true), webCfg).effect()).toBe(true);
    const probe = new WebToolProbe(storeWith(false), webCfg);
    expect(await probe.effect()).toBe(false);
    expect(await probe.recovered()).toBe(true);
  }, 15_000);
});

describe("reporting", () => {
  const results: DrillResult[] = [
    { switch: "global", ok: true, effectMs: 1234, recoverMs: 2311, error: null },
    { switch: "web", ok: false, effectMs: null, recoverMs: null, error: "not observed within 60000 ms deadline" },
  ];
  const meta = { target: "local", deadlineMs: 60_000, startedAt: "2026-09-04T00:00:00.000Z" };

  it("table lists per-switch times and the verdict", () => {
    const t = formatTable(results, meta);
    expect(t).toContain("global");
    expect(t).toContain("1234 ms");
    expect(t).toContain("2311 ms");
    expect(t).toContain("FAIL");
    expect(t).toContain("drill FAILED (1/2");
  });

  it("json report carries ok and results", () => {
    const parsed = JSON.parse(buildJsonReport(results, meta)) as { ok: boolean; results: DrillResult[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.results).toHaveLength(2);
  });
});

describe("drillPostUri", () => {
  it("produces canonical post URIs", () => {
    const uri = drillPostUri("replies", 42);
    expect(uri).toMatch(/^pubky:\/\/[a-z0-9]{52}\/pub\/pubky\.app\/posts\/[A-Z0-9]{13}$/);
  });
});

describe("outcomeError", () => {
  it("extracts string error codes only", () => {
    expect(outcomeError({ error: "SWITCH", message: "x" })).toBe("SWITCH");
    expect(outcomeError({ error: 5 })).toBeNull();
    expect(outcomeError(null)).toBeNull();
    expect(outcomeError({ data: [] })).toBeNull();
  });
});

/* ------------------------------------------------------- integration */

const url = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

describe("kill-switch drill (test database)", () => {
  let store: Store;
  let controller: DbSwitchController;
  const querier = (): Querier => store.pool as unknown as Querier;

  beforeAll(async () => {
    store = new Store(url);
    await store.migrate();
    await store.pool.query("DELETE FROM switches");
    await store.pool.query("UPDATE kill_switch SET disabled = FALSE WHERE id = 1");
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key LIKE 'pubky://drill%'");
    await store.pool.query("DELETE FROM work_queue WHERE mention_key LIKE 'pubky://drill%'");
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key LIKE 'pubky://drill%'");
    controller = new DbSwitchController(store);
  });

  afterAll(async () => {
    await store.pool.query("DELETE FROM switches");
    await store.pool.query("UPDATE kill_switch SET disabled = FALSE WHERE id = 1");
    await store.pool.query("DELETE FROM publish_requests WHERE mention_key LIKE 'pubky://drill%'");
    await store.pool.query("DELETE FROM work_queue WHERE mention_key LIKE 'pubky://drill%'");
    await store.pool.query("DELETE FROM handled_mentions WHERE mention_key LIKE 'pubky://drill%'");
    await store.close();
  });

  it("flips and restores the replies switch (and kill_switch) exactly", async () => {
    const snap = await controller.snapshot();
    assertBaselineClean(snap);
    await controller.set("replies", true);
    expect(await store.switchOn("replies")).toBe(true);
    expect(await store.switchOn("web")).toBe(true); // kill_switch blocks everything
    expect(await store.killSwitchOn()).toBe(true);
    await controller.restore(snap);
    expect(await store.switchOn("replies")).toBe(false);
    expect(await store.killSwitchOn()).toBe(false);
  });

  it("global turns every switch on and restore returns to baseline", async () => {
    const snap = await controller.snapshot();
    await controller.set("global", true);
    expect(await store.switchOn("consumption")).toBe(true);
    expect(await store.switchOn("generation")).toBe(true);
    expect(await store.switchOn("replies")).toBe(true);
    expect(await store.switchOn("scout")).toBe(true);
    expect(await store.switchOn("web")).toBe(true);
    expect(await store.killSwitchOn()).toBe(true);
    await controller.restore(snap);
    for (const n of ["consumption", "generation", "replies", "scout", "web"] as const) {
      expect(await store.switchOn(n)).toBe(false);
    }
    expect(await store.killSwitchOn()).toBe(false);
  });

  it("probe arms, observes a simulated refusal and recovery, then cleans up", async () => {
    const probe = new PublishRefusalProbe(querier(), "drill-itest", 31337);
    await probe.arm();
    const key = drillPostUri("drill-itest", 31337);
    expect(await probe.effect()).toBe(false);
    // Simulate the publisher refusing the PUT while the switch is on.
    await store.pool.query(
      "UPDATE publish_requests SET status = 'retry', last_error = 'Error: replies switch on' WHERE mention_key = $1",
      [key],
    );
    expect(await probe.effect()).toBe(true);
    // Simulate the publisher draining the row after restore.
    await store.pool.query("UPDATE publish_requests SET status = 'published' WHERE mention_key = $1", [key]);
    expect(await probe.recovered()).toBe(true);
    await probe.cleanup();
    expect(await store.get(key)).toBeNull();
  });

  it("enforces the 60 s deadline with a fake clock and still restores + cleans up", async () => {
    const clock = new FakeClock();
    const probe = new PublishRefusalProbe(querier(), "drill-timeout", 41414);
    const snap = await controller.snapshot();
    const results = await executeDrill(
      ["replies"],
      { controller, probes: { replies: probe }, clock, deadlineMs: 60_000, intervalMs: 250 },
      snap,
    );
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/60000/);
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
    // Restore happened even though the switch failed its deadline.
    expect(await store.switchOn("replies")).toBe(false);
    expect(await store.killSwitchOn()).toBe(false);
    // Probe rows are gone.
    expect(await store.get(drillPostUri("drill-timeout", 41414))).toBeNull();
  });

  it("full drill pass against the DB with a simulated publisher and fake clock", async () => {
    const clock = new FakeClock();
    const db = querier();
    class SimulatedPublisher extends PublishRefusalProbe {
      override async effect(): Promise<boolean> {
        await this.db.query(
          "UPDATE publish_requests SET status = 'retry', last_error = 'Error: replies switch on' WHERE mention_key = $1",
          [this.key],
        );
        return super.effect();
      }
      override async recovered(): Promise<boolean> {
        await this.db.query("UPDATE publish_requests SET status = 'published' WHERE mention_key = $1", [this.key]);
        return super.recovered();
      }
    }
    const probe = new SimulatedPublisher(db, "drill-happy", 51515);
    const snap = await controller.snapshot();
    const results = await executeDrill(
      ["replies"],
      { controller, probes: { replies: probe }, clock, deadlineMs: 60_000, intervalMs: 250 },
      snap,
    );
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.effectMs).toBe(0);
    expect(results[0]?.recoverMs).toBe(0);
    expect(await store.killSwitchOn()).toBe(false);
    expect(await store.get(drillPostUri("drill-happy", 51515))).toBeNull();
  });
});
