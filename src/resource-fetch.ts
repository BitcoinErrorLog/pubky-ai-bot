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
  const lower = value.toLowerCase();
  const ip = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
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

const SKIPPED_ELEMENTS = new Set(["script", "style", "noscript", "svg", "nav", "footer", "header"]);
const MAX_SCANNED_TAG_CHARS = 1024;

function decodedEntity(value: string): string | undefined {
  const lower = value.toLowerCase();
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"",
  };
  if (named[lower]) return named[lower];
  let radix = 10;
  let digits = value;
  if (lower.startsWith("#x")) {
    radix = 16;
    digits = value.slice(2);
  } else if (value.startsWith("#")) {
    digits = value.slice(1);
  } else {
    return undefined;
  }
  if (!digits || ![...digits].every((char) => radix === 16
    ? (char >= "0" && char <= "9") || (char.toLowerCase() >= "a" && char.toLowerCase() <= "f")
    : char >= "0" && char <= "9")) return undefined;
  const codePoint = parseInt(digits, radix);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return undefined;
  return String.fromCodePoint(codePoint);
}

function normalizeExtractedText(value: string, maxChars: number): string {
  const output: string[] = [];
  let entity = "";
  let inEntity = false;
  let pendingSpace = false;
  const emit = (char: string): void => {
    if (isHtmlWhitespace(char)) {
      pendingSpace = output.length > 0;
      return;
    }
    if (pendingSpace && output.length < maxChars) output.push(" ");
    pendingSpace = false;
    if (output.length < maxChars) output.push(char);
  };
  const flushEntity = (terminator = ""): void => {
    for (const char of `&${entity}${terminator}`) emit(char);
    entity = "";
    inEntity = false;
  };
  for (const char of value) {
    if (!inEntity) {
      if (char === "&") {
        inEntity = true;
        entity = "";
      } else {
        emit(char);
      }
    } else if (char === ";") {
      const decoded = decodedEntity(entity);
      if (decoded === undefined) flushEntity(";");
      else {
        entity = "";
        inEntity = false;
        for (const decodedChar of decoded) emit(decodedChar);
      }
    } else if (char === "&" || entity.length >= 32) {
      flushEntity();
      if (char === "&") inEntity = true;
      else emit(char);
    } else {
      entity += char;
    }
  }
  if (inEntity) flushEntity();
  return output.join("");
}

function normalizePlainText(value: string, maxChars: number): string {
  const output: string[] = [];
  let pendingSpace = false;
  for (const char of value) {
    if (isHtmlWhitespace(char)) {
      pendingSpace = output.length > 0;
    } else {
      if (pendingSpace && output.length < maxChars) output.push(" ");
      pendingSpace = false;
      if (output.length < maxChars) output.push(char);
    }
  }
  return output.join("");
}

function isHtmlWhitespace(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff;
}

function isTagNameChar(char: string): boolean {
  const lower = char.toLowerCase();
  return (lower >= "a" && lower <= "z") || (char >= "0" && char <= "9") || char === ":" || char === "-";
}

function parseTagName(tag: string): { name: string; closing: boolean; selfClosing: boolean } {
  let cursor = 1;
  while (cursor < tag.length && isHtmlWhitespace(tag[cursor])) cursor += 1;
  const closing = tag[cursor] === "/";
  if (closing) {
    cursor += 1;
    while (cursor < tag.length && isHtmlWhitespace(tag[cursor])) cursor += 1;
  }
  const start = cursor;
  while (cursor < tag.length && isTagNameChar(tag[cursor])) cursor += 1;
  let end = tag.length - 2;
  while (end >= 0 && isHtmlWhitespace(tag[end])) end -= 1;
  return { name: tag.slice(start, cursor).toLowerCase(), closing, selfClosing: tag[end] === "/" };
}

function parseTagAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  let cursor = 1;
  while (cursor < tag.length && !isHtmlWhitespace(tag[cursor]) && tag[cursor] !== ">") cursor += 1;
  while (cursor < tag.length - 1) {
    while (cursor < tag.length && (isHtmlWhitespace(tag[cursor]) || tag[cursor] === "/")) cursor += 1;
    const nameStart = cursor;
    while (cursor < tag.length && isTagNameChar(tag[cursor])) cursor += 1;
    const name = tag.slice(nameStart, cursor).toLowerCase();
    while (cursor < tag.length && isHtmlWhitespace(tag[cursor])) cursor += 1;
    if (!name || tag[cursor] !== "=") {
      while (cursor < tag.length && !isHtmlWhitespace(tag[cursor]) && tag[cursor] !== ">") cursor += 1;
      continue;
    }
    cursor += 1;
    while (cursor < tag.length && isHtmlWhitespace(tag[cursor])) cursor += 1;
    const quote = tag[cursor] === "\"" || tag[cursor] === "'" ? tag[cursor++] : "";
    const valueStart = cursor;
    if (quote) {
      while (cursor < tag.length && tag[cursor] !== quote) cursor += 1;
    } else {
      while (cursor < tag.length && !isHtmlWhitespace(tag[cursor]) && tag[cursor] !== ">") cursor += 1;
    }
    attributes.set(name, normalizeExtractedText(tag.slice(valueStart, cursor), Number.MAX_SAFE_INTEGER));
    if (quote && tag[cursor] === quote) cursor += 1;
  }
  return attributes;
}

