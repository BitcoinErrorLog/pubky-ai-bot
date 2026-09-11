import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  discoverResources,
  normalizeUri,
  RESOURCE_RECORD_MAX,
  resourceIdentity,
  validateResourceLimit,
  type ExternalResourceInput,
  type ResourceRun,
} from "./external-resources.js";
import { parseRobots, robotsAllows, type RobotsRule } from "./resource-fetch.js";
import { isAllowedResourceLabel } from "./resource-label-policy.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";

export const PAPERS_SOURCE_ID = "papers";
/** Hard ceiling on outbound HTTP requests per run (robots, redirect hops, pages). */
export const PAPERS_REQUEST_BUDGET = 100;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_XML_DEPTH = 32;
const MAX_XML_ELEMENTS = 20_000;
const MAX_PAPERS_PER_SOURCE = 100;
const MAX_REDIRECT_HOPS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const ARXIV_MIN_INTERVAL_MS = 3_000;
const IACR_MIN_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const IACR_CLAIM_STALE_MS = 60_000;
const PAPERS_ENDPOINT_POLICY_VERSION = "papers-source-policy-v2";
const MAX_DOI_CHARS = 200;
const MAX_ARXIV_ID_CHARS = 32;
const MAX_EPRINT_ID_CHARS = 16;
const USER_AGENT = "JebBot/1.0 (+https://pubky.app; resource tagging)";

const ARXIV_HOST = "export.arxiv.org";
const IACR_HOST = "eprint.iacr.org";
const CROSSREF_HOST = "api.crossref.org";
const CANONICAL_HOSTS = new Set(["doi.org", "arxiv.org", "eprint.iacr.org"]);
const PAPER_CONTACT_EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const DOI_PATTERN = /^10\.\d{4,9}\/[a-z0-9._;()/:~-]+$/;
const ARXIV_NEW_ID_PATTERN = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
const ARXIV_OLD_ID_PATTERN = /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/;
const EPRINT_ID_PATTERN = /^\d{4}\/\d{1,6}$/;
const ARXIV_CATEGORY_PATTERN = /^[a-z-]+\.[A-Z]{2}$/;
const XML_FORBIDDEN = /<!DOCTYPE|<!ENTITY/i;

const ARXIV_QUERY =
  "search_query=%28all%3Abitcoin%20OR%20all%3A%22lightning%20network%22%29%20AND%20%28cat%3Acs.CR%20OR%20cat%3Acs.DC%20OR%20cat%3Aq-fin%29&start=0";
const IACR_URL = "https://eprint.iacr.org/rss/rss.xml";

function arxivUrl(limit: number): string {
  return `https://${ARXIV_HOST}/api/query?${ARXIV_QUERY}&max_results=${Math.min(limit, MAX_PAPERS_PER_SOURCE)}`;
}

function crossrefUrl(contactEmail: string, limit: number): string {
  const rows = Math.min(limit, MAX_PAPERS_PER_SOURCE);
  return `https://${CROSSREF_HOST}/works?query.bibliographic=bitcoin&rows=${rows}&mailto=${encodeURIComponent(contactEmail)}`;
}

export type SubSource = "arxiv" | "iacr-eprint" | "crossref";

export type Paper = {
  url: string;
  source: SubSource;
  title: string;
  abstract?: string;
  categories: string[];
  doi?: string;
};

export type PaperRowRejection = { source: SubSource; reason: string };
export type PaperParseResult = { papers: Paper[]; rejected: PaperRowRejection[] };
export type PaperParser = (body: string) => PaperParseResult;

export type PapersDiscoverOptions = {
  limit: number;
  contactEmail?: string;
  configVersion?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  cacheDir?: string;
  filesystem?: PapersFilesystem;
  processId?: number;
  isProcessAlive?: (pid: number) => boolean;
  maxRequests?: number;
  parsers?: Partial<Record<SubSource, PaperParser>>;
};

/** Thrown when the per-run outbound request ceiling is reached; never carries a URL. */
export class PapersRequestBudgetExhausted extends Error {
  constructor() {
    super("papers request budget exhausted");
    this.name = "PapersRequestBudgetExhausted";
  }
}

class RequestBudget {
  private used = 0;
  constructor(private readonly ceiling: number) {}
  take(): void {
    if (this.used >= this.ceiling) throw new PapersRequestBudgetExhausted();
    this.used += 1;
  }
  get requests(): number {
    return this.used;
  }
}

type RobotsState = { rules: RobotsRule[]; unavailable?: boolean };

