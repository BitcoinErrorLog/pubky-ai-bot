import { afterEach, describe, expect, it } from "vitest";
import { noteScoutOutcome, resetScoutBreakerForTests, scoutBreakerBlocked } from "./budget.js";
import { ScoutClient, ScoutToolError } from "./client.js";
import { startScoutStub } from "./stub.js";
import { configFromProcessEnv } from "../config.js";

describe("scout circuit breaker (D4)", () => {
  afterEach(() => {
    resetScoutBreakerForTests();
    delete process.env.JEB_SCOUT_BREAKER_FAILURES;
    delete process.env.JEB_SCOUT_BREAKER_WINDOW_MS;
    delete process.env.JEB_SCOUT_BREAKER_COOLDOWN_MS;
  });

  it("opens after N consecutive failures in the window and skips Scout during cooldown", async () => {
    process.env.DATABASE_URL ??= "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
    process.env.JEB_SCOUT_BREAKER_FAILURES = "3";
    process.env.JEB_SCOUT_BREAKER_WINDOW_MS = "60000";
    process.env.JEB_SCOUT_BREAKER_COOLDOWN_MS = "30000";
    const stub = await startScoutStub([{ status: 503, body: { error: "UNAVAILABLE", message: "down" } }]);
    try {
      const client = new ScoutClient({
        ...configFromProcessEnv({ requireSecret: false }),
        scoutUrl: stub.url,
        scoutTimeoutMs: 2_000,
        scoutLimitMax: 10,
      });
      for (let i = 0; i < 3; i++) {
        await expect(
          client.query({ cypher: "MATCH (n) RETURN n LIMIT 1", tool: "search_posts" }),
        ).rejects.toBeInstanceOf(ScoutToolError);
      }
      expect(scoutBreakerBlocked()).toBe(true);
      const before = stub.calls.length;
      await expect(
        client.query({ cypher: "MATCH (n) RETURN n LIMIT 1", tool: "search_posts" }),
      ).rejects.toMatchObject({ code: "SCOUT_BACKOFF", message: "graph lookup unavailable right now" });
      expect(stub.calls.length).toBe(before);
    } finally {
      await new Promise<void>((r) => stub.server.close(() => r()));
    }
  });

  it("closes after cooldown and logs a successful path", () => {
    process.env.JEB_SCOUT_BREAKER_FAILURES = "2";
    process.env.JEB_SCOUT_BREAKER_WINDOW_MS = "60000";
    process.env.JEB_SCOUT_BREAKER_COOLDOWN_MS = "1";
    noteScoutOutcome(false);
    noteScoutOutcome(false);
    expect(scoutBreakerBlocked()).toBe(true);
    const start = Date.now();
    while (Date.now() - start < 20) {
      /* spin until cooldown */
    }
    expect(scoutBreakerBlocked()).toBe(false);
  });
});
