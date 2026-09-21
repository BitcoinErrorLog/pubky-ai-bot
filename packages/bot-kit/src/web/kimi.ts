import { postJson } from "../http.js";
import { WebToolError } from "./error.js";
import type { KimiAuthority, WebToolsConfig } from "./web-config.js";

export const KIMI_TOOLS_HOST = "api.moonshot.ai";
const KIMI_TOOLS_ORIGIN = `https://${KIMI_TOOLS_HOST}`;
export const KIMI_SEARCH_ORIGIN = KIMI_TOOLS_ORIGIN;
export const KIMI_SEARCH_API_TIMEOUT_SECONDS = 7;
export const KIMI_SEARCH_HTTP_TIMEOUT_MS = 7_500;
export const KIMI_SEARCH_COST_USD = 0.002;
export const KIMI_SEARCH_MAX_RESULTS = 5;

const KIMI_TOOL_PATHS = new Set([
  "/v1/tools/search",
  "/v1/tools/search_pro",
  "/v1/tools/fetch",
]);

export interface KimiSource {
  url: string;
  title: string;
  snippet: string;
  source_domain?: string;
  published_at?: string;
  authority: KimiAuthority;
  passages?: Array<{ text: string; score: number }>;
}

export interface KimiSearchResult {
  sources: KimiSource[];
  provider: "kimi";
  operation: "basic" | "pro";
  billable: boolean;
  cost_usd: number;
}

export interface KimiFetchResult {
  provider: "kimi";
  operation: "fetch";
  url: string;
  title: string;
  content: string;
  billable: boolean;
  cost_usd: number;
}

export function assertKimiToolsUrl(url: URL): void {
  if (url.protocol !== "https:") throw new Error("ssrf: bad protocol");
  if (url.host !== KIMI_TOOLS_HOST) throw new Error("ssrf: host not allowed");
  if (url.username || url.password) throw new Error("ssrf: credentials not allowed");
  if (!KIMI_TOOL_PATHS.has(url.pathname) || url.search || url.hash) {
    throw new Error("ssrf: path not allowed");
  }
}

function endpoint(path: "/v1/tools/search" | "/v1/tools/search_pro" | "/v1/tools/fetch"): URL {
  const url = new URL(path, KIMI_TOOLS_ORIGIN);
  assertKimiToolsUrl(url);
  return url;
}

function timeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.min(60, Math.ceil(timeoutMs / 1_000)));
}

function errorForStatus(status: number): WebToolError {
  if (status === 401 || status === 403) return new WebToolError("AUTH");
  if (status === 429) return new WebToolError("RATE_LIMIT");
  if (status === 408 || status === 504) return new WebToolError("TIMEOUT");
  return new WebToolError("HTTP");
}

function sourceDomain(raw: string): string | undefined {
  try {
    return new URL(raw).hostname;
  } catch {
    return undefined;
  }
}