type FetchDeps = {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  budget: RequestBudget;
  robots: Map<string, RobotsState>;
  now: () => number;
  lastRequestAt: Map<string, number>;
};

export type PapersFilesystem = {
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  mkdir: typeof mkdir;
  chmod: typeof chmod;
  lstat: typeof lstat;
  open: typeof open;
  unlink: typeof unlink;
};

type IacrCacheIdentity = {
  source: "iacr-eprint";
  sourceUrl: typeof IACR_URL;
  endpointPolicyVersion: typeof PAPERS_ENDPOINT_POLICY_VERSION;
  maxBodyBytes: typeof MAX_BODY_BYTES;
  responseType: "application/rss+xml";
};

type IacrCacheRecord = IacrCacheIdentity & {
  state: "complete";
  attemptedAtMs: number;
  finalUrl: typeof IACR_URL;
  body: string;
};

type IacrCacheState =
  | { kind: "missing" }
  | { kind: "fresh"; body: string }
  | { kind: "pending" }
  | { kind: "stale" }
  | { kind: "invalid" };

type IacrClaim = { owner: string; pid: number; claimedAtMs: number };

type IacrClaimResult = { kind: "acquired"; claim: IacrClaim } | { kind: "busy" } | { kind: "invalid" };

export function iacrCachePath(cacheDir: string): string {
  const identity = [
    "iacr-eprint",
    IACR_URL,
    PAPERS_ENDPOINT_POLICY_VERSION,
    MAX_BODY_BYTES,
    "application/rss+xml",
  ].join("\n");
  return join(cacheDir, `papers-${createHash("sha256").update(identity).digest("hex")}.json`);
}

function iacrClaimPath(cacheDir: string): string {
  return `${iacrCachePath(cacheDir)}.claim`;
}

function clean(value: string, max = 4_096): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function xmlTag(value: string, name: string): string | undefined {
  return value.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1];
}

/** Refuses DTD/entity markup and unbounded documents instead of processing them. */
function assertSafeXml(body: string): void {
  if (!body.trim()) throw new Error("empty response");
  if (XML_FORBIDDEN.test(body)) throw new Error("forbidden XML declaration");
  let depth = 0;
  let elements = 0;
  for (const match of body.matchAll(/<\/?([A-Za-z][\w:.-]*)(?:\s[^>]*)?\/?>/g)) {
    elements += 1;
    if (elements > MAX_XML_ELEMENTS) throw new Error("XML element count exceeded");
    if (match[0]!.startsWith("</")) depth -= 1;
    else if (!match[0]!.endsWith("/>")) depth += 1;
    if (depth < 0 || depth > MAX_XML_DEPTH) throw new Error("invalid XML depth");
  }
  if (depth !== 0) throw new Error("unbalanced XML");
}

export function validateDoi(raw: string): string | null {
  const doi = raw.trim().toLowerCase();
  if (doi.length > MAX_DOI_CHARS || !DOI_PATTERN.test(doi)) return null;
  const suffix = doi.slice(doi.indexOf("/") + 1);
  if (suffix.startsWith("/") || suffix.endsWith("/") || suffix.includes("..") || suffix.includes("//") || suffix.includes("%")) return null;
  return doi;
}

export function validateArxivId(raw: string): string | null {
  if (raw.length > MAX_ARXIV_ID_CHARS) return null;
  if (!ARXIV_NEW_ID_PATTERN.test(raw) && !ARXIV_OLD_ID_PATTERN.test(raw)) return null;
  return raw.replace(/v\d+$/, "");
}

export function validateEprintId(raw: string): string | null {
  if (raw.length > MAX_EPRINT_ID_CHARS || !EPRINT_ID_PATTERN.test(raw)) return null;
  return raw;
}

/** Canonical identity: DOI URL, else version-stripped arXiv abs URL, else IACR ePrint URL. */
export function canonicalPaperUrl(paper: Pick<Paper, "doi" | "url">): string {
  if (paper.doi !== undefined) {
    const doi = validateDoi(paper.doi);
    if (!doi) throw new Error("invalid DOI");
    return `https://doi.org/${doi}`;
  }
  let url: URL;
  try {
    url = new URL(paper.url);
  } catch {
    throw new Error("invalid paper URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid canonical paper URL");
  }
  if (!CANONICAL_HOSTS.has(url.hostname)) throw new Error("invalid canonical paper host");
  if (url.hostname === "arxiv.org") {
    const raw = url.pathname.match(/^\/abs\/(.+)$/)?.[1] ?? "";
    const id = validateArxivId(raw);
    if (!id) throw new Error("invalid arXiv id");
    return `https://arxiv.org/abs/${id}`;
  }
  if (url.hostname === "eprint.iacr.org") {
    const id = validateEprintId(url.pathname.slice(1));
    if (!id) throw new Error("invalid ePrint id");
    return `https://eprint.iacr.org/${id}`;
  }
  const doi = validateDoi(url.pathname.slice(1));
  if (!doi) throw new Error("invalid DOI");
  return `https://doi.org/${doi}`;
}

