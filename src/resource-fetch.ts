import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { httpUrlRejectReason, isBlockedCatalogHost, isPrivateIPv4, isPrivateIPv6 } from "./resource-url-safety.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_DECLARED_BODY_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 12_000;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const EXTRACTION_WINDOW_CHARS = 256 * 1024;
const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 500;
const USER_AGENT = "JebBot/1.0 (+https://pubky.app; resource tagging)";

export type FetchRejectReason =
  | "invalid_url"
  | "blocked_host"
  | "dns"
  | "private_host"
  | "redirect_http"
  | "too_many_redirects"
  | "robots_disallowed"
  | "robots_unavailable"
  | "timeout"
  | "too_large"
  | "content_type"
  | "http_error"
  | "network";

export type FetchResourceOptions = {
  cacheDir?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  dnsLookup?: typeof lookup;
  log?: (line: Record<string, unknown>) => void;
};

export type FetchResourceResult =
  | {
      ok: true;
      text: string;
      title?: string;
      description?: string;
      finalUrl: string;
      bytes: number;
      truncated: boolean;
      fromCache: boolean;
    }
  | { ok: false; reason: FetchRejectReason };

type CacheRecord = {
  text: string;
  title?: string;
  description?: string;
  finalUrl: string;
  bytes: number;
  truncated: boolean;
  headers: Record<string, string>;
  fetchedAt: string;
};

type RobotsRule = { path: string; allow: boolean };
type RobotsState = { rules: RobotsRule[]; unavailable?: boolean };

const robotsCache = new Map<string, RobotsState>();
const hostLastFetch = new Map<string, number>();

export function resetFetchState(): void {
  robotsCache.clear();
  hostLastFetch.clear();
}

function isPrivateAddress(value: string): boolean {
  const ip = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (ip.includes(".") && !ip.includes(":")) return isPrivateIPv4(ip);
  return isPrivateIPv6(ip);
}

export async function preflightResourceUrl(
  value: string,
  dnsLookup: typeof lookup = lookup,
): Promise<FetchRejectReason | null> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid_url";
  }
  const safety = httpUrlRejectReason(url.toString());
  if (safety) {
    return safety.includes("private") || safety.includes("loopback") ? "private_host" :
      safety.includes("protocol") ? "redirect_http" :
        safety.includes("production target") ? "blocked_host" : "invalid_url";
  }
  if (isBlockedCatalogHost(url.hostname)) return "private_host";
  try {
    const addresses = await dnsLookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some((address) => isPrivateAddress(address.address))) return "private_host";
  } catch {
    return "dns";
  }
  return null;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"",
  };
  return value
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => named[name.toLowerCase()] ?? whole);
}

function stripTags(value: string): string {
  let text = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf("<", cursor);
    if (start < 0) {
      text += value.slice(cursor);
      break;
    }
    text += value.slice(cursor, start);
    const end = value.indexOf(">", start + 1);
    if (end < 0) break;
    if (end - start <= 4097) cursor = end + 1;
    else cursor = start + 1;
    text += " ";
  }
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match?.[1] ? decodeEntities(match[1].trim()) : undefined;
}

function findTags(body: string, name: string, maxLength: number): string[] {
  const tags: string[] = [];
  const searchable = body.toLowerCase();
  let cursor = 0;
  const prefix = `<${name.toLowerCase()}`;
  while (cursor < body.length) {
    const start = searchable.indexOf(prefix, cursor);
    if (start < 0) break;
    const end = searchable.indexOf(">", start + prefix.length);
    if (end < 0) break;
    if (end - start <= maxLength) tags.push(body.slice(start, end + 1));
    cursor = end + 1;
  }
  return tags;
}

function removeDelimited(value: string, open: string, close: string, maxLength: number): string {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf(open, cursor);
    if (start < 0) {
      output += value.slice(cursor);
      break;
    }
    output += value.slice(cursor, start);
    const end = value.indexOf(close, start + open.length);
    if (end < 0 || end - start > maxLength) {
      output += " ";
      cursor = end < 0 ? value.length : start + open.length;
    } else {
      output += " ";
      cursor = end + close.length;
    }
  }
  return output;
}

