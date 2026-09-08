import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { log } from "./log.js";
import { runQuery } from "./pubchi/query.js";
import { dummyNlqOpts, testTenant, TEST_NOW } from "./pubchi/test-helpers.js";

function missingRelationError(): InstanceType<typeof pg.DatabaseError> {
  const err = new pg.DatabaseError('relation "scout_queries" does not exist', 0, "error");
  err.code = "42P01";
  return err;
}

describe("runQuery missing scout_queries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns UPSTREAM_UNAVAILABLE and logs the pg code without leaking it to the client", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => log);
    const pool = {
      query: async () => {
        throw missingRelationError();
      },
    };
    const outcome = await runQuery({
      tenant: testTenant(),
      body: { question: "who tagged me?" },
      now: TEST_NOW,
      runId: "run-test",
      nlq: async (_req, opts) => {
        await opts.pool.query("SELECT count(*)::text AS n FROM scout_queries");
        throw new Error("unreachable");
      },
      nlqOpts: { ...dummyNlqOpts(), pool: pool as never },
    });
    expect(outcome).toEqual({
      ok: false,
      code: "UPSTREAM_UNAVAILABLE",
      stage: "upstream",
      cause: "error",
    });
    expect(JSON.stringify(outcome)).not.toMatch(/42P01|scout_queries|does not exist/);
    const thrown = warn.mock.calls.find((call) => {
      const rec = call[0] as { event?: string };
      return rec && rec.event === "pubchi_nlq_throw";
    });
    expect(thrown?.[0]).toMatchObject({
      event: "pubchi_nlq_throw",
      name: "error",
      pgCode: "42P01",
      message: 'relation "scout_queries" does not exist',
    });
    expect(JSON.stringify(thrown?.[0] ?? {})).not.toMatch(/asker|DATABASE_URL|question/);
  });
});
