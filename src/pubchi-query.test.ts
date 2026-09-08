import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "./log.js";
import { runQuery } from "./pubchi/query.js";
import { dummyNlqOpts, testTenant, TEST_NOW } from "./pubchi/test-helpers.js";

describe("runQuery Nexus failure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns UPSTREAM_UNAVAILABLE without leaking the Nexus error", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => log);
    const outcome = await runQuery({
      tenant: testTenant(),
      body: { question: "who tagged me?" },
      now: TEST_NOW,
      runId: "run-test",
      nlq: async () => {
        throw new Error("NLQ must not be called");
      },
      nlqOpts: dummyNlqOpts(),
      nexus: {
        userTags: async () => {
          throw new Error("secret Nexus response body");
        },
      },
    });
    expect(outcome).toMatchObject({
      ok: false,
      code: "UPSTREAM_UNAVAILABLE",
      stage: "upstream",
      cause: "nexus_user_tags unknown",
    });
    expect(outcome).toHaveProperty("timings.nexus_ms", expect.any(Number));
    expect(JSON.stringify(outcome)).not.toContain("secret Nexus response body");
    const thrown = warn.mock.calls.find((call) => {
      const rec = call[0] as { event?: string };
      return rec && rec.event === "pubchi_nexus_user_tags_failed";
    });
    expect(thrown?.[0]).toMatchObject({
      event: "pubchi_nexus_user_tags_failed",
    });
    expect(JSON.stringify(thrown?.[0] ?? {})).not.toContain("secret Nexus response body");
  });
});
