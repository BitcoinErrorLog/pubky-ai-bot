import { afterEach, describe, expect, it } from "vitest";
import { closeServer } from "../health.js";
import { Store } from "../db.js";
import { configFromProcessEnv } from "../config.js";
import { classifyWriteResponse, ScoutWriteCanary } from "./canary.js";
import { TokenBucket } from "./limiter.js";
import { ScoutClient, ScoutToolError } from "./client.js";
import { startScoutStub } from "./stub.js";
import { resetScoutBreakerForTests } from "./budget.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";

afterEach(() => {
  resetScoutBreakerForTests();
});

describe("classifyWriteResponse", () => {
  it("treats 2xx envelopes as accepted and error/4xx as rejected", () => {
    expect(
      classifyWriteResponse({
        networkError: false,
        status: 200,
        body: { results: [{ n: {} }], count: 1, truncated: false },
      }),
    ).toBe("accepted");
    expect(
      classifyWriteResponse({
        networkError: false,
        status: 400,
        body: { error: "READ_ONLY", message: "writes disabled" },
      }),
    ).toBe("rejected");
    expect(
      classifyWriteResponse({
        networkError: false,
        status: 200,
        body: { error: "QUERY_FORBIDDEN", message: "read-only" },
      }),
    ).toBe("rejected");
  });

  it("treats network errors and 5xx as unknown, not accepted", () => {
    expect(classifyWriteResponse({ networkError: true, status: 0, body: null })).toBe("unknown");
    expect(classifyWriteResponse({ networkError: false, status: 503, body: { error: "DOWN" } })).toBe("unknown");
  });
});

