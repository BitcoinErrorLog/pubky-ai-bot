import { describe, expect, it } from "vitest";
import { createScoutTools } from "./tools.js";
import type { ScoutToolsConfig } from "./scout-config.js";

const USER = "1111111111111111111111111111111111111111111111111111";
const DAY_MS = 24 * 60 * 60 * 1000;
const FROZEN = 1_700_000_000_000;

const cfg: ScoutToolsConfig = {
  scoutUrl: "http://127.0.0.1:9",
  scoutTimeoutMs: 1000,
  scoutLimitMax: 25,
  scoutPerMentionCap: 12,
  scoutDailyCeiling: 400,
  scoutRawPerUserDaily: 8,
  scoutRawGlobalDaily: 40,
  scoutEnabled: true,
  scoutRawEnabled: false,
  scoutProfilePropMax: 3,
  scoutClaimantCap: 12,
};

function tools(nowMs?: number) {
  return createScoutTools({
    cfg,
    pool: { query: async () => ({ rows: [{ n: "0" }] }) } as never,
    storeSwitchOn: async () => false,
    client: { query: async () => ({ envelope: { results: [], truncated: false, notes: [] } }) } as never,
    ...(nowMs === undefined ? {} : { nowMs }),
  });
}

type ScopedResult = { scope: { time_range: { since: number; until: number } } };

describe("scout tool clock boundary", () => {
  it("uses the real clock when the caller supplies no request clock", async () => {
    const before = Date.now();
    const out = (await tools().recommend_follows.execute({ pubky: USER })) as ScopedResult;
    const after = Date.now();
    expect(out.scope.time_range.until).toBeGreaterThanOrEqual(before);
    expect(out.scope.time_range.until).toBeLessThanOrEqual(after);
    expect(out.scope.time_range.since).toBe(out.scope.time_range.until - 30 * DAY_MS);
  });

  it("freezes every window on the supplied request clock", async () => {
    const out = (await tools(FROZEN).recommend_follows.execute({ pubky: USER })) as ScopedResult;
    expect(out.scope.time_range).toEqual({ since: FROZEN - 30 * DAY_MS, until: FROZEN });
  });
});