export function parseArxivAtom(body: string): PaperParseResult {
  assertSafeXml(body);
  const entries = [...body.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].slice(0, MAX_PAPERS_PER_SOURCE);
  if (entries.length === 0) throw new Error("arXiv response has no entries");
  const papers: Paper[] = [];
  const rejected: PaperRowRejection[] = [];
  for (const entry of entries) {
    const row = entry[1]!;
    const id = clean(xmlTag(row, "id") ?? "", 256);
    const title = clean(xmlTag(row, "title") ?? "", 512);
    const arxivId = id.match(/^https?:\/\/arxiv\.org\/abs\/([^/?#]+)$/)?.[1];
    if (!arxivId || !validateArxivId(arxivId)) {
      rejected.push({ source: "arxiv", reason: "invalid arXiv id" });
      continue;
    }
    if (!title) {
      rejected.push({ source: "arxiv", reason: "missing title" });
      continue;
    }
    const doiRaw = clean(xmlTag(row, "arxiv:doi") ?? "", MAX_DOI_CHARS + 8);
    const doi = doiRaw ? validateDoi(doiRaw) : null;
    const categories = [
      ...new Set(
        [...row.matchAll(/<category\s+[^>]*term=["']([^"']+)["'][^>]*\/?>/gi)]
          .map((match) => match[1]!)
          .filter((value) => value.length <= 16 && ARXIV_CATEGORY_PATTERN.test(value))
          .slice(0, 16),
      ),
    ];
    papers.push({
      url: `https://arxiv.org/abs/${arxivId}`,
      source: "arxiv",
      title,
      abstract: clean(xmlTag(row, "summary") ?? ""),
      categories,
      ...(doi ? { doi } : {}),
    });
  }
  if (papers.length === 0) throw new Error("arXiv rows are malformed");
  return { papers, rejected };
}

export function parseIacrRss(body: string): PaperParseResult {
  assertSafeXml(body);
  const items = [...body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, MAX_PAPERS_PER_SOURCE);
  if (items.length === 0) throw new Error("IACR response has no items");
  const papers: Paper[] = [];
  const rejected: PaperRowRejection[] = [];
  for (const item of items) {
    const row = item[1]!;
    const url = clean(xmlTag(row, "link") ?? "", 256);
    const title = clean(xmlTag(row, "title") ?? "", 512);
    if (!validateEprintId(url.replace(/^https:\/\/eprint\.iacr\.org\//, "")) || !/^https:\/\/eprint\.iacr\.org\//.test(url)) {
      rejected.push({ source: "iacr-eprint", reason: "invalid ePrint link" });
      continue;
    }
    if (!title) {
      rejected.push({ source: "iacr-eprint", reason: "missing title" });
      continue;
    }
    papers.push({ url, source: "iacr-eprint", title, abstract: clean(xmlTag(row, "description") ?? ""), categories: ["cryptography"] });
  }
  if (papers.length === 0) throw new Error("IACR rows are malformed");
  return { papers, rejected };
}

export function parseCrossrefJson(body: string): PaperParseResult {
  if (!body.trim()) throw new Error("empty response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("invalid Crossref JSON");
  }
  const rows =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { message?: { items?: unknown } }).message?.items)
      ? (parsed as { message: { items: unknown[] } }).message.items.slice(0, MAX_PAPERS_PER_SOURCE)
      : [];
  if (rows.length === 0) throw new Error("Crossref response has no items");
  const papers: Paper[] = [];
  const rejected: PaperRowRejection[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      rejected.push({ source: "crossref", reason: "invalid record" });
      continue;
    }
    const item = row as { DOI?: unknown; title?: unknown; abstract?: unknown; subject?: unknown };
    const doi = typeof item.DOI === "string" ? validateDoi(item.DOI) : null;
    if (!doi) {
      rejected.push({ source: "crossref", reason: "invalid DOI" });
      continue;
    }
    const title = Array.isArray(item.title) && typeof item.title[0] === "string" ? clean(item.title[0], 512) : "";
    if (!title) {
      rejected.push({ source: "crossref", reason: "missing title" });
      continue;
    }
    papers.push({
      url: `https://doi.org/${doi}`,
      source: "crossref",
      title,
      abstract: typeof item.abstract === "string" ? clean(item.abstract) : undefined,
      categories: Array.isArray(item.subject)
        ? item.subject.filter((value): value is string => typeof value === "string").map((value) => clean(value, 64)).slice(0, 16)
        : [],
      doi,
    });
  }
  if (papers.length === 0) throw new Error("Crossref rows are malformed");
  return { papers, rejected };
}

async function gatedFetch(url: string, deps: FetchDeps): Promise<Response> {
  assertPaperSourceUrl(url, "GET");
  const host = new URL(url).hostname.toLowerCase();
  const interval = host === ARXIV_HOST ? ARXIV_MIN_INTERVAL_MS : 0;
  const previous = deps.lastRequestAt.get(host);
  if (interval > 0 && previous !== undefined) {
    const beforeWait = deps.now();
    if (beforeWait < previous) throw new Error("source clock moved backward");
    const wait = interval - (beforeWait - previous);
    if (wait > 0) await deps.sleep(wait);
  }
  if (interval > 0) deps.lastRequestAt.set(host, deps.now());
  deps.budget.take();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await deps.fetchImpl(url, {
      headers: { accept: "application/atom+xml, application/rss+xml, application/xml, text/xml, application/json", "user-agent": USER_AGENT },
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function assertPaperSourceUrl(value: string, method: string): void {
  const url = new URL(value);
  if (method !== "GET" || url.protocol !== "https:" || url.port || url.username || url.password) {
    throw new Error("paper source URL must use HTTPS without an explicit alternate port or credentials");
  }
  const exactPath =
    (url.hostname === ARXIV_HOST && url.pathname === "/api/query") ||
    (url.hostname === IACR_HOST && url.pathname === "/rss/rss.xml") ||
    (url.hostname === CROSSREF_HOST && url.pathname === "/works") ||
    (url.pathname === "/robots.txt" && [ARXIV_HOST, IACR_HOST, CROSSREF_HOST].includes(url.hostname));
  if (!exactPath) throw new Error("paper source URL is not an allowlisted API/feed path");
}

async function robotsFor(host: string, deps: FetchDeps): Promise<RobotsState> {
  const cached = deps.robots.get(host);
  if (cached) return cached;
  let state: RobotsState;
  try {
    const response = await gatedFetch(`https://${host}/robots.txt`, deps);
    if (response.status === 404) {
      state = { rules: [] };
    } else if (!response.ok) {
      state = { rules: [], unavailable: true };
    } else {
      const body = await readBodyCapped(response);
      state = body.truncated ? { rules: [], unavailable: true } : { rules: parseRobots(body.text) };
    }
  } catch (error) {
    if (error instanceof PapersRequestBudgetExhausted) throw error;
    state = { rules: [], unavailable: true };
  }
  deps.robots.set(host, state);
  return state;
}

async function readBodyCapped(response: Response): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return { text: "", truncated: true };
  }
  const charset = response.headers.get("content-type")?.match(/charset=([^\s;]+)/i)?.[1] ?? "utf-8";
  let bytes: Uint8Array;
  let truncated = false;
  if (response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const remaining = MAX_BODY_BYTES - total;
        if (next.value.byteLength > remaining) {
          chunks.push(next.value.subarray(0, remaining));
          total = MAX_BODY_BYTES;
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(next.value);
        total += next.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    truncated = buffer.byteLength > MAX_BODY_BYTES;
    bytes = truncated ? buffer.subarray(0, MAX_BODY_BYTES) : buffer;
  }
  if (truncated) return { text: "", truncated: true };
  return { text: new TextDecoder(charset).decode(bytes), truncated: false };
}

async function assertPaperRobots(url: string, source: SubSource, deps: FetchDeps): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== sourceHost(source)) throw new Error("cross-origin paper redirect");
  const robots = await robotsFor(parsed.hostname, deps);
  if (robots.unavailable) throw new Error("paper robots unavailable");
  if (!robotsAllows(parsed.pathname, robots.rules)) throw new Error("paper robots disallowed");
}

function sourceHost(source: SubSource): string {
  return source === "arxiv" ? ARXIV_HOST : source === "iacr-eprint" ? IACR_HOST : CROSSREF_HOST;
}

async function readUrl(url: string, source: SubSource, deps: FetchDeps): Promise<{ text: string; truncated: boolean; finalUrl: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    await assertPaperRobots(current, source, deps);
    const response = await gatedFetch(current, deps);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`HTTP ${response.status} redirect without location`);
      if (hop === MAX_REDIRECT_HOPS) throw new Error("redirect limit exceeded");
      const next = new URL(location, current);
      assertPaperSourceUrl(next.toString(), "GET");
      if (next.hostname !== new URL(url).hostname) throw new Error("cross-origin paper redirect");
      current = next.toString();
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ...(await readBodyCapped(response)), finalUrl: current };
  }
  throw new Error("redirect limit exceeded");
}

