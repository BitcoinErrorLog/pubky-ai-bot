import { describe, expect, it } from "vitest";
import {
  PHASE0_BRAIN,
  PURPOSE_ENDPOINTS,
  PURPOSE_MINIMUM_TIER,
  SERVED_PURPOSES,
  TIER_BUDGETS,
  parseTenantV1,
  type Tier,
} from "./index.js";
import { TEST_BOT, TEST_NOW, TEST_OWNER } from "./vectors.js";

function tenant(tier: Tier) {
  return {
    schema: "pubchi-tenant",
    version: 1,
    bot: TEST_BOT,
    owner: TEST_OWNER,
    tier,
    brain: { ...PHASE0_BRAIN },
    budgets: { ...TIER_BUDGETS[tier] },
    created_at: TEST_NOW - 1,
    updated_at: TEST_NOW,
  };
}

describe("tenant tier authorization schema", () => {
  it.each(["read-only", "assisted", "autonomous"] as const)("pins every %s budget as literals", (tier) => {
    expect(parseTenantV1(tenant(tier))).toMatchObject({ ok: true });
    for (const key of Object.keys(TIER_BUDGETS[tier]) as Array<keyof (typeof TIER_BUDGETS)[typeof tier]>) {
      const changed = tenant(tier);
      changed.budgets = { ...changed.budgets, [key]: changed.budgets[key] + 1 };
      expect(parseTenantV1(changed), `${tier}.${key}`).toEqual({ ok: false, code: "BUDGET_NOT_FIXED" });
    }
  });

  it("pins the read-only and assisted budget delta", () => {
    expect(TIER_BUDGETS.assisted).toEqual({
      ...TIER_BUDGETS["read-only"],
      per_request_output_tokens: 4_000,
    });
    expect(TIER_BUDGETS.autonomous).toEqual({
      ...TIER_BUDGETS.assisted,
      proactive_suggestions_per_day: 3,
    });
  });

  it("requires every served endpoint to have a minimum tier", () => {
    expect(Object.keys(PURPOSE_ENDPOINTS).sort()).toEqual([...SERVED_PURPOSES].sort());
    expect(Object.keys(PURPOSE_MINIMUM_TIER).sort()).toEqual([...SERVED_PURPOSES].sort());
    expect(PURPOSE_MINIMUM_TIER).toEqual({
      ask: "read-only",
      "who-tagged-me": "read-only",
      "build-feed": "read-only",
    });
  });
});
