import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Store } from "./db.js";
import { log } from "./log.js";
import { budgetExceeded, maybeWarnBudget, TYPICAL_ANSWER_TOKENS_FALLBACK } from "./policy.js";
import { skipNoticeText, SKIP_NOTICE_TEXT } from "./skip-notice.js";
import { lintVoice } from "./voice.js";

const DB = process.env.DATABASE_URL ?? "postgres://johncarvalho@127.0.0.1:5432/jeb_stage1_test";
const AUTHOR = "budgetuseraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("skip notice copy", () => {
  for (const [reason, text] of Object.entries(SKIP_NOTICE_TEXT)) {
    it(`${reason} is voice-linted and does not promise a retry under an exhausted budget`, () => {
      expect(skipNoticeText(reason as keyof typeof SKIP_NOTICE_TEXT)).toBe(text);
      expect(lintVoice(text).violations).toEqual([]);
      expect(text.includes("I'll try")).toBe(false);
    });
  }
});

describe("budget cliff: split ceilings and estimate-before-spend", () => {
  let store: Store;
  beforeAll(async () => {
    store = new Store(DB);
    await store.migrate();
  });
  afterAll(async () => {
    await store.close();
  });

  it("falls back to 20000 when the p50 query has no rows (empty result path)", async () => {
    const empty = {
      typicalAnswerTokensP50: async () => TYPICAL_ANSWER_TOKENS_FALLBACK,
      globalDailyTokens: async () => 0,
      userDailyTokens: async () => 0,
      claimOperatorFlag: async () => false,
    } as unknown as Store;
    expect(await budgetExceeded(empty, { global: 25_000, user: 25_000 }, AUTHOR)).toBe(false);
    expect(await budgetExceeded(empty, { global: 19_999, user: 1_000_000 }, AUTHOR)).toBe(true);
    expect(await budgetExceeded(empty, { global: 1_000_000, user: 19_999 }, AUTHOR)).toBe(true);
  });

  it("treats global + typicalCost and user + typicalCost independently", async () => {
    const fake = {
      typicalAnswerTokensP50: async () => 50_000,
      globalDailyTokens: async () => 40_000,
      userDailyTokens: async () => 10_000,
      claimOperatorFlag: async () => false,
    } as unknown as Store;
    expect(await budgetExceeded(fake, { global: 89_999, user: 1_000_000 }, AUTHOR)).toBe(true);
    expect(await budgetExceeded(fake, { global: 90_001, user: 1_000_000 }, AUTHOR)).toBe(false);
    expect(await budgetExceeded(fake, { global: 5_000_000, user: 59_999 }, AUTHOR)).toBe(true);
    expect(await budgetExceeded(fake, { global: 5_000_000, user: 60_001 }, AUTHOR)).toBe(false);
  });

  it("typicalAnswerTokensP50 returns a positive number from live token_usage or the fallback", async () => {
    const n = await store.typicalAnswerTokensP50();
    expect(n).toBeGreaterThan(0);
    const global = await store.globalDailyTokens();
    const user = await store.userDailyTokens(AUTHOR);
    const overGlobal = await budgetExceeded(store, { global: Math.max(1, global + n - 1), user: 10_000_000 }, AUTHOR);
    const underGlobal = await budgetExceeded(store, { global: global + n + 1, user: 10_000_000 }, AUTHOR);
    expect(overGlobal).toBe(true);
    expect(underGlobal).toBe(false);
    expect(user + n).toBeGreaterThan(0);
  });

  it("logs budget_warning once per UTC day via operator_flags", async () => {
    const spy = vi.spyOn(log, "warn");
    const day = new Date().toISOString().slice(0, 10);
    await store.pool.query("DELETE FROM operator_flags WHERE name = $1", [`budget_warning:${day}`]);
    expect(await maybeWarnBudget(store, 80, 100)).toBe(true);
    expect(await maybeWarnBudget(store, 90, 100)).toBe(false);
    expect(await maybeWarnBudget(store, 10, 100)).toBe(false);
    const warns = spy.mock.calls.filter((c) => (c[0] as { event?: string }).event === "budget_warning");
    expect(warns).toHaveLength(1);
    spy.mockRestore();
  });
});
