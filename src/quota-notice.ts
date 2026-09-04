import { lintVoice } from "./voice.js";

export const QUOTA_NOTICE_RULES = [
  "user_daily_budget",
  "global_daily_budget",
  "user_hourly_cap",
  "user_turn_cap",
  "thread_cap",
] as const;

export type QuotaNoticeRule = (typeof QUOTA_NOTICE_RULES)[number];

export const QUOTA_ANSWER_LEADIN = "Here's your answer:";

export interface QuotaNoticeCounters {
  userTokens: number;
  globalTokens: number;
  typicalCost: number;
  userDailyCeiling: number;
  globalDailyCeiling: number;
  userHourCount: number;
  maxPerUserPerHour: number;
  jebTurnsWithAsker: number;
  maxTurnsPerUserPerThread: number;
  jebRepliesInThread: number;
  maxRepliesPerThread: number;
}

/**
 * First matching rule wins. A rule fires when this accepted answer is the
 * last one the quota permits (the next one would skip).
 */
export function decideQuotaNotice(c: QuotaNoticeCounters): QuotaNoticeRule | null {
  if (isLastAffordable(c.userTokens, c.typicalCost, c.userDailyCeiling)) return "user_daily_budget";
  if (isLastAffordable(c.globalTokens, c.typicalCost, c.globalDailyCeiling)) return "global_daily_budget";
  if (c.userHourCount + 1 === c.maxPerUserPerHour) return "user_hourly_cap";
  if (c.jebTurnsWithAsker + 1 === c.maxTurnsPerUserPerThread) return "user_turn_cap";
  if (c.jebRepliesInThread + 1 === c.maxRepliesPerThread) return "thread_cap";
  return null;
}

function isLastAffordable(spent: number, typicalCost: number, ceiling: number): boolean {
  if (typicalCost <= 0 || ceiling <= 0) return false;
  return spent + typicalCost <= ceiling && spent + 2 * typicalCost > ceiling;
}

export function msUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(0, next - now.getTime());
}

export function wholeHoursMinutes(ms: number): { h: number; m: number } {
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  return { h: Math.floor(totalMin / 60), m: totalMin % 60 };
}

export function minutesUntilHourlyAgeOut(oldest: Date, now: Date): number {
  const ageOut = oldest.getTime() + 3_600_000;
  return Math.max(0, Math.floor((ageOut - now.getTime()) / 60_000));
}

export function quotaNoticeSentence(
  rule: QuotaNoticeRule,
  opts: { now: Date; oldestHourly?: Date | null },
): string {
  const raw = rawQuotaNoticeSentence(rule, opts);
  const linted = lintVoice(raw);
  if (linted.violations.length) {
    throw new Error(`quota notice ${rule} failed voice lint: ${linted.violations.map((v) => v.rule).join(",")}`);
  }
  return linted.text;
}

export function rawQuotaNoticeSentence(
  rule: QuotaNoticeRule,
  opts: { now: Date; oldestHourly?: Date | null },
): string {
  const { h, m } = wholeHoursMinutes(msUntilUtcMidnight(opts.now));
  switch (rule) {
    case "user_daily_budget":
      return `This is my last reply to you today; my budget for you resets at 00:00 UTC (in about ${h}h ${m}m).`;
    case "global_daily_budget":
      return `This is my last reply for today; my budget resets at 00:00 UTC (in about ${h}h ${m}m).`;
    case "user_hourly_cap": {
      const mins =
        opts.oldestHourly instanceof Date ? minutesUntilHourlyAgeOut(opts.oldestHourly, opts.now) : 60;
      return `This is my last reply to you this hour; I'll pick up again in about ${mins} minutes.`;
    }
    case "user_turn_cap":
      return "This is my last reply to you in this thread; start a new post if you want to keep going.";
    case "thread_cap":
      return "This is my last reply in this thread; start a new post and I'll answer there.";
  }
}
