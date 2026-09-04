import { afterEach, describe, expect, it } from "vitest";
import { policyLimitsFromEnv, policySummary } from "./policy-summary.js";

const KEYS = [
  "JEB_MAX_REPLIES_PER_THREAD",
  "JEB_MAX_TURNS_PER_USER_PER_THREAD",
  "JEB_MAX_PER_USER_PER_HOUR",
  "JEB_DAILY_TOKEN_BUDGET",
  "JEB_USER_DAILY_TOKEN_BUDGET",
  "JEB_MODEL_TIMEOUT_MS",
  "JEB_ANSWER_BUDGET_MS",
  "JEB_REPLY_DEADLINE_MS",
  "JEB_POLL_MS",
  "JEB_KNOWN_BOTS",
  "JEB_BLOCKLIST",
] as const;

describe("policySummary", () => {
  const saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function snapshotEnv(): void {
    for (const k of KEYS) saved[k] = process.env[k];
  }

  it("returns code defaults when env is unset", () => {
    snapshotEnv();
    for (const k of KEYS) delete process.env[k];
    const s = policySummary(policyLimitsFromEnv());
    expect(s).toEqual({
      maxRepliesPerThread: 12,
      maxTurnsPerUserPerThread: 6,
      maxPerUserPerHour: 5,
      dailyTokenBudget: 5_000_000,
      userDailyTokenBudget: 600_000,
      modelTimeoutMs: 30_000,
      answerBudgetMs: 180_000,
      replyDeadlineMs: 240_000,
      pollMs: 3_000,
      knownBotsCount: 0,
      blocklistCount: 0,
    });
  });

  it("reflects env overrides and set sizes without secrets", () => {
    snapshotEnv();
    process.env.JEB_MAX_REPLIES_PER_THREAD = "1";
    process.env.JEB_MAX_TURNS_PER_USER_PER_THREAD = "2";
    process.env.JEB_MAX_PER_USER_PER_HOUR = "3";
    process.env.JEB_DAILY_TOKEN_BUDGET = "999";
    process.env.JEB_USER_DAILY_TOKEN_BUDGET = "1111";
    process.env.JEB_MODEL_TIMEOUT_MS = "111";
    process.env.JEB_ANSWER_BUDGET_MS = "222";
    process.env.JEB_REPLY_DEADLINE_MS = "333";
    process.env.JEB_POLL_MS = "444";
    process.env.JEB_KNOWN_BOTS = "aaa,bbb";
    process.env.JEB_BLOCKLIST = "ccc";
    const s = policySummary(policyLimitsFromEnv());
    expect(s.maxRepliesPerThread).toBe(1);
    expect(s.maxTurnsPerUserPerThread).toBe(2);
    expect(s.maxPerUserPerHour).toBe(3);
    expect(s.dailyTokenBudget).toBe(999);
    expect(s.userDailyTokenBudget).toBe(1111);
    expect(s.modelTimeoutMs).toBe(111);
    expect(s.answerBudgetMs).toBe(222);
    expect(s.replyDeadlineMs).toBe(333);
    expect(s.pollMs).toBe(444);
    expect(s.knownBotsCount).toBe(2);
    expect(s.blocklistCount).toBe(1);
    expect(JSON.stringify(s)).not.toMatch(/secret|mnemonic|api[_-]?key/i);
  });
});
