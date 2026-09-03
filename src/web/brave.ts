import type { Config } from "../config.js";
import { fetchJson } from "../http.js";
import { WebToolError } from "./error.js";
import { sourceDomain } from "./urls.js";

export const BRAVE_HOST = "api.search.brave.com";
export const BRAVE_ORIGIN = "https://api.search.brave.com";

const FRESHNESS: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

export interface BraveSource {
  url: string;
  title: string;
  snippet: string;
  published_at?: string;
  source_domain?: string;
}

export interface BraveSearchResult {
  sources: BraveSource[];
  provider: "brave";
}

export function assertBraveUrl(url: URL): void {
  if (url.host !== BRAVE_HOST) throw new Error("ssrf: host not allowed");
  if (url.protocol !== "https:") throw new Error("ssrf: bad protocol");
}

function braveSearchUrl(query: string, count: number, recency?: string): URL {
  const url = new URL("/res/v1/web/search", `${BRAVE_ORIGIN}/`);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  if (recency && FRESHNESS[recency]) url.searchParams.set("freshness", FRESHNESS[recency]);
  assertBraveUrl(url);
  return url;
}

export async function braveWebSearch(
  cfg: Pick<Config, "braveApiKey" | "webTimeoutMs">,
  args: { query: string; recency?: string; limit?: number },
  fetchImpl: typeof fetchJson = fetchJson,
): Promise<BraveSearchResult> {
  if (!cfg.braveApiKey) throw new WebToolError("UNAVAILABLE");
  const count = Math.min(20, Math.max(1, Math.floor(args.limit ?? 8)));
  const url = braveSearchUrl(args.query, count, args.recency);
  const { status, body } = await fetchImpl(url, cfg.webTimeoutMs, {
    "X-Subscription-Token": cfg.braveApiKey,
  });
  if (status < 200 || status >= 300) throw new WebToolError("HTTP");
  if (!body || typeof body !== "object") throw new WebToolError("PARSE");
  const web = (body as { web?: { results?: unknown } }).web;
  const rows = Array.isArray(web?.results) ? web.results : [];
  const sources: BraveSource[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.url !== "string" || !/^https?:\/\//i.test(r.url)) continue;
    sources.push({
      url: r.url,
      title: typeof r.title === "string" ? r.title : "",
      snippet: typeof r.description === "string" ? r.description : typeof r.snippet === "string" ? r.snippet : "",
      ...(typeof r.page_age === "string" ? { published_at: r.page_age } : typeof r.age === "string" ? { published_at: r.age } : {}),
      source_domain: sourceDomain(r.url),
    });
  }
  return { sources: sources.slice(0, count), provider: "brave" };
}