function recencyStart(recency: string | undefined, now = new Date()): string | undefined {
  if (!recency) return undefined;
  const days = recency === "day" ? 1 : recency === "week" ? 7 : recency === "month" ? 31 : 366;
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

const AUTHORITY_ORDER: Record<KimiAuthority, number> = { S: 0, A: 1, B: 2, C: 3 };
const MAX_OFFICIAL_PREFERENCE_BONUS = 0.05;

function preferredDomainIndex(rawUrl: string, preferredDomains: readonly string[]): number {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return -1;
  }
  return preferredDomains.findIndex((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function maxPassageScore(source: KimiSource): number {
  return Math.max(0, ...(source.passages ?? []).map((passage) => passage.score));
}

/**
 * Apply a bounded first-party preference after the authority allow-filter.
 * Authority remains the primary order. Pro relevance remains dominant because
 * the official-domain bonus is capped; Basic has no passage score, so its
 * stable order prefers configured first-party domains within one authority.
 */
function rankSources(
  sources: KimiSource[],
  cfg: WebToolsConfig,
  operation: "basic" | "pro",
): KimiSource[] {
  const ranked = sources.map((source, index) => ({
    source,
    index,
    preferredIndex: preferredDomainIndex(source.url, cfg.webPreferredDomains ?? []),
  }));
  if (!ranked.some((row) => row.preferredIndex >= 0)) return sources;
  ranked.sort((left, right) => {
    const authority = AUTHORITY_ORDER[left.source.authority] - AUTHORITY_ORDER[right.source.authority];
    if (authority !== 0) return authority;
    if (operation === "pro") {
      const leftScore =
        maxPassageScore(left.source) +
        (left.preferredIndex >= 0 ? MAX_OFFICIAL_PREFERENCE_BONUS / (left.preferredIndex + 1) : 0);
      const rightScore =
        maxPassageScore(right.source) +
        (right.preferredIndex >= 0 ? MAX_OFFICIAL_PREFERENCE_BONUS / (right.preferredIndex + 1) : 0);
      if (leftScore !== rightScore) return rightScore - leftScore;
    } else if (left.preferredIndex !== right.preferredIndex) {
      if (left.preferredIndex < 0) return 1;
      if (right.preferredIndex < 0) return -1;
      return left.preferredIndex - right.preferredIndex;
    }
    return left.index - right.index;
  });
  return ranked.map((row) => row.source);
}

function parseSources(
  body: unknown,
  cfg: WebToolsConfig,
  operation: "basic" | "pro",
): KimiSource[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new WebToolError("PARSE");
  const rows = (body as { search_results?: unknown }).search_results;
  if (!Array.isArray(rows)) throw new WebToolError("PARSE");
  const sources: KimiSource[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new WebToolError("PARSE");
    const r = row as Record<string, unknown>;
    if (
      typeof r.authority !== "string" ||
      typeof r.url !== "string" ||
      typeof r.title !== "string" ||
      typeof r.snippet !== "string"
    ) {
      throw new WebToolError("PARSE");
    }
    const authority = r.authority.toUpperCase() as KimiAuthority;
    if (!cfg.webAllowedAuthorities.has(authority)) continue;
    if (!/^https:\/\//i.test(r.url)) continue;
    const domain = typeof r.site_name === "string" && r.site_name ? r.site_name : sourceDomain(r.url);
    const passages =
      operation === "pro" && Array.isArray(r.chunks)
        ? r.chunks.flatMap((chunk) => {
            if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
              throw new WebToolError("PARSE");
            }
            const c = chunk as Record<string, unknown>;
            if (typeof c.text !== "string" || typeof c.score !== "number") {
              throw new WebToolError("PARSE");
            }
            return [{ text: c.text, score: c.score }];
          })
        : undefined;
    sources.push({
      url: r.url,
      title: r.title,
      snippet: r.snippet,
      authority,
      ...(domain ? { source_domain: domain } : {}),
      ...(typeof r.date === "string" && r.date ? { published_at: r.date } : {}),
      ...(passages ? { passages } : {}),
    });
  }
  return rankSources(sources, cfg, operation);
}

export async function kimiWebSearch(
  cfg: WebToolsConfig,
  args: {
    query: string;
    mode?: "basic" | "pro";
    recency?: string;
    limit?: number;
    timeoutSeconds?: number;
  },
): Promise<KimiSearchResult> {
  if (!cfg.modelApiKey) throw new WebToolError("UNAVAILABLE");
  const operation = args.mode ?? "pro";
  const request: Record<string, unknown> = {
    text_query: args.query,
    limit: Math.min(20, Math.max(1, Math.floor(args.limit ?? KIMI_SEARCH_MAX_RESULTS))),
    timeout_seconds: args.timeoutSeconds ?? timeoutSeconds(cfg.webTimeoutMs),
  };
  if (operation === "basic") request.include_content = false;
  const start = operation === "pro" ? recencyStart(args.recency) : undefined;
  if (start) request.time_window = { start };
  let response: Awaited<ReturnType<typeof postJson>>;
  try {
    response = await postJson(
      endpoint(operation === "pro" ? "/v1/tools/search_pro" : "/v1/tools/search"),
      cfg.webTimeoutMs,
      request,
      { authorization: `Bearer ${cfg.modelApiKey}` },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new WebToolError("TIMEOUT");
    if (error instanceof Error && error.message === "response too large") throw new WebToolError("PARSE");
    throw new WebToolError("HTTP");
  }
  if (response.status < 200 || response.status >= 300) throw errorForStatus(response.status);
  const rawResults =
    response.body && typeof response.body === "object"
      ? (response.body as { search_results?: unknown }).search_results
      : undefined;
  const billable = Array.isArray(rawResults) && rawResults.length > 0;
  const billedCostUsd = operation === "pro" ? cfg.webPriceProUsd : cfg.webPriceBasicUsd;
  let sources: KimiSource[];
  try {
    sources = parseSources(response.body, cfg, operation);
  } catch (error) {
    if (billable && error instanceof WebToolError) {
      throw new WebToolError(error.code, undefined, billedCostUsd);
    }
    throw error;
  }
  return {
    provider: "kimi",
    operation,
    sources,
    billable,
    cost_usd: billable ? billedCostUsd : 0,
  };
}

export async function kimiUrlFetch(
  cfg: WebToolsConfig,
  args: { url: string },
): Promise<KimiFetchResult> {
  if (!cfg.modelApiKey) throw new WebToolError("UNAVAILABLE");
  let response: Awaited<ReturnType<typeof postJson>>;
  try {
    response = await postJson(
      endpoint("/v1/tools/fetch"),
      cfg.webTimeoutMs,
      { url: args.url },
      { authorization: `Bearer ${cfg.modelApiKey}` },
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new WebToolError("TIMEOUT");
    if (error instanceof Error && error.message === "response too large") throw new WebToolError("PARSE");
    throw new WebToolError("HTTP");
  }
  if (response.status < 200 || response.status >= 300) throw errorForStatus(response.status);
  if (!response.body || typeof response.body !== "object" || Array.isArray(response.body)) {
    throw new WebToolError("PARSE");
  }
  const body = response.body as Record<string, unknown>;
  const billable = typeof body.markdown === "string" && body.markdown.trim().length > 0;
  if (typeof body.url !== "string" || typeof body.title !== "string" || typeof body.markdown !== "string") {
    throw new WebToolError("PARSE", undefined, billable ? cfg.webPriceFetchUsd : 0);
  }
  const content = body.markdown.trim().slice(0, cfg.webFetchMaxChars);
  return {
    provider: "kimi",
    operation: "fetch",
    url: body.url,
    title: body.title,
    content,
    billable,
    cost_usd: billable ? cfg.webPriceFetchUsd : 0,
  };
}
