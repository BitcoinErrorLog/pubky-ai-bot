import { createHash } from "node:crypto";
import { ownerBudgetKey } from "./env.js";
import { screenAskUntrusted } from "./screen.js";
import { assertBraveUrl, braveWebSearch } from "../bot-kit/web/brave.js";
import { BRAVE_HOST } from "../bot-kit/web/brave.js";
import { moonshotWebSearch } from "../bot-kit/web/moonshot.js";
import { MOONSHOT_BASE_URL } from "../bot-kit/brain/egress.js";
import type { WebProvider, WebToolsConfig } from "../bot-kit/web/web-config.js";
import { UTC_DAY_START_SQL } from "../bot-kit/scout/budget.js";
import { fetchJson } from "../bot-kit/http.js";

export const PUBCHI_WEB_TIMEOUT_MS = 8_000;
export const PUBCHI_WEB_MAX_RESULTS = 5;
export const MOONSHOT_HOST = "api.moonshot.ai";

export type PubchiWebError = "WEB_DISABLED" | "WEB_BUDGET" | "WEB_UNAVAILABLE" | "WEB_TIMEOUT";
export type PubchiWebResult = {
  results: Array<{ title: string; url: string; snippet: string }>;
  provider: Exclude<WebProvider, "off">;
  ms: number;
};
export type PubchiWebOutcome = PubchiWebResult | { error: PubchiWebError };

export type PubchiWebBudget = {
  allow(owner: string): Promise<boolean>;
};

export type PubchiWebTelemetry = {
  provider: Exclude<WebProvider, "off">;
  query_hash: string;
  result_count: number;
  ms: number;
  owner_key_hash: string;
};

type Clock = () => number;
type ProviderResult = {
  sources: Array<{ title?: string; url: string; snippet?: string }>;
};
type ProviderSearch = (cfg: WebToolsConfig, args: { query: string; limit: number }) => Promise<ProviderResult>;

