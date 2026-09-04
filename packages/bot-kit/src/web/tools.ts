import { createHash } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import { log } from "../log.js";
import { checkWebBudgets, webBudgetError, webSwitchBlocked } from "./budget.js";
import { braveWebSearch } from "./brave.js";
import { WebToolError, webUnavailable } from "./error.js";
import { moonshotWebSearch } from "./moonshot.js";
import type { WebToolsConfig } from "./web-config.js";
import { insertWebQuery, type Queryable, type WebStore } from "./web-store.js";

export const SEARCH_WEB_TOOL_NAME = "search_web";

/** Neutral Kit default. Callers may inject a different description; Jeb uses this text. */
export const SEARCH_WEB_TOOL_DESCRIPTION =
  "Search the live web for current events. Returns titles, URLs, and snippets. Does not fetch arbitrary pages.";

export const searchWebParameters = z.object({
  query: z.string().min(1).max(400),
  recency: z.enum(["day", "week", "month", "year"]).optional(),
  limit: z.number().int().positive().max(20).optional(),
});

export type SearchWebArgs = z.infer<typeof searchWebParameters>;

/** Register search_web only when the provider is not off and a budget pool exists. */
export function shouldRegisterSearchWeb(
  cfg: Pick<WebToolsConfig, "webProvider">,
  pool: pg.Pool | undefined,
): pool is pg.Pool {
  return cfg.webProvider !== "off" && pool !== undefined;
}

function queryHash(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

function storeFromPool(pool: pg.Pool): WebStore {
  return {
    insertWebQuery: (row) => insertWebQuery(pool as unknown as Queryable, row),
  };
}

export function createSearchWebTool(opts: {
  cfg: WebToolsConfig;
  pool?: pg.Pool;
  mentionKey?: string;
  storeSwitchOn: () => Promise<boolean>;
  store?: WebStore;
  description?: string;
  moonshot?: typeof moonshotWebSearch;
  brave?: typeof braveWebSearch;
}) {
  const moonshot = opts.moonshot ?? moonshotWebSearch;
  const brave = opts.brave ?? braveWebSearch;
  const store = opts.store ?? (opts.pool ? storeFromPool(opts.pool) : undefined);

  const record = async (row: {
    provider: string;
    query: string;
    ok: boolean;
    sources_count: number;
    duration_ms: number;
  }) => {
    if (!store) return;
    await store.insertWebQuery({
      provider: row.provider,
      queryHash: queryHash(row.query),
      ok: row.ok,
      sourcesCount: row.sources_count,
      durationMs: row.duration_ms,
      mentionKey: opts.mentionKey ?? null,
    });
  };

  return {
    description: opts.description ?? SEARCH_WEB_TOOL_DESCRIPTION,
    parameters: searchWebParameters,
    execute: async (args: SearchWebArgs) => {
      const provider = opts.cfg.webProvider;
      if (provider === "off") return webUnavailable("DISABLED");
      if (await webSwitchBlocked(opts.storeSwitchOn)) return webUnavailable("SWITCH");
      if (!opts.pool) return webBudgetError("budgets_unavailable").toPublic();
      const gate = await checkWebBudgets(opts.pool, opts.cfg, { mentionKey: opts.mentionKey });
      if (gate.blocked) return webBudgetError(gate.reason ?? "budget").toPublic();
      const started = Date.now();
      const limit =
        args.limit !== undefined ? Math.min(20, Math.max(1, Math.floor(args.limit))) : undefined;
      try {
        if (provider === "brave") {
          const out = await brave(opts.cfg, { query: args.query, recency: args.recency, limit });
          await record({
            provider: "brave",
            query: args.query,
            ok: true,
            sources_count: out.sources.length,
            duration_ms: Date.now() - started,
          }).catch((err: unknown) => {
            log.warn({ err, tool: "search_web" }, "web_queries audit insert failed");
          });
          return out;
        }
        const out = await moonshot(opts.cfg, { query: args.query, recency: args.recency, limit });
        await record({
          provider: "moonshot",
          query: args.query,
          ok: true,
          sources_count: out.sources.length,
          duration_ms: Date.now() - started,
        }).catch((err: unknown) => {
          log.warn({ err, tool: "search_web" }, "web_queries audit insert failed");
        });
        return out;
      } catch (e) {
        await record({
          provider,
          query: args.query,
          ok: false,
          sources_count: 0,
          duration_ms: Date.now() - started,
        }).catch((err: unknown) => {
          log.warn({ err, tool: "search_web" }, "web_queries audit insert failed");
        });
        if (e instanceof WebToolError) return e.toPublic();
        return webUnavailable("INTERNAL");
      }
    },
  };
}
