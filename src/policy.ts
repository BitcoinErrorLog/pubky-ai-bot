import type { Store } from "./db.js";

export type PolicyReason = "self" | "blocklist" | "thread_cap" | "user_hour" | "kill" | "db" | "budget" | "rate";

export function authorBlocked(author: string, botPk: string, blocklist: Set<string>): PolicyReason | null {
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

export function botRepliesInChain(chain: Array<{ author: string }>, botPk: string): number {
  return chain.filter((p) => p.author === botPk).length;
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

export async function budgetExceeded(store: Store, ceiling: number, author: string): Promise<boolean> {
  try {
    const global = await store.globalDailyTokens();
    if (global >= ceiling) return true;
    const user = await store.userDailyTokens(author);
    return user >= ceiling;
  } catch {
    return true;
  }
}