export type PubchiWebSearchOptions = {
  providerConfig: WebToolsConfig & { webEnabled?: boolean };
  owner: string;
  budget: PubchiWebBudget;
  clock?: Clock;
  telemetry?: (event: PubchiWebTelemetry) => void | Promise<void>;
  providers?: Partial<Record<Exclude<WebProvider, "off">, ProviderSearch>>;
  braveFetch?: typeof fetchJson;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerHost(provider: Exclude<WebProvider, "off">): string {
  return provider === "brave" ? BRAVE_HOST : MOONSHOT_HOST;
}

export function assertWebSearchConfig(cfg: WebToolsConfig): WebToolsConfig {
  const provider = cfg.webProvider;
  if (provider === "off") return cfg;
  if (provider === "brave") {
    assertBraveUrl(new URL("https://api.search.brave.com/res/v1/web/search"));
    return cfg;
  }
  const modelBaseUrl = cfg.modelBaseUrl?.trim() || MOONSHOT_BASE_URL;
  const configured = new URL(modelBaseUrl);
  if (configured.protocol !== "https:" || configured.host !== providerHost(provider)) {
    throw new Error("web provider host is not allowed");
  }
  return { ...cfg, modelBaseUrl };
}

function validResultUrl(raw: string): string | null {
  if (raw.length > 512) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
    if (!url.hostname.includes(".") || /\s/.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function screened(value: unknown, max: number): string {
  return String(screenAskUntrusted(value)).replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizedResults(result: ProviderResult): PubchiWebResult["results"] {
  const seen = new Set<string>();
  const results: PubchiWebResult["results"] = [];
  for (const source of result.sources) {
    const url = validResultUrl(source.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: screened(source.title ?? "", 160),
      url,
      snippet: screened(source.snippet ?? "", 240),
    });
    if (results.length === PUBCHI_WEB_MAX_RESULTS) break;
  }
  return results;
}

function timed<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WEB_TIMEOUT")), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export function createPubchiWebSearch(opts: PubchiWebSearchOptions): {
  search(query: string, k?: number): Promise<PubchiWebOutcome>;
} {
  const providerConfig = assertWebSearchConfig(opts.providerConfig);
  const provider = providerConfig.webProvider;
  const clock = opts.clock ?? Date.now;
  const searchers: Record<Exclude<WebProvider, "off">, ProviderSearch> = {
    brave: async (cfg, args) => braveWebSearch(cfg, args, opts.braveFetch ?? fetchJson),
    moonshot: async (cfg, args) => moonshotWebSearch(cfg, args),
    ...opts.providers,
  };

  const emit = async (event: PubchiWebTelemetry): Promise<void> => {
    await opts.telemetry?.(event);
  };

  return {
    async search(query, k = PUBCHI_WEB_MAX_RESULTS): Promise<PubchiWebOutcome> {
      const started = clock();
      const emitOutcome = async (resultCount: number): Promise<void> => {
        if (provider === "off") return;
        await emit({
          provider,
          query_hash: sha256(query),
          result_count: resultCount,
          ms: Math.max(0, clock() - started),
          owner_key_hash: sha256(ownerBudgetKey(opts.owner)),
        });
      };
      if (opts.providerConfig.webEnabled !== true || provider === "off") return { error: "WEB_DISABLED" };
      if (!query.trim() || query.length > 400) return { error: "WEB_UNAVAILABLE" };
      if (k < 1 || k > PUBCHI_WEB_MAX_RESULTS) return { error: "WEB_UNAVAILABLE" };
      if (!(await opts.budget.allow(opts.owner))) {
        await emitOutcome(0);
        return { error: "WEB_BUDGET" };
      }
      try {
        const raw = await timed(searchers[provider](providerConfig, { query, limit: k }), PUBCHI_WEB_TIMEOUT_MS);
        const results = normalizedResults(raw).slice(0, k);
        await emitOutcome(results.length);
        return { results, provider, ms: Math.max(0, clock() - started) };
      } catch (error) {
        await emitOutcome(0);
        return { error: error instanceof Error && error.message === "WEB_TIMEOUT" ? "WEB_TIMEOUT" : "WEB_UNAVAILABLE" };
      }
    },
  };
}

export function memoryPubchiWebBudget(opts: {
  ownerDailyCap?: number;
  globalDailyCap?: number;
  clock?: Clock;
} = {}): PubchiWebBudget & { ownerCounts: Map<string, number>; globalCount(): number } {
  const ownerDailyCap = opts.ownerDailyCap ?? 20;
  const globalDailyCap = opts.globalDailyCap ?? 500;
  const ownerCounts = new Map<string, number>();
  let global = 0;
  let day = "";
  const reset = () => {
    const next = new Date((opts.clock ?? Date.now)()).toISOString().slice(0, 10);
    if (next !== day) {
      day = next;
      ownerCounts.clear();
      global = 0;
    }
  };
  return {
    ownerCounts,
    globalCount: () => {
      reset();
      return global;
    },
    async allow(owner) {
      reset();
      const key = `${day}:${ownerBudgetKey(owner)}`;
      const count = ownerCounts.get(key) ?? 0;
      if (count >= ownerDailyCap || global >= globalDailyCap) return false;
      ownerCounts.set(key, count + 1);
      global += 1;
      return true;
    },
  };
}

export function postgresPubchiWebBudget(
  pool: {
    query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<{ n?: string }> }>;
    connect?: () => Promise<{ query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<{ n?: string }> }>; release(): void }>;
  },
  opts: { ownerDailyCap?: number; globalDailyCap?: number } = {},
): PubchiWebBudget {
  const ownerDailyCap = opts.ownerDailyCap ?? 20;
  const globalDailyCap = opts.globalDailyCap ?? 500;
  return {
    async allow(owner) {
      const key = ownerBudgetKey(owner);
      const client = pool.connect ? await pool.connect() : undefined;
      const db = client ?? pool;
      try {
        if (client) await client.query("BEGIN");
        if (client) await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", ["web_search", key]);
        const ownerResult = await db.query(
          `SELECT count(*)::text AS n FROM scout_queries WHERE tool = $1 AND mention_key = $2 AND created_at >= ${UTC_DAY_START_SQL}`,
          ["web_search", key],
        );
        const globalResult = await db.query(
          `SELECT count(*)::text AS n FROM scout_queries WHERE tool = $1 AND created_at >= ${UTC_DAY_START_SQL}`,
          ["web_search"],
        );
        const allowed = Number(ownerResult.rows[0]?.n ?? 0) < ownerDailyCap && Number(globalResult.rows[0]?.n ?? 0) < globalDailyCap;
        if (allowed) {
          await db.query(
            `INSERT INTO scout_queries (tool, cypher_hash, params_hash, rows, truncated, duration_ms, ok, error_code, mention_key)
             VALUES ($1, $2, $2, 0, FALSE, 0, FALSE, 'BUDGET_RESERVED', $3)`,
            ["web_search", "budget-reservation", key],
          );
        }
        if (client) await client.query("COMMIT");
        return allowed;
      } catch (error) {
        if (client) await client.query("ROLLBACK");
        throw error;
      } finally {
        client?.release();
      }
    },
  };
}
