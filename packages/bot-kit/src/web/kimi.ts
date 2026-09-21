import { postJson } from "../http.js";
import { WebToolError } from "./error.js";
import type { KimiAuthority, WebKimiConfig } from "./web-config.js";

export const KIMI_TOOLS_HOST = "api.moonshot.ai";
const KIMI_TOOLS_ORIGIN = `https://${KIMI_TOOLS_HOST}`;

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
  if (url.host !== KIMI_TOOLS_HOST) throw new Error("ssrf: host not allowed");
  if (url.protocol !== "https:") throw new Error("ssrf: bad protocol");
  if (url.username || url.password) throw new Error("ssrf: credentials not allowed");
}

function endpoint(path: "/v1/tools/search" | "/v1/tools/search_pro" | "/v1/tools/fetch"): URL {
  const url = new URL(path, KIMI_TOOLS_ORIGIN);
  assertKimiToolsUrl(url);
  return url;
}

function timeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.min(60, Math.ceil(timeoutMs / 1_000)));
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

function parseSources(
  body: unknown,
  cfg: WebKimiConfig,
  operation: "basic" | "pro",
): KimiSource[] {
  if (!body || typeof body !== "object") throw new WebToolError("PARSE");
  const rows = (body as { search_results?: unknown }).search_results;
  if (!Array.isArray(rows)) throw new WebToolError("PARSE");
  const sources: KimiSource[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const authority = String(r.authority ?? "").toUpperCase() as KimiAuthority;
    if (!cfg.webAllowedAuthorities.has(authority)) continue;
    if (typeof r.url !== "string" || typeof r.title !== "string") continue;
    const domain = typeof r.site_name === "string" && r.site_name ? r.site_name : sourceDomain(r.url);
    const passages =
      operation === "pro" && Array.isArray(r.chunks)
        ? r.chunks.flatMap((chunk) => {
            if (!chunk || typeof chunk !== "object") return [];
            const c = chunk as Record<string, unknown>;
            return typeof c.text === "string" && typeof c.score === "number"
              ? [{ text: c.text, score: c.score }]
              : [];
          })
        : undefined;
    sources.push({
      url: r.url,
      title: r.title,
      snippet: typeof r.snippet === "string" ? r.snippet : "",
      authority,
      ...(domain ? { source_domain: domain } : {}),
      ...(typeof r.date === "string" && r.date ? { published_at: r.date } : {}),
      ...(passages ? { passages } : {}),
    });
  }
  return sources;
}

export async function kimiWebSearch(
  cfg: WebKimiConfig,
  args: { query: string; mode?: "basic" | "pro"; recency?: string; limit?: number },
): Promise<KimiSearchResult> {
  if (!cfg.modelApiKey) throw new WebToolError("UNAVAILABLE");
  const operation = args.mode ?? "pro";
  const request: Record<string, unknown> = {
    text_query: args.query,
    limit: Math.min(20, Math.max(1, Math.floor(args.limit ?? 5))),
    timeout_seconds: timeoutSeconds(cfg.webTimeoutMs),
  };
  const start = operation === "pro" ? recencyStart(args.recency) : undefined;
  if (start) request.time_window = { start };
  const response = await postJson(
    endpoint(operation === "pro" ? "/v1/tools/search_pro" : "/v1/tools/search"),
    cfg.webTimeoutMs,
    request,
    { authorization: `Bearer ${cfg.modelApiKey}` },
  );
  if (response.status < 200 || response.status >= 300) throw new WebToolError("HTTP");
  const sources = parseSources(response.body, cfg, operation);
  const billable = sources.length > 0;
  return {
    provider: "kimi",
    operation,
    sources,
    billable,
    cost_usd: billable ? (operation === "pro" ? cfg.webPriceProUsd : cfg.webPriceBasicUsd) : 0,
  };
}

export async function kimiUrlFetch(
  cfg: WebKimiConfig,
  args: { url: string },
): Promise<KimiFetchResult> {
  if (!cfg.modelApiKey) throw new WebToolError("UNAVAILABLE");
  const response = await postJson(
    endpoint("/v1/tools/fetch"),
    cfg.webTimeoutMs,
    { url: args.url },
    { authorization: `Bearer ${cfg.modelApiKey}` },
  );
  if (response.status < 200 || response.status >= 300) throw new WebToolError("HTTP");
  if (!response.body || typeof response.body !== "object") throw new WebToolError("PARSE");
  const body = response.body as Record<string, unknown>;
  if (typeof body.url !== "string" || typeof body.title !== "string" || typeof body.markdown !== "string") {
    throw new WebToolError("PARSE");
  }
  const content = body.markdown.trim().slice(0, cfg.webFetchMaxChars);
  const billable = content.length > 0;
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
