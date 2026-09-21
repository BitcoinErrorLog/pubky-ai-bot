import { createHash } from "node:crypto";
import { z } from "zod";
import type pg from "pg";
import { log } from "../log.js";
import { finalizeWebCall, reserveWebCall, webBudgetError, webSwitchBlocked } from "./budget.js";
import { braveWebSearch } from "./brave.js";
import { kimiUrlFetch, kimiWebSearch } from "./kimi.js";
import { WebToolError, webUnavailable } from "./error.js";
import type { WebToolsConfig } from "./web-config.js";
import { insertWebQuery, type Queryable, type WebStore } from "./web-store.js";

export const SEARCH_WEB_TOOL_NAME = "search_web";

/** Neutral Kit default. Callers may inject a different description; Jeb uses this text. */
export const SEARCH_WEB_TOOL_DESCRIPTION =
  "Research the live web. Pro search is the default and returns cited passages with source authority. Basic returns source cards. Fetch reads only an exact URL returned earlier in this mention.";

export const searchWebParameters = z.object({
  mode: z.enum(["pro", "basic", "fetch"]).optional(),
  query: z.string().min(1).max(400).optional(),
  url: z.string().url().max(512).optional(),
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

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export function allowedFetchUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      !host ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      host === "::1" ||
      host === "::" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb") ||
      isPrivateIpv4(host)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
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
  kimi?: typeof kimiWebSearch;
  fetchUrl?: typeof kimiUrlFetch;
  brave?: typeof braveWebSearch;
}) {
  const kimi = opts.kimi ?? kimiWebSearch;
  const fetchUrl = opts.fetchUrl ?? kimiUrlFetch;
  const brave = opts.brave ?? braveWebSearch;
  const store = opts.store ?? (opts.pool ? storeFromPool(opts.pool) : undefined);
  const citedUrls = new Set<string>();

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
      const mode = args.mode ?? "pro";
      const query = args.query?.trim();
      const fetchTarget = args.url ? allowedFetchUrl(args.url) : null;
      if (provider === "off") return webUnavailable("DISABLED");
      if (mode === "fetch") {
        if (provider !== "kimi" || !fetchTarget || !citedUrls.has(fetchTarget)) {
          return webUnavailable("UNAVAILABLE");
        }
      } else if (!query) {
        return webUnavailable("UNAVAILABLE");
      }
      if (await webSwitchBlocked(opts.storeSwitchOn)) return webUnavailable("SWITCH");
      if (!opts.pool) return webBudgetError("budgets_unavailable").toPublic();
      const budgetSubject = mode === "fetch" ? fetchTarget! : query!;
      const gate = await reserveWebCall(opts.pool, opts.cfg, {
        mentionKey: opts.mentionKey,
        provider: mode === "fetch" ? `${provider}:fetch` : `${provider}:${mode}`,
        queryHash: queryHash(budgetSubject),
      });
      if (gate.blocked) return webBudgetError(gate.reason ?? "budget").toPublic();
      const started = Date.now();
      const finish = async (row: {
        provider: string;
        query: string;
        ok: boolean;
        sources_count: number;
        duration_ms: number;
      }): Promise<void> => {
        if (gate.reservationId) {
          await finalizeWebCall(opts.pool!, gate.reservationId, {
            provider: row.provider,
            ok: row.ok,
            sourcesCount: row.sources_count,
            durationMs: row.duration_ms,
          });
          return;
        }
        await record(row);
      };
      const limit =
        args.limit !== undefined ? Math.min(20, Math.max(1, Math.floor(args.limit))) : undefined;
      try {
        if (provider === "brave") {
          if (mode === "fetch") return webUnavailable("UNAVAILABLE");
          const out = await brave(opts.cfg, { query: query!, recency: args.recency, limit });
          await finish({
            provider: "brave",
            query: query!,
            ok: true,
            sources_count: out.sources.length,
            duration_ms: Date.now() - started,
          }).catch((err: unknown) => {
            log.warn({ err, tool: "search_web" }, "web_queries audit insert failed");
          });
          return out;
        }
        if (mode === "fetch") {
          const out = await fetchUrl(opts.cfg, { url: fetchTarget! });
          await finish({
            provider: "kimi:fetch",
            query: fetchTarget!,
            ok: out.billable,
            sources_count: out.billable ? 1 : 0,
            duration_ms: Date.now() - started,
          }).catch((err: unknown) => {
            log.warn({ err, tool: "search_web" }, "web_queries audit insert failed");
          });
          return out;
        }
        const out = await kimi(opts.cfg, {
          query: query!,
          mode,
          recency: args.recency,
          limit,
        });
        for (const source of out.sources) {
          const safeUrl = allowedFetchUrl(source.url);
          if (safeUrl) citedUrls.add(safeUrl);
        }
        await finish({
          provider: `kimi:${mode}`,
          query: query!,
          ok: out.billable,
          sources_count: out.sources.length,
          duration_ms: Date.now() - started,
        }).catch((err: unknown) => {
          log.warn({ err, tool: "search_web" }, "web_queries audit insert failed");
        });
        return out;
      } catch (e) {
        await finish({
          provider,
          query: mode === "fetch" ? args.url! : query!,
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