export function extractResourceText(body: string): Pick<CacheRecord, "text" | "title" | "description"> {
  const extractionBody = body.slice(0, EXTRACTION_WINDOW_CHARS);
  const title = extractionBody.match(/<title\b[^>]{0,1024}>([\s\S]{0,4096}?)<\/title>/i)?.[1];
  const meta = findTags(extractionBody, "meta", 1025);
  let description: string | undefined;
  for (const tag of meta) {
    const name = (htmlAttribute(tag, "name") ?? htmlAttribute(tag, "property"))?.toLowerCase();
    if (name === "description" || name === "og:description") description ??= htmlAttribute(tag, "content");
  }
  const cleaned = removeDelimited(extractionBody, "<!--", "-->", 4096)
    .replace(/<(script|style|noscript|svg|nav|footer|header)\b[^>]{0,1024}>[\s\S]{0,65536}?(?:<\/\1>|$)/gi, " ");
  const preferred = cleaned.match(/<(main|article)\b[^>]{0,1024}>([\s\S]{0,65536}?)<\/\1>/i)?.[2];
  const text = stripTags(preferred ?? cleaned).slice(0, MAX_TEXT_CHARS);
  return {
    text,
    ...(title ? { title: stripTags(title).slice(0, MAX_TITLE_CHARS) } : {}),
    ...(description ? { description: stripTags(description).slice(0, MAX_DESCRIPTION_CHARS) } : {}),
  };
}

function parseCharset(contentType: string): string {
  return contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
}

async function readLimited(
  response: Response,
): Promise<{ bytes: number; body: Uint8Array; truncated: boolean } | { reason: "too_large" }> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DECLARED_BODY_BYTES) return { reason: "too_large" };
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength <= MAX_BODY_BYTES) return { bytes: body.byteLength, body, truncated: false };
    return { bytes: MAX_BODY_BYTES, body: body.subarray(0, MAX_BODY_BYTES), truncated: true };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = MAX_BODY_BYTES - bytes;
      if (next.value.byteLength > remaining) {
        chunks.push(next.value.subarray(0, remaining));
        bytes = MAX_BODY_BYTES;
        await reader.cancel();
        return { bytes, body: joinChunks(chunks, bytes), truncated: true };
      }
      chunks.push(next.value);
      bytes += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes, body: joinChunks(chunks, bytes), truncated: false };
}

function joinChunks(chunks: Uint8Array[], bytes: number): Uint8Array {
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function parseRobots(text: string, agent = "jeb"): RobotsRule[] {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let current: { agents: string[]; rules: RobotsRule[] } | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (key.toLowerCase() === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key.toLowerCase() === "allow" || key.toLowerCase() === "disallow") && current) {
      current.rules.push({ path: value, allow: key.toLowerCase() === "allow" });
    }
  }
  const selected = groups.filter((group) => group.agents.includes(agent) || group.agents.includes("*"));
  const exact = selected.filter((group) => group.agents.includes(agent));
  return (exact.length ? exact : selected).flatMap((group) => group.rules).filter((rule) => rule.path);
}

export function robotsAllows(pathname: string, rules: readonly RobotsRule[]): boolean {
  const matching = rules.filter((rule) => pathname.startsWith(rule.path)).sort((a, b) => b.path.length - a.path.length);
  return matching[0]?.allow ?? true;
}

async function waitForHost(host: string): Promise<void> {
  const last = hostLastFetch.get(host) ?? 0;
  const wait = 2_000 - (Date.now() - last);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  hostLastFetch.set(host, Date.now());
}

async function getRobots(url: URL, fetchImpl: typeof fetch, timeoutMs: number, dnsLookup: typeof lookup): Promise<RobotsState> {
  const host = url.hostname.toLowerCase();
  const cached = robotsCache.get(host);
  if (cached) return cached;
  const preflight = await preflightResourceUrl(url.toString(), dnsLookup);
  if (preflight) return { rules: [], unavailable: true };
  await waitForHost(host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`https://${url.host}/robots.txt`, {
      headers: { "user-agent": USER_AGENT }, redirect: "manual", signal: controller.signal,
    });
    if (response.status === 404) {
      const state = { rules: [] };
      robotsCache.set(host, state);
      return state;
    }
    if (response.status >= 500 || !response.ok) return { rules: [], unavailable: true };
    const limited = await readLimited(response);
    if ("reason" in limited) return { rules: [], unavailable: true };
    const state = { rules: parseRobots(new TextDecoder().decode(limited.body)) };
    robotsCache.set(host, state);
    return state;
  } catch {
    return { rules: [], unavailable: true };
  } finally {
    clearTimeout(timer);
  }
}