type SubSourceResult = {
  papers: Paper[];
  rejectedRows: PaperRowRejection[];
  unavailable?: string;
  truncated?: boolean;
};

/** Fail closed: any unreadable or unparseable sub-source is marked unavailable, never skipped silently. */
async function readSubSource(name: SubSource, url: string, parser: PaperParser, deps: FetchDeps): Promise<SubSourceResult> {
  try {
    const robots = await robotsFor(sourceHost(name), deps);
    if (robots.unavailable) return { papers: [], rejectedRows: [], unavailable: `${name}-robots-unavailable` };
    if (!robotsAllows(new URL(url).pathname, robots.rules)) return { papers: [], rejectedRows: [], unavailable: `${name}-robots-disallowed` };
    const body = await readUrl(url, name, deps);
    if (body.truncated) return { papers: [], rejectedRows: [], unavailable: `${name}-truncated`, truncated: true };
    const parsed = parser(body.text);
    return { papers: parsed.papers, rejectedRows: parsed.rejected };
  } catch (error) {
    if (error instanceof PapersRequestBudgetExhausted) throw error;
    return { papers: [], rejectedRows: [], unavailable: name };
  }
}

function isIacrCacheRecord(value: unknown): value is IacrCacheRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<IacrCacheRecord>;
  return record.state === "complete" &&
    record.source === "iacr-eprint" &&
    record.sourceUrl === IACR_URL &&
    record.finalUrl === IACR_URL &&
    record.endpointPolicyVersion === PAPERS_ENDPOINT_POLICY_VERSION &&
    record.maxBodyBytes === MAX_BODY_BYTES &&
    record.responseType === "application/rss+xml" &&
    typeof record.attemptedAtMs === "number" && Number.isFinite(record.attemptedAtMs) &&
    typeof record.body === "string" && new TextEncoder().encode(record.body).byteLength <= MAX_BODY_BYTES;
}

