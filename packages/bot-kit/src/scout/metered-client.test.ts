import { describe, expect, it } from "vitest";
import { meteredScoutClient } from "./metered-client.js";
import { ScoutCallBudgetError, ScoutCallMeter } from "./budget.js";
import type { ScoutClient } from "./client.js";

const call = { cypher: "MATCH (u:User {id:$id}) RETURN u.id LIMIT 1", tool: "query_graph" } as const;

/** A Scout client whose every call takes `sleepMs` on the injected clock. */
function sleepyClient(sleepMs: number, clock: { now: number }): { client: ScoutClient; calls: () => number } {
  let calls = 0;
  const client = {
    async query() {
      calls += 1;
      clock.now += sleepMs;
      return { envelope: { results: [], truncated: false, notes: [] }, cost: {} };
    },
  } as unknown as ScoutClient;
  return { client, calls: () => calls };
}

describe("metered Scout client (D2)", () => {
  it("records real durations for every call instead of zero", async () => {
    const clock = { now: 0 };
    const meter = new ScoutCallMeter();
    const { client } = sleepyClient(1_500, clock);
    const metered = meteredScoutClient(client, meter, () => clock.now);
    await metered.query(call);
    await metered.query(call);
    expect(meter.snapshot()).toEqual({ calls: 2, scoutMs: 3_000 });
  });

  it("refuses the eleventh call", async () => {
    const clock = { now: 0 };
    const meter = new ScoutCallMeter();
    const { client, calls } = sleepyClient(10, clock);
    const metered = meteredScoutClient(client, meter, () => clock.now);
    for (let i = 0; i < 10; i += 1) await metered.query(call);
    await expect(metered.query(call)).rejects.toThrowError(new ScoutCallBudgetError("SCOUT_CALL_CAP"));
    expect(calls()).toBe(10);
  });

  it("refuses the call after 20,001 ms of Scout time", async () => {
    const clock = { now: 0 };
    const meter = new ScoutCallMeter();
    const { client, calls } = sleepyClient(20_001, clock);
    const metered = meteredScoutClient(client, meter, () => clock.now);
    await expect(metered.query(call)).rejects.toThrowError(new ScoutCallBudgetError("SCOUT_TIME_CAP"));
    expect(meter.snapshot().scoutMs).toBe(20_001);
    expect(calls()).toBe(1);
  });

  it("records failed calls so a slow failure still consumes budget", async () => {
    const clock = { now: 0 };
    const meter = new ScoutCallMeter();
    const client = {
      async query() {
        clock.now += 9_000;
        throw new Error("upstream");
      },
    } as unknown as ScoutClient;
    const metered = meteredScoutClient(client, meter, () => clock.now);
    await expect(metered.query(call)).rejects.toThrow("upstream");
    expect(meter.snapshot()).toEqual({ calls: 1, scoutMs: 9_000 });
  });

  it("uses the time-cap error when a failed call also crosses the cap", async () => {
    const clock = { now: 0 };
    const meter = new ScoutCallMeter();
    const client = {
      async query() {
        clock.now += 20_001;
        throw new Error("upstream");
      },
    } as unknown as ScoutClient;
    const metered = meteredScoutClient(client, meter, () => clock.now);
    await expect(metered.query(call)).rejects.toThrowError(new ScoutCallBudgetError("SCOUT_TIME_CAP"));
    expect(meter.snapshot()).toEqual({ calls: 1, scoutMs: 20_001 });
  });

  it("atomically reserves the remaining call capacity before concurrent dispatch", async () => {
    const clock = { now: 0 };
    const meter = new ScoutCallMeter();
    for (let i = 0; i < 7; i += 1) meter.record(0);
    const { client, calls } = sleepyClient(10, clock);
    const metered = meteredScoutClient(client, meter, () => clock.now);
    const results = await Promise.allSettled([metered.query(call), metered.query(call), metered.query(call), metered.query(call)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(calls()).toBe(3);
    expect(meter.snapshot().calls).toBe(10);
  });
});
