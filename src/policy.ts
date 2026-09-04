import type { Store } from "./db.js";
import { log } from "./log.js";
import { parsePostUri } from "./types.js";

export const SKIP_REASONS = [
  "thread_cap",
  "user_turn_cap",
  "user_hourly_cap",
  "bot_author",
  "bot_loop",
  "unaddressed",
  "blocklist",
  "budget",
  "optout",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

/** Abuse / identity skips: no public reply. */
export const SILENT_SKIPS = ["blocklist", "bot_author", "unaddressed", "bot_loop", "self", "optout"] as const;
export type SilentSkip = (typeof SILENT_SKIPS)[number];

/** Resource / limit skips: one honest notice unless anti-spam suppresses it. */
export const NOTIFIED_SKIPS = ["budget", "user_hourly_cap", "user_turn_cap", "thread_cap"] as const;
export type NotifiedSkip = (typeof NOTIFIED_SKIPS)[number];

export function isNotifiedSkip(reason: string): reason is NotifiedSkip {
  return (NOTIFIED_SKIPS as readonly string[]).includes(reason);
}

export function isSilentSkip(reason: string): reason is SilentSkip {
  return (SILENT_SKIPS as readonly string[]).includes(reason);
}

/** @deprecated use SkipReason; kept for authorBlocked's self-skip */
export type PolicyReason = "self" | SkipReason;

export function authorBlocked(author: string, botPk: string, blocklist: Set<string>): "self" | "blocklist" | null {
  if (author === botPk) return "self";
  if (blocklist.has(author)) return "blocklist";
  return null;
}

export function threadCapped(publishedInThread: number, cap: number): boolean {
  return publishedInThread >= cap;
}

export function userHourCapped(count: number, limit: number): boolean {
  return count >= limit;
}

export function userTurnCapped(turnsWithAsker: number, cap: number): boolean {
  return turnsWithAsker >= cap;
}

export function botRepliesInChain(chain: Array<{ author: string }>, botPk: string): number {
  return chain.filter((p) => p.author === botPk).length;
}

/**
 * Jeb replies already in this ancestor walk that were answering `asker`
 * (child authored by Jeb, parent authored by the asker).
 */
export function jebTurnsWithAsker(chain: Array<{ author: string }>, botPk: string, asker: string): number {
  let n = 0;
  for (let i = 0; i < chain.length - 1; i++) {
    const child = chain[i];
    const parent = chain[i + 1];
    if (child?.author === botPk && parent?.author === asker) n++;
  }
  return n;
}

/**
 * Explicit mention of Jeb, or a direct reply to one of Jeb's posts.
 */
export function isAddressedTurn(args: {
  botPk: string;
  content: string;
  mentioned?: string[] | null;
  parentUri?: string | null;
}): boolean {
  if (args.mentioned?.includes(args.botPk)) return true;
  const c = args.content;
  if (c.includes(args.botPk)) return true;
  // A post with no reply parent is a mention notification (ingest never
  // queues ambient activity). Direct reply to Jeb is also a turn.
  if (!args.parentUri) return true;
  try {
    return parsePostUri(args.parentUri).author === args.botPk;
  } catch {
    return false;
  }
}

/**
 * Loop guard: Jeb already replied to Jeb, or ≥3 consecutive bot-authored posts.
 */
export function botLoopInChain(
  chain: Array<{ author: string }>,
  botPk: string,
  isBotAuthor: (pk: string) => boolean,
): boolean {
  for (let i = 0; i < chain.length - 1; i++) {
    if (chain[i]?.author === botPk && chain[i + 1]?.author === botPk) return true;
  }
  let run = 0;
  for (const p of chain) {
    if (p.author === botPk || isBotAuthor(p.author)) {
      run++;
      if (run >= 3) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

export function conversationDecision(args: {
  addressed: boolean;
  automatedReplier: boolean;
  botLoop: boolean;
  jebRepliesInThread: number;
  maxRepliesPerThread: number;
  jebTurnsWithAsker: number;
  maxTurnsPerUserPerThread: number;
  userHourCount: number;
  maxPerUserPerHour: number;
  budgetExceeded: boolean;
  blocklisted: boolean;
  optedOut?: boolean;
}): SkipReason | null {
  if (args.blocklisted) return "blocklist";
  if (args.optedOut) return "optout";
  if (args.automatedReplier) return "bot_author";
  if (!args.addressed) return "unaddressed";
  if (args.botLoop) return "bot_loop";
  if (threadCapped(args.jebRepliesInThread, args.maxRepliesPerThread)) return "thread_cap";
  if (userTurnCapped(args.jebTurnsWithAsker, args.maxTurnsPerUserPerThread)) return "user_turn_cap";
  if (userHourCapped(args.userHourCount, args.maxPerUserPerHour)) return "user_hourly_cap";
  if (args.budgetExceeded) return "budget";
  return null;
}

/**
 * Automation heuristic: an account declares itself a bot in its profile
 * name or bio. Word-boundary matching so "OtherBot" (a display name) is
 * not a declaration, but "OtherBot (automated)" or "I am a bot" is.
 */
const AUTOMATION_DECLARATION = /\b(bots?|robot|automated|automation|auto[\s-]?post(er|ing)?)\b/i;

export function declaredAutomation(user: { name?: string | null; bio?: string | null } | null): boolean {
  if (!user) return false;
  return AUTOMATION_DECLARATION.test(`${user.name ?? ""}\n${user.bio ?? ""}`);
}

export function replierIsAutomated(
  author: string,
  user: { name?: string | null; bio?: string | null } | null,
  knownBots?: Set<string>,
): boolean {
  return knownBots?.has(author) === true || declaredAutomation(user);
}

export async function blacklistDenied(store: Store, author: string, envList: Set<string>): Promise<boolean> {
  if (envList.has(author)) return true;
  try {
    return await store.blacklistHas(author);
  } catch {
    return true;
  }
}

export async function rateLimited(store: Store, author: string, limit: number): Promise<boolean> {
  try {
    const n = await store.rateCountLastHour(author);
    if (n >= limit) return true;
    await store.recordRateEvent(author);
    return false;
  } catch {
    return true;
  }
}

export const TYPICAL_ANSWER_TOKENS_FALLBACK = 20_000;

export async function budgetExceeded(
  store: Store,
  ceilings: { global: number; user: number },
  author: string,
): Promise<boolean> {
  try {
    const typicalCost = await store.typicalAnswerTokensP50();
    const global = await store.globalDailyTokens();
    await maybeWarnBudget(store, global, ceilings.global);
    if (global + typicalCost > ceilings.global) return true;
    const user = await store.userDailyTokens(author);
    return user + typicalCost > ceilings.user;
  } catch {
    return true;
  }
}

/** Persist-once `budget_warning` when UTC-day global spend crosses 80% of the ceiling. */
export async function maybeWarnBudget(store: Store, globalSpend: number, ceiling: number): Promise<boolean> {
  if (ceiling <= 0 || globalSpend < ceiling * 0.8) return false;
  const day = new Date().toISOString().slice(0, 10);
  const claimed = await store.claimOperatorFlag(`budget_warning:${day}`);
  if (!claimed) return false;
  log.warn({ event: "budget_warning", spend: globalSpend, ceiling, day }, "budget_warning");
  return true;
}