function isIacrPendingRecord(value: unknown): value is IacrCacheIdentity & { state: "pending"; attemptedAtMs: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<IacrCacheIdentity & { state: unknown; attemptedAtMs: unknown }>;
  return record.state === "pending" &&
    record.source === "iacr-eprint" &&
    record.sourceUrl === IACR_URL &&
    record.endpointPolicyVersion === PAPERS_ENDPOINT_POLICY_VERSION &&
    record.maxBodyBytes === MAX_BODY_BYTES &&
    record.responseType === "application/rss+xml" &&
    typeof record.attemptedAtMs === "number" && Number.isFinite(record.attemptedAtMs);
}

async function loadIacrCache(cachePath: string, now: number, filesystem: PapersFilesystem): Promise<IacrCacheState> {
  let raw: string;
  try {
    const file = await filesystem.lstat(cachePath);
    if (!file.isFile() || file.isSymbolicLink()) return { kind: "invalid" };
    raw = await filesystem.readFile(cachePath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES + 1_024) return { kind: "invalid" };
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  if (isIacrPendingRecord(record)) {
    if (record.attemptedAtMs > now) return { kind: "invalid" };
    return now - record.attemptedAtMs < IACR_MIN_INTERVAL_MS ? { kind: "pending" } : { kind: "stale" };
  }
  if (!isIacrCacheRecord(record) || record.attemptedAtMs > now) return { kind: "invalid" };
  return now - record.attemptedAtMs < IACR_MIN_INTERVAL_MS ? { kind: "fresh", body: record.body } : { kind: "stale" };
}

async function writeIacrCacheRecord(cachePath: string, record: IacrCacheRecord | (IacrCacheIdentity & { state: "pending"; attemptedAtMs: number }), filesystem: PapersFilesystem): Promise<void> {
  const directory = join(cachePath, "..");
  await filesystem.mkdir(directory, { recursive: true, mode: 0o700 });
  await filesystem.chmod(directory, 0o700);
  const temporaryPath = `${cachePath}.${randomUUID()}.tmp`;
  await filesystem.writeFile(temporaryPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  await filesystem.chmod(temporaryPath, 0o600);
  await filesystem.rename(temporaryPath, cachePath);
}

async function storeIacrCache(cachePath: string, body: string, now: number, filesystem: PapersFilesystem): Promise<void> {
  const record: IacrCacheRecord = {
    state: "complete",
    source: "iacr-eprint",
    sourceUrl: IACR_URL,
    finalUrl: IACR_URL,
    endpointPolicyVersion: PAPERS_ENDPOINT_POLICY_VERSION,
    maxBodyBytes: MAX_BODY_BYTES,
    responseType: "application/rss+xml",
    attemptedAtMs: now,
    body,
  };
  await writeIacrCacheRecord(cachePath, record, filesystem);
}

function isIacrClaim(value: unknown): value is IacrClaim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Partial<IacrClaim>;
  return typeof claim.owner === "string" && /^[a-f0-9-]{36}$/i.test(claim.owner) &&
    typeof claim.pid === "number" && Number.isInteger(claim.pid) && claim.pid > 0 &&
    typeof claim.claimedAtMs === "number" && Number.isFinite(claim.claimedAtMs);
}

async function readIacrClaim(claimPath: string, filesystem: PapersFilesystem): Promise<IacrClaim | null> {
  const file = await filesystem.lstat(claimPath);
  if (!file.isFile() || file.isSymbolicLink() || file.size > 1_024) throw new Error("invalid IACR claim");
  const parsed: unknown = JSON.parse(await filesystem.readFile(claimPath, "utf8"));
  if (!isIacrClaim(parsed)) throw new Error("invalid IACR claim");
  return parsed;
}

async function acquireIacrClaim(
  cacheDir: string,
  now: number,
  filesystem: PapersFilesystem,
  processId: number,
  isProcessAlive: (pid: number) => boolean,
): Promise<IacrClaimResult> {
  const claimPath = iacrClaimPath(cacheDir);
  const directory = join(claimPath, "..");
  await filesystem.mkdir(directory, { recursive: true, mode: 0o700 });
  await filesystem.chmod(directory, 0o700);
  const claim: IacrClaim = { owner: randomUUID(), pid: processId, claimedAtMs: now };
  try {
    const handle = await filesystem.open(claimPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(claim));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { kind: "acquired", claim };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return { kind: "invalid" };
  }
  let existing: IacrClaim;
  try {
    const parsed = await readIacrClaim(claimPath, filesystem);
    if (!parsed) return { kind: "busy" };
    existing = parsed;
  } catch {
    return { kind: "invalid" };
  }
  if (now < existing.claimedAtMs || now - existing.claimedAtMs < IACR_CLAIM_STALE_MS) return { kind: "busy" };
  let alive: boolean;
  try {
    alive = isProcessAlive(existing.pid);
  } catch {
    return { kind: "busy" };
  }
  if (alive) return { kind: "busy" };
  try {
    await filesystem.rename(claimPath, `${claimPath}.${existing.owner}.stale`);
    await filesystem.unlink(`${claimPath}.${existing.owner}.stale`);
  } catch {
    return { kind: "busy" };
  }
  return acquireIacrClaim(cacheDir, now, filesystem, processId, isProcessAlive);
}

async function claimIsCurrent(cacheDir: string, claim: IacrClaim, filesystem: PapersFilesystem): Promise<boolean> {
  try {
    const current = await readIacrClaim(iacrClaimPath(cacheDir), filesystem);
    return current?.owner === claim.owner && current.pid === claim.pid && current.claimedAtMs === claim.claimedAtMs;
  } catch {
    return false;
  }
}

async function releaseIacrClaim(cacheDir: string, claim: IacrClaim, filesystem: PapersFilesystem): Promise<void> {
  if (await claimIsCurrent(cacheDir, claim, filesystem)) await filesystem.unlink(iacrClaimPath(cacheDir)).catch(() => undefined);
}

async function readIacrSubSource(
  parser: PaperParser,
  deps: FetchDeps,
  cacheDir: string,
  filesystem: PapersFilesystem,
  processId: number,
  isProcessAlive: (pid: number) => boolean,
): Promise<SubSourceResult> {
  const cachePath = iacrCachePath(cacheDir);
  const cached = await loadIacrCache(cachePath, deps.now(), filesystem);
  if (cached.kind === "fresh") {
    try {
      const parsed = parser(cached.body);
      return { papers: parsed.papers, rejectedRows: parsed.rejected };
    } catch {
      return { papers: [], rejectedRows: [], unavailable: "iacr-eprint-cache-invalid" };
    }
  }
  if (cached.kind === "invalid") return { papers: [], rejectedRows: [], unavailable: "iacr-eprint-cache-invalid" };
  if (cached.kind === "pending") return { papers: [], rejectedRows: [], unavailable: "iacr-eprint-cadence-pending" };
  const claimResult = await acquireIacrClaim(cacheDir, deps.now(), filesystem, processId, isProcessAlive);
  if (claimResult.kind !== "acquired") {
    return { papers: [], rejectedRows: [], unavailable: claimResult.kind === "busy" ? "iacr-eprint-cadence-busy" : "iacr-eprint-cadence-invalid" };
  }
  try {
    const reread = await loadIacrCache(cachePath, deps.now(), filesystem);
    if (reread.kind === "fresh") {
      const parsed = parser(reread.body);
      return { papers: parsed.papers, rejectedRows: parsed.rejected };
    }
    if (reread.kind === "pending" || reread.kind === "invalid") return { papers: [], rejectedRows: [], unavailable: "iacr-eprint-cadence-pending" };
    await writeIacrCacheRecord(cachePath, {
      state: "pending",
      source: "iacr-eprint",
      sourceUrl: IACR_URL,
      endpointPolicyVersion: PAPERS_ENDPOINT_POLICY_VERSION,
      maxBodyBytes: MAX_BODY_BYTES,
      responseType: "application/rss+xml",
      attemptedAtMs: deps.now(),
    }, filesystem);
    const robots = await robotsFor(IACR_HOST, deps);
    if (robots.unavailable) return { papers: [], rejectedRows: [], unavailable: "iacr-eprint-robots-unavailable" };
    if (!robotsAllows(new URL(IACR_URL).pathname, robots.rules)) return { papers: [], rejectedRows: [], unavailable: "iacr-eprint-robots-disallowed" };
    const body = await readUrl(IACR_URL, "iacr-eprint", deps);
    if (body.truncated) return { papers: [], rejectedRows: [], unavailable: "iacr-eprint-truncated", truncated: true };
    if (body.finalUrl !== IACR_URL) return { papers: [], rejectedRows: [], unavailable: "iacr-eprint-cache-invalid" };
    const parsed = parser(body.text);
    if (!(await claimIsCurrent(cacheDir, claimResult.claim, filesystem))) return { papers: [], rejectedRows: [], unavailable: "iacr-eprint-cadence-fenced" };
    await storeIacrCache(cachePath, body.text, deps.now(), filesystem);
    return { papers: parsed.papers, rejectedRows: parsed.rejected };
  } catch {
    return { papers: [], rejectedRows: [], unavailable: "iacr-eprint" };
  } finally {
    await releaseIacrClaim(cacheDir, claimResult.claim, filesystem);
  }
}

const ARXIV_CATEGORY_LABELS: Record<string, string> = {
  "cs.CR": "cryptography",
  "cs.DC": "distributed-systems",
  "cs.NI": "networking",
  "cs.LG": "machine-learning",
  "stat.ML": "machine-learning",
  "cs.EC": "economics",
  "cs.GT": "game-theory",
};

function categoryLabel(category: string): string | undefined {
  if (ARXIV_CATEGORY_LABELS[category]) return ARXIV_CATEGORY_LABELS[category];
  if (category.startsWith("q-fin.")) return "finance";
  if (category.startsWith("econ.")) return "economics";
  return undefined;
}

function ruleLabels(paper: Paper): string[] {
  const labels = ["paper", "academic", paper.source, ...paper.categories.map(categoryLabel)];
  return [...new Set(labels)]
    .filter((label): label is string => typeof label === "string" && label.length > 0)
    .filter((label) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label) && label.length <= 20 && isAllowedResourceLabel(label));
}