function cachePath(cacheDir: string, url: string): string {
  return join(cacheDir, `${createHash("sha256").update(url).digest("hex")}.json`);
}

export async function fetchResourceText(urlValue: string, opts: FetchResourceOptions = {}): Promise<FetchResourceResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const dnsLookup = opts.dnsLookup ?? lookup;
  const cacheDir = opts.cacheDir ?? "/tmp/jeb-pilot-shadow/fetch-cache";
  let current = urlValue;
  let redirects = 0;
  const log = opts.log ?? ((line) => console.error(JSON.stringify(line)));
  const finish = (result: FetchResourceResult, status?: number, bytes = 0): FetchResourceResult => {
    log({ url: urlValue, status, bytes, reason: result.ok ? undefined : result.reason, elapsed: Date.now() - started });
    return result;
  };
  while (true) {
    const preflight = await preflightResourceUrl(current, dnsLookup);
    if (preflight) return finish({ ok: false, reason: preflight });
    const host = new URL(current).hostname.toLowerCase();
    const robots = await getRobots(new URL(current), fetchImpl, timeoutMs, dnsLookup);
    if (robots.unavailable) return finish({ ok: false, reason: "robots_unavailable" });
    if (!robotsAllows(new URL(current).pathname, robots.rules)) return finish({ ok: false, reason: "robots_disallowed" });
    try {
      const cached = JSON.parse(await readFile(cachePath(cacheDir, current), "utf8")) as CacheRecord;
      return finish({ ok: true, text: cached.text, title: cached.title, description: cached.description, finalUrl: cached.finalUrl, bytes: cached.bytes, truncated: cached.truncated ?? false, fromCache: true }, 200, cached.bytes);
    } catch {
      // Cache misses are expected.
    }
    await waitForHost(host);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // undici is not a direct dependency here, so the native fetch cannot receive the
      // preflight address without changing the dependency graph; DNS rebinding remains a
      // documented residual TOCTOU risk for this fetch boundary.
      const response = await fetchImpl(current, {
        headers: { accept: "text/html, text/plain", "user-agent": USER_AGENT },
        redirect: "manual", signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return finish({ ok: false, reason: "http_error" }, response.status);
        if (++redirects > MAX_REDIRECTS) return finish({ ok: false, reason: "too_many_redirects" }, response.status);
        const redirect = new URL(location, current);
        if (redirect.protocol !== "https:") return finish({ ok: false, reason: "redirect_http" }, response.status);
        current = redirect.toString();
        continue;
      }
      if (!response.ok) return finish({ ok: false, reason: "http_error" }, response.status);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("text/html") && !contentType.startsWith("text/plain")) {
        return finish({ ok: false, reason: "content_type" }, response.status);
      }
      const limited = await readLimited(response);
      if ("reason" in limited) return finish({ ok: false, reason: limited.reason }, response.status);
      const decoded = new TextDecoder(parseCharset(contentType)).decode(limited.body);
      const extracted = contentType.startsWith("text/plain")
        ? { text: decoded.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS) }
        : extractResourceText(decoded);
      const record: CacheRecord = {
        ...extracted, finalUrl: current, bytes: limited.bytes, truncated: limited.truncated,
        headers: Object.fromEntries(response.headers.entries()), fetchedAt: new Date().toISOString(),
      };
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath(cacheDir, current), JSON.stringify(record), "utf8");
      return finish({ ok: true, ...extracted, finalUrl: current, bytes: limited.bytes, truncated: limited.truncated, fromCache: false }, response.status, limited.bytes);
    } catch (error) {
      return finish({ ok: false, reason: error instanceof Error && error.name === "AbortError" ? "timeout" : "network" });
    } finally {
      clearTimeout(timer);
    }
  }
}