export function extractResourceText(body: string): Pick<CacheRecord, "text" | "title" | "description"> {
  const extractionBody = body.slice(0, EXTRACTION_WINDOW_CHARS);
  const allText: string[] = [];
  const preferredText: string[] = [];
  const titleText: string[] = [];
  const skipped: string[] = [];
  let preferredDepth = 0;
  let preferredFound = false;
  let titleDepth = 0;
  let titleFound = false;
  let description: string | undefined;
  let cursor = 0;
  const append = (char: string): void => {
    if (skipped.length > 0) return;
    allText.push(char);
    if (preferredDepth > 0) preferredText.push(char);
    if (titleDepth > 0 && !titleFound) titleText.push(char);
  };
  while (cursor < extractionBody.length) {
    const char = extractionBody[cursor];
    if (char !== "<") {
      append(char);
      cursor += 1;
      continue;
    }
    if (extractionBody.startsWith("<!--", cursor)) {
      cursor += 4;
      while (cursor < extractionBody.length && !extractionBody.startsWith("-->", cursor)) cursor += 1;
      cursor = Math.min(extractionBody.length, cursor + 3);
      append(" ");
      continue;
    }
    const tagStart = cursor;
    const tagChars: string[] = ["<"];
    cursor += 1;
    let quote = "";
    let complete = false;
    while (cursor < extractionBody.length) {
      const tagChar = extractionBody[cursor++];
      if (tagChars.length <= MAX_SCANNED_TAG_CHARS) tagChars.push(tagChar);
      if (quote) {
        if (tagChar === quote) quote = "";
      } else if (tagChar === "\"" || tagChar === "'") {
        quote = tagChar;
      } else if (tagChar === ">") {
        complete = true;
        break;
      }
    }
    if (!complete) break;
    append(" ");
    if (cursor - tagStart > MAX_SCANNED_TAG_CHARS + 1) continue;
    const tag = tagChars.join("");
    const parsed = parseTagName(tag);
    if (!parsed.name) continue;
    if (skipped.length > 0) {
      if (!parsed.closing && SKIPPED_ELEMENTS.has(parsed.name) && !parsed.selfClosing) skipped.push(parsed.name);
      else if (parsed.closing && parsed.name === skipped[skipped.length - 1]) skipped.pop();
      continue;
    }
    if (!parsed.closing && SKIPPED_ELEMENTS.has(parsed.name)) {
      if (!parsed.selfClosing) skipped.push(parsed.name);
      continue;
    }
    if (parsed.name === "title") {
      if (parsed.closing) {
        if (titleDepth > 0) titleDepth -= 1;
        if (titleDepth === 0 && titleText.length > 0) titleFound = true;
      } else if (!parsed.selfClosing && !titleFound) {
        titleDepth += 1;
      }
    }
    if (parsed.name === "main" || parsed.name === "article") {
      if (parsed.closing) {
        if (preferredDepth > 0) {
          preferredDepth -= 1;
          if (preferredDepth === 0 && preferredText.length > 0) preferredFound = true;
        }
      } else if (!parsed.selfClosing && !preferredFound) {
        preferredDepth += 1;
      }
    }
    if (!parsed.closing && parsed.name === "meta" && description === undefined) {
      const attributes = parseTagAttributes(tag);
      const metaName = (attributes.get("name") ?? attributes.get("property"))?.toLowerCase();
      if (metaName === "description" || metaName === "og:description") {
        const content = attributes.get("content")?.trim();
        if (content) description = content;
      }
    }
  }
  const text = normalizeExtractedText((preferredFound ? preferredText : allText).join(""), MAX_TEXT_CHARS);
  const title = titleFound ? normalizeExtractedText(titleText.join(""), MAX_TITLE_CHARS) : "";
  return {
    text,
    ...(title ? { title } : {}),
    ...(description ? { description: normalizeExtractedText(description, MAX_DESCRIPTION_CHARS) } : {}),
  };
}

function parseCharset(contentType: string): string {
  const lower = contentType.toLowerCase();
  const marker = lower.indexOf("charset");
  if (marker < 0) return "utf-8";
  let cursor = marker + "charset".length;
  while (cursor < contentType.length && isHtmlWhitespace(contentType[cursor])) cursor += 1;
  if (contentType[cursor] !== "=") return "utf-8";
  cursor += 1;
  while (cursor < contentType.length && isHtmlWhitespace(contentType[cursor])) cursor += 1;
  const quote = contentType[cursor] === "\"" || contentType[cursor] === "'" ? contentType[cursor++] : "";
  const start = cursor;
  while (
    cursor < contentType.length &&
    contentType[cursor] !== ";" &&
    contentType[cursor] !== "\"" &&
    contentType[cursor] !== "'" &&
    !isHtmlWhitespace(contentType[cursor])
  ) cursor += 1;
  if (quote && contentType[cursor] !== quote) return "utf-8";
  return contentType.slice(start, cursor) || "utf-8";
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
  for (const raw of text.split("\n")) {
    const comment = raw.indexOf("#");
    const line = (comment >= 0 ? raw.slice(0, comment) : raw).trim();
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
      // HTTPS plus TLS hostname verification bounds DNS rebinding: an internal target must
      // present a valid certificate for the requested hostname, so plain-HTTP internal
      // services fail during the handshake. The residual risk is a connect oracle and SNI
      // leak to an internal service listening on port 443.
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
        ? { text: normalizePlainText(decoded, MAX_TEXT_CHARS) }
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
