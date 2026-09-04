/**
 * Effective public policy limits for operator visibility.
 *
 * Wiring: from `runReason` after config load, log once:
 *   log.info(policySummary(cfg), "effective policy limits");
 * Do not log the rest of `cfg` (it contains key material). This module is not
 * imported by `reason.ts` yet; operators also see the same object in
 * `npm run dashboard`.
 *
 * Defaults match `src/config.ts` `configFromProcessEnv`. This file does not
 * import `config.ts` or `keys.ts`.
 */

export interface PolicySummaryInput {
  maxRepliesPerThread: number;
  maxTurnsPerUserPerThread: number;
  maxPerUserPerHour: number;
  dailyTokenBudget: number;
  userDailyTokenBudget: number;
  modelTimeoutMs: number;
  answerBudgetMs: number;
  replyDeadlineMs: number;
  pollMs: number;
  knownBots: ReadonlySet<string> | Set<string>;
  blocklist: ReadonlySet<string> | Set<string>;
}

export interface PolicySummary {
  maxRepliesPerThread: number;
  maxTurnsPerUserPerThread: number;
  maxPerUserPerHour: number;
  dailyTokenBudget: number;
  userDailyTokenBudget: number;
  modelTimeoutMs: number;
  answerBudgetMs: number;
  replyDeadlineMs: number;
  pollMs: number;
  knownBotsCount: number;
  blocklistCount: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`invalid ${name}`);
  return n;
}

function csvSet(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Same numeric defaults and env names as `configFromProcessEnv`. */
export function policyLimitsFromEnv(): PolicySummaryInput {
  return {
    maxRepliesPerThread: num("JEB_MAX_REPLIES_PER_THREAD", 12),
    maxTurnsPerUserPerThread: num("JEB_MAX_TURNS_PER_USER_PER_THREAD", 6),
    maxPerUserPerHour: num("JEB_MAX_PER_USER_PER_HOUR", 5),
    dailyTokenBudget: num("JEB_DAILY_TOKEN_BUDGET", 5_000_000),
    userDailyTokenBudget: num("JEB_USER_DAILY_TOKEN_BUDGET", 600_000),
    modelTimeoutMs: num("JEB_MODEL_TIMEOUT_MS", 30_000),
    answerBudgetMs: num("JEB_ANSWER_BUDGET_MS", 180_000),
    replyDeadlineMs: num("JEB_REPLY_DEADLINE_MS", 240_000),
    pollMs: num("JEB_POLL_MS", 3_000),
    knownBots: csvSet("JEB_KNOWN_BOTS"),
    blocklist: csvSet("JEB_BLOCKLIST"),
  };
}

export function policySummary(cfg: PolicySummaryInput): PolicySummary {
  return {
    maxRepliesPerThread: cfg.maxRepliesPerThread,
    maxTurnsPerUserPerThread: cfg.maxTurnsPerUserPerThread,
    maxPerUserPerHour: cfg.maxPerUserPerHour,
    dailyTokenBudget: cfg.dailyTokenBudget,
    userDailyTokenBudget: cfg.userDailyTokenBudget,
    modelTimeoutMs: cfg.modelTimeoutMs,
    answerBudgetMs: cfg.answerBudgetMs,
    replyDeadlineMs: cfg.replyDeadlineMs,
    pollMs: cfg.pollMs,
    knownBotsCount: cfg.knownBots.size,
    blocklistCount: cfg.blocklist.size,
  };
}
