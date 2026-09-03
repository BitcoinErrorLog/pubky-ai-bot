import { globToRegExp } from "./glob.js";
import { extractHref, htmlToText } from "./html.js";
import { parseRobotsTxt, pathAllowedByRobots, type RobotsRules } from "./robots.js";
import type { SourceEntry } from "./types.js";

export const HTTP_SITE_TIMEOUT_MS = 30_000;
export const HTTP_SITE_MAX_BYTES = 2 * 1024 * 1024;
export const HTTP_SITE_DEFAULT_MAX_PAGES = 60;
export const HTTP_SITE_MAX_REDIRECTS = 5;
export const HTTP_SITE_UA = "jeb-knowledge-ingest/1.0";

export interface SitePage {
  path: string;
  url: string;
  text: string;
  version: string;
}

function allowPath(pathname: string, globs: string[]): boolean {
  if (globs.length === 0) return true;
  return globs.some((g) => {
    const re = globToRegExp(g.endsWith("*") && !g.endsWith("**") ? `${g.replace(/\*$/, "")}**` : g);
    return re.test(pathname);
  });
}

function sameHost(a: URL, b: URL): boolean {
  return a.host === b.host && (a.protocol === "http:" || a.protocol === "https:") && a.protocol === b.protocol;
}

async function fetchBounded(
  url: URL,
  origin: URL,
  opts: { timeoutMs: number; maxBytes: number },
  hop = 0,
): Promise<{ url: URL; text: string; contentType: string; etag: string | null; lastMod: string | null }> {
  if (hop > HTTP_SITE_MAX_REDIRECTS) throw new Error(`http-site too many redirects ${url.href}`);
  const res = await fetch(url, {
    headers: { "user-agent": HTTP_SITE_UA },
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    if (!loc) throw new Error(`http-site redirect without location ${url.href}`);
    const next = new URL(loc, url);
    if (!sameHost(next, origin)) throw new Error(`http-site cross-host redirect refused ${next.href}`);
    return fetchBounded(next, origin, opts, hop + 1);
  }
  if (!res.ok) throw new Error(`http ${res.status} ${url.href}`);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > opts.maxBytes) throw new Error(`http source too large (> ${opts.maxBytes} bytes)`);
  const text = buf.toString("utf8").replace(/\u0000/g, "");
  return {
    url,
    text,
    contentType,
    etag: res.headers.get("etag"),
    lastMod: res.headers.get("last-modified"),
  };
}

async function loadRobots(origin: URL, timeoutMs: number): Promise<RobotsRules> {
  try {
    const robotsUrl = new URL("/robots.txt", origin);
    const res = await fetch(robotsUrl, {
      headers: { "user-agent": HTTP_SITE_UA },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { disallow: [], allow: [] };
    const text = await res.text();
    return parseRobotsTxt(text, HTTP_SITE_UA);
  } catch {
    return { disallow: [], allow: [] };
  }
}

function canonicalPath(u: URL): string {
  return u.pathname === "" ? "/" : u.pathname;
}

export async function crawlHttpSite(
  entry: SourceEntry,
  opts?: { timeoutMs?: number; maxBytes?: number },
): Promise<SitePage[]> {
  const timeoutMs = opts?.timeoutMs ?? HTTP_SITE_TIMEOUT_MS;
  const maxBytes = opts?.maxBytes ?? HTTP_SITE_MAX_BYTES;
  const maxPages = entry.max_pages ?? HTTP_SITE_DEFAULT_MAX_PAGES;
  const allow = entry.allow_paths ?? [];
  const origin = new URL(entry.location);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error(`http-site invalid location ${entry.location}`);
  }
  const robots = await loadRobots(origin, timeoutMs);
  const queue: URL[] = [origin];
  const seen = new Set<string>();
  const pages: SitePage[] = [];
  while (queue.length && pages.length < maxPages) {
    const next = queue.shift();
    if (!next) break;
    next.hash = "";
    if (!sameHost(next, origin)) continue;
    const path = canonicalPath(next);
    if (!allowPath(path, allow)) continue;
    if (!pathAllowedByRobots(path, robots)) continue;
    const key = `${next.origin}${path}${next.search}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let fetched;
    try {
      fetched = await fetchBounded(next, origin, { timeoutMs, maxBytes });
    } catch {
      continue;
    }
    const ct = fetched.contentType;
    if (ct && ct !== "text/html" && ct !== "application/xhtml+xml") continue;
    const text = htmlToText(fetched.text);
    if (!text) continue;
    pages.push({
      path,
      url: fetched.url.href,
      text,
      version: fetched.etag ?? fetched.lastMod ?? new Date().toISOString(),
    });
    for (const href of extractHref(fetched.text, fetched.url)) {
      href.hash = "";
      if (!sameHost(href, origin)) continue;
      const p = canonicalPath(href);
      if (!allowPath(p, allow)) continue;
      if (!pathAllowedByRobots(p, robots)) continue;
      const k = `${href.origin}${p}${href.search}`;
      if (!seen.has(k)) queue.push(href);
    }
  }
  return pages;
}