function paperInput(paper: Paper): ExternalResourceInput {
  const labels = ruleLabels(paper);
  const domain =
    paper.source === "iacr-eprint"
      ? []
      : ["bitcoin", ...(paper.categories.includes("cs.CR") ? ["cryptography"] : [])];
  return {
    family: "url",
    value: canonicalPaperUrl(paper),
    source: PAPERS_SOURCE_ID,
    labels: [],
    title: paper.title,
    description: paper.abstract,
    bodyText: paper.abstract,
    tagHints: labels,
    metadata: {
      kind: "paper",
      subSource: paper.source,
      ...(paper.doi ? { doi: paper.doi } : {}),
      ...(paper.categories.length > 0 ? { categories: paper.categories } : {}),
    },
    taxonomy: { domain, type: ["research"], subject: labels },
    scoreComponents: { authority: 8, durability: 8, freshness: 0, origin_engagement: 0, cost_penalty: 0, pubky_signal: 0 },
  };
}

export async function discoverPapers(options: PapersDiscoverOptions): Promise<ResourceRun> {
  if (options.limit > PAPERS_REQUEST_BUDGET) {
    throw new Error(`papers --limit ${options.limit} exceeds the ${PAPERS_REQUEST_BUDGET}-request budget`);
  }
  const limit = validateResourceLimit(options.limit);
  const filesystem = options.filesystem ?? { readFile, writeFile, rename, mkdir, chmod, lstat, open, unlink };
  const processId = options.processId ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  });
  const budget = new RequestBudget(options.maxRequests ?? PAPERS_REQUEST_BUDGET);
  const deps: FetchDeps = {
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    budget,
    robots: new Map(),
    now: options.now ?? Date.now,
    lastRequestAt: new Map(),
  };
  const parsers: Record<SubSource, PaperParser> = {
    arxiv: options.parsers?.arxiv ?? parseArxivAtom,
    "iacr-eprint": options.parsers?.["iacr-eprint"] ?? parseIacrRss,
    crossref: options.parsers?.crossref ?? parseCrossrefJson,
  };
  const results: SubSourceResult[] = [];
  let budgetExhausted = false;
  try {
    results.push(await readSubSource("arxiv", arxivUrl(limit), parsers.arxiv, deps));
    results.push(
      options.cacheDir
        ? await readIacrSubSource(parsers["iacr-eprint"], deps, options.cacheDir, filesystem, processId, isProcessAlive)
        : await readSubSource("iacr-eprint", IACR_URL, parsers["iacr-eprint"], deps),
    );
    const contact = options.contactEmail?.trim();
    if (contact && PAPER_CONTACT_EMAIL.test(contact)) {
      results.push(await readSubSource("crossref", crossrefUrl(contact, limit), parsers.crossref, deps));
    } else {
      results.push({ papers: [], rejectedRows: [], unavailable: "crossref-contact-missing" });
    }
  } catch (error) {
    if (!(error instanceof PapersRequestBudgetExhausted)) throw error;
    budgetExhausted = true;
  }

  const rejectedRows = results.flatMap((result) => result.rejectedRows);
  const deduped = new Map<string, Paper>();
  for (const paper of results.flatMap((result) => result.papers)) {
    let canonical: string;
    try {
      canonical = canonicalPaperUrl(paper);
    } catch {
      rejectedRows.push({ source: paper.source, reason: "invalid canonical identity" });
      continue;
    }
    const identity = resourceIdentity(normalizeUri(canonical));
    if (deduped.has(identity)) {
      rejectedRows.push({ source: paper.source, reason: "duplicate canonical identity" });
      continue;
    }
    deduped.set(identity, { ...paper, url: canonical });
  }
  const inputs = [...deduped.values()].slice(0, RESOURCE_RECORD_MAX).map(paperInput);
  const run = discoverResources(inputs, {
    category: "pubky",
    limit,
    configVersion: options.configVersion ?? RESOURCE_CONFIG_VERSION,
  });
  run.shadowReport.poolSize = deduped.size + rejectedRows.length;
  run.shadowReport.requests = budget.requests;
  const histogram: Record<string, number> = {};
  for (const row of rejectedRows) histogram[row.reason] = (histogram[row.reason] ?? 0) + 1;
  for (const item of run.rejected) histogram[item.reason] = (histogram[item.reason] ?? 0) + 1;
  run.shadowReport.rejectionHistogram = histogram;
  const markers = results.flatMap((result) => (result.unavailable ? [result.unavailable] : []));
  const truncated = markers.filter((marker) => marker.endsWith("-truncated"));
  if (budgetExhausted) {
    run.shadowReport.halt = { reason: "request-budget-exhausted", ...(markers.length > 0 ? { subSources: markers } : {}) };
  } else if (markers.length > 0) {
    run.shadowReport.halt = { reason: truncated.length > 0 ? truncated.join(",") : "source-unavailable", subSources: markers };
  }
  return run;
}