describe("ScoutWriteCanary against a fake Scout", () => {
  it("passes when every write is rejected and MATCH count is 0", async () => {
    process.env.DATABASE_URL ??= DB;
    const stub = await startScoutStub([
      {
        match: (c) => /CREATE|MERGE|SET|DELETE|CALL|LOAD CSV/i.test(c),
        status: 400,
        body: { error: "READ_ONLY", message: "writes disabled" },
      },
      {
        match: (c) => c.includes("MATCH (n:JebCanary)"),
        status: 200,
        body: { results: [{ c: 0 }], count: 1, truncated: false },
      },
    ]);
    const store = new Store(DB);
    await store.migrate();
    await store.setSwitch("scout", false);
    try {
      const cfg = {
        ...configFromProcessEnv({ requireSecret: false }),
        scoutUrl: stub.url,
        scoutTimeoutMs: 2_000,
        scoutCanaryUnknownThreshold: 3,
      };
      let flipped = 0;
      const canary = new ScoutWriteCanary(cfg, store.pool, async () => {
        flipped += 1;
        await store.setSwitch("scout", true);
      });
      const out = await canary.run();
      expect(out.outcome).toBe("pass");
      expect(out.switchFlipped).toBe(false);
      expect(flipped).toBe(0);
      expect(out.probes.filter((p) => p.name !== "MATCH count").every((p) => p.classification === "rejected")).toBe(true);
      expect(await store.switchOn("scout")).toBe(false);
      const rows = await store.pool.query<{ outcome: string }>("SELECT outcome FROM scout_canary ORDER BY id DESC LIMIT 1");
      expect(rows.rows[0]?.outcome).toBe("pass");
    } finally {
      await store.setSwitch("scout", false);
      await store.close();
      await closeServer(stub.server);
    }
  });

  it("fails, records, and flips the scout switch when a write is accepted", async () => {
    process.env.DATABASE_URL ??= DB;
    const stub = await startScoutStub([
      {
        match: (c) => c.startsWith("CREATE"),
        status: 200,
        body: { results: [{ n: { nonce: "x" } }], count: 1, truncated: false },
      },
      {
        match: (c) => /MERGE|SET|DELETE|CALL|LOAD CSV/i.test(c),
        status: 400,
        body: { error: "READ_ONLY", message: "writes disabled" },
      },
      {
        match: (c) => c.includes("MATCH (n:JebCanary)"),
        status: 200,
        body: { results: [{ c: 1 }], count: 1, truncated: false },
      },
    ]);
    const store = new Store(DB);
    await store.migrate();
    await store.setSwitch("scout", false);
    try {
      const cfg = {
        ...configFromProcessEnv({ requireSecret: false }),
        scoutUrl: stub.url,
        scoutTimeoutMs: 2_000,
        scoutCanaryUnknownThreshold: 3,
      };
      const canary = new ScoutWriteCanary(cfg, store.pool, () => store.setSwitch("scout", true));
      const out = await canary.run();
      expect(out.outcome).toBe("fail");
      expect(out.switchFlipped).toBe(true);
      expect(canary.snapshot().lastAcceptedProbe).toBe("CREATE");
      expect(await store.switchOn("scout")).toBe(true);
      const rows = await store.pool.query<{ outcome: string; switch_flipped: boolean }>(
        "SELECT outcome, switch_flipped FROM scout_canary ORDER BY id DESC LIMIT 1",
      );
      expect(rows.rows[0]?.outcome).toBe("fail");
      expect(rows.rows[0]?.switch_flipped).toBe(true);
    } finally {
      await store.setSwitch("scout", false);
      await store.close();
      await closeServer(stub.server);
    }
  });

  it("classifies downtime as unknown and errors only after N consecutive unknowns", async () => {
    process.env.DATABASE_URL ??= DB;
    const stub = await startScoutStub([{ status: 503, body: { error: "UNAVAILABLE", message: "down" } }]);
    const store = new Store(DB);
    await store.migrate();
    try {
      const cfg = {
        ...configFromProcessEnv({ requireSecret: false }),
        scoutUrl: stub.url,
        scoutTimeoutMs: 2_000,
        scoutCanaryUnknownThreshold: 3,
      };
      let flipped = 0;
      const canary = new ScoutWriteCanary(cfg, store.pool, async () => {
        flipped += 1;
      });
      const a = await canary.run();
      const b = await canary.run();
      expect(a.outcome).toBe("unknown");
      expect(b.outcome).toBe("unknown");
      expect(canary.snapshot().consecutiveUnknown).toBe(2);
      expect(flipped).toBe(0);
      const c = await canary.run();
      expect(c.outcome).toBe("unknown");
      expect(c.consecutiveUnknown).toBe(3);
      expect(flipped).toBe(0);
    } finally {
      await store.close();
      await closeServer(stub.server);
    }
  });
});

describe("TokenBucket", () => {
  it("allows a burst up to capacity then waits for refill", async () => {
    let now = 1_000_000;
    const bucket = new TokenBucket(2, 2, () => now);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    now += 500;
    expect(await bucket.acquire(0)).toBe(true);
    expect(bucket.tryTake()).toBe(false);
  });

  it("ScoutClient fails closed with evidence-unavailable when the wait expires", async () => {
    process.env.DATABASE_URL ??= DB;
    const stub = await startScoutStub([
      { status: 200, body: { results: [], count: 0, truncated: false } },
    ]);
    try {
      const client = new ScoutClient({
        ...configFromProcessEnv({ requireSecret: false }),
        scoutUrl: stub.url,
        scoutTimeoutMs: 30,
        scoutLimitMax: 10,
        scoutMaxQps: 0.01,
      });
      await client.query({ cypher: "MATCH (n) RETURN n LIMIT 1", tool: "search_posts" });
      await expect(client.query({ cypher: "MATCH (n) RETURN n LIMIT 1", tool: "search_posts" })).rejects.toMatchObject({
        code: "RATE_LIMITED",
        message: "graph lookup unavailable right now",
      } satisfies Partial<ScoutToolError>);
    } finally {
      await closeServer(stub.server);
    }
  });
});
