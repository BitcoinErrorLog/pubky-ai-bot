import type pg from "pg";
import type { Config } from "../config.js";
import { envSwitchOn } from "../switches.js";
import { WebToolError } from "./error.js";

export interface WebBudgetGate {
  blocked: boolean;
  reason?: string;
}

export async function webSwitchBlocked(storeSwitchOn: () => Promise<boolean>): Promise<boolean> {
  if (envSwitchOn("web") || envSwitchOn("global")) return true;
  return storeSwitchOn();
}

export async function checkWebBudgets(
  pool: pg.Pool,
  cfg: Pick<Config, "webPerMentionCap" | "webDailyCeiling">,
  opts: { mentionKey?: string },
): Promise<WebBudgetGate> {
  const day = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM web_queries WHERE created_at >= date_trunc('day', now()) AND ok = TRUE`,
  );
  if (Number(day.rows[0]?.n ?? 0) >= cfg.webDailyCeiling) {
    return { blocked: true, reason: "daily_web_ceiling" };
  }
  if (opts.mentionKey) {
    const m = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM web_queries WHERE mention_key = $1`,
      [opts.mentionKey],
    );
    if (Number(m.rows[0]?.n ?? 0) >= cfg.webPerMentionCap) {
      return { blocked: true, reason: "per_mention_web_cap" };
    }
  }
  return { blocked: false };
}

export function webBudgetError(reason: string): WebToolError {
  return new WebToolError("BUDGET", `web search unavailable (${reason})`);
}
