import { describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_TOKEN_BUDGET,
  DEFAULT_MODEL_PRICE_PER_MTOK_IN,
  DEFAULT_MODEL_PRICE_PER_MTOK_OUT,
  DEFAULT_USER_DAILY_TOKEN_BUDGET,
} from "./config.js";
import { generateCostBoundsMarkdown } from "./cost-bounds.js";
import { SKIP_NOTICE_TEXT } from "./skip-notice.js";
import { tokensToUsd } from "./metrics-db.js";

describe("cost bounds copy", () => {
  it("is generated from config defaults, not hand-typed ceilings", () => {
    const text = generateCostBoundsMarkdown();
    expect(text).toContain(String(DEFAULT_DAILY_TOKEN_BUDGET.toLocaleString("en-US")));
    expect(text).toContain(String(DEFAULT_USER_DAILY_TOKEN_BUDGET.toLocaleString("en-US")));
    expect(text).toContain(`$${DEFAULT_MODEL_PRICE_PER_MTOK_IN}/1M`);
    expect(text).toContain(`$${DEFAULT_MODEL_PRICE_PER_MTOK_OUT}/1M`);
    expect(text).toContain(SKIP_NOTICE_TEXT.budget);
    expect(text).toMatch(/Top-ups are not yet available \(plan 9\.1\)/);
    const dailyOut = tokensToUsd(0, DEFAULT_DAILY_TOKEN_BUDGET, DEFAULT_DAILY_TOKEN_BUDGET, DEFAULT_MODEL_PRICE_PER_MTOK_IN, DEFAULT_MODEL_PRICE_PER_MTOK_OUT);
    expect(text).toContain(`$${dailyOut.toFixed(2)}`);
    expect(text).not.toMatch(/\b5000000\b/);
  });
});
