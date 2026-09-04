import { describe, expect, it } from "vitest";
import { applyQuotaPrefix, QUOTA_ANSWER_LEADIN, SHORT_LIMIT } from "./compose.js";
import {
  decideQuotaNotice,
  minutesUntilHourlyAgeOut,
  msUntilUtcMidnight,
  quotaNoticeSentence,
  QUOTA_NOTICE_RULES,
  rawQuotaNoticeSentence,
  wholeHoursMinutes,
  type QuotaNoticeCounters,
} from "./quota-notice.js";
import { lintVoice } from "./voice.js";

const base: QuotaNoticeCounters = {
  userTokens: 0,
  globalTokens: 0,
  typicalCost: 20_000,
  userDailyCeiling: 600_000,
  globalDailyCeiling: 5_000_000,
  userHourCount: 0,
  maxPerUserPerHour: 5,
  jebTurnsWithAsker: 0,
  maxTurnsPerUserPerThread: 6,
  jebRepliesInThread: 0,
  maxRepliesPerThread: 12,
};

const PINNED = new Date("2026-09-04T20:45:00.000Z");

describe("decideQuotaNotice", () => {
  it("is silent when no quota is on its last slot", () => {
    expect(decideQuotaNotice(base)).toBeNull();
  });

  it("fires user_daily_budget when this estimated spend is the last affordable", () => {
    expect(decideQuotaNotice({ ...base, userTokens: 580_000, typicalCost: 20_000, userDailyCeiling: 600_000 })).toBe(
      "user_daily_budget",
    );
    expect(decideQuotaNotice({ ...base, userTokens: 560_000, typicalCost: 20_000, userDailyCeiling: 600_000 })).toBeNull();
  });

  it("fires global_daily_budget when this estimated spend is the last global slot", () => {
    expect(decideQuotaNotice({ ...base, globalTokens: 4_980_000, typicalCost: 20_000, globalDailyCeiling: 5_000_000 })).toBe(
      "global_daily_budget",
    );
    expect(decideQuotaNotice({ ...base, globalTokens: 4_960_000, typicalCost: 20_000, globalDailyCeiling: 5_000_000 })).toBeNull();
  });

  it("fires user_hourly_cap when this answer makes count == max", () => {
    expect(decideQuotaNotice({ ...base, userHourCount: 4, maxPerUserPerHour: 5 })).toBe("user_hourly_cap");
    expect(decideQuotaNotice({ ...base, userHourCount: 3, maxPerUserPerHour: 5 })).toBeNull();
  });

  it("fires user_turn_cap when this answer makes turns == max", () => {
    expect(decideQuotaNotice({ ...base, jebTurnsWithAsker: 5, maxTurnsPerUserPerThread: 6 })).toBe("user_turn_cap");
    expect(decideQuotaNotice({ ...base, jebTurnsWithAsker: 4, maxTurnsPerUserPerThread: 6 })).toBeNull();
  });

  it("fires thread_cap when this answer makes thread replies == max", () => {
    expect(decideQuotaNotice({ ...base, jebRepliesInThread: 11, maxRepliesPerThread: 12 })).toBe("thread_cap");
    expect(decideQuotaNotice({ ...base, jebRepliesInThread: 10, maxRepliesPerThread: 12 })).toBeNull();
  });

  it("stacks: user daily + thread cap both last → only user_daily_budget", () => {
    expect(
      decideQuotaNotice({
        ...base,
        userTokens: 580_000,
        typicalCost: 20_000,
        userDailyCeiling: 600_000,
        jebRepliesInThread: 11,
        maxRepliesPerThread: 12,
      }),
    ).toBe("user_daily_budget");
  });
});

describe("quota notice copy and clock", () => {
  it("voice-lints all five prefix sentences at a pinned clock", () => {
    const oldest = new Date(PINNED.getTime() - 18 * 60_000);
    for (const rule of QUOTA_NOTICE_RULES) {
      const raw = rawQuotaNoticeSentence(rule, { now: PINNED, oldestHourly: oldest });
      expect(lintVoice(raw).violations).toEqual([]);
      expect(quotaNoticeSentence(rule, { now: PINNED, oldestHourly: oldest })).toBe(raw);
    }
  });

  it("renders UTC remaining time from the injected clock", () => {
    expect(msUntilUtcMidnight(PINNED)).toBe(3 * 3_600_000 + 15 * 60_000);
    expect(wholeHoursMinutes(msUntilUtcMidnight(PINNED))).toEqual({ h: 3, m: 15 });
    expect(quotaNoticeSentence("user_daily_budget", { now: PINNED })).toBe(
      "This is my last reply to you today; my budget for you resets at 00:00 UTC (in about 3h 15m).",
    );
    expect(quotaNoticeSentence("global_daily_budget", { now: PINNED })).toBe(
      "This is my last reply for today; my budget resets at 00:00 UTC (in about 3h 15m).",
    );
    const oldest = new Date(PINNED.getTime() - 18 * 60_000);
    expect(minutesUntilHourlyAgeOut(oldest, PINNED)).toBe(42);
    expect(quotaNoticeSentence("user_hourly_cap", { now: PINNED, oldestHourly: oldest })).toBe(
      "This is my last reply to you this hour; I'll pick up again in about 42 minutes.",
    );
    expect(quotaNoticeSentence("user_turn_cap", { now: PINNED })).toBe(
      "This is my last reply to you in this thread; start a new post if you want to keep going.",
    );
    expect(quotaNoticeSentence("thread_cap", { now: PINNED })).toBe(
      "This is my last reply in this thread; start a new post and I'll answer there.",
    );
  });
});

describe("applyQuotaPrefix", () => {
  it("puts the lead-in on its own line and never trims the prefix", () => {
    const prefix = quotaNoticeSentence("thread_cap", { now: PINNED });
    const out = applyQuotaPrefix("PKARR is the naming layer.", prefix, SHORT_LIMIT);
    expect(out.startsWith(prefix)).toBe(true);
    expect(out).toContain(`\n${QUOTA_ANSWER_LEADIN}\n`);
    expect(out.endsWith("PKARR is the naming layer.")).toBe(true);
  });

  it("trims the answer, not the prefix, to fit 2000", () => {
    const prefix = quotaNoticeSentence("thread_cap", { now: PINNED });
    const out = applyQuotaPrefix("Word. ".repeat(800).trim(), prefix, SHORT_LIMIT);
    expect(out.length).toBeLessThanOrEqual(SHORT_LIMIT);
    expect(out.startsWith(prefix)).toBe(true);
    expect(out).toContain(QUOTA_ANSWER_LEADIN);
  });
});
