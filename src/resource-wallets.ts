import { mkdir, writeFile } from "node:fs/promises";
import type { lookup } from "node:dns/promises";
import { parse as parseYaml } from "yaml";
import { discoverResources, type ExternalResourceInput, type ResourceRun, type ExternalResource } from "./external-resources.js";
import { fetchResourceText, type FetchResourceOptions, type FetchResourceResult } from "./resource-fetch.js";
import { assertAllowedResourceReadUrl } from "./outbound-gate.js";
import { RESOURCE_CONFIG_VERSION, WALLET_VERDICT_DENYLIST, WALLET_VERDICT_LABELS } from "./resource-taxonomy.js";

export const WALLET_DIRECTORY_SOURCE_ID = "wallet-directory";
export const WALLET_DIRECTORY_LIMIT = 100;
export const WALLET_DIRECTORY_REQUEST_BUDGET = 100;
export const WALLET_DIRECTORY_FOLDERS = ["_mobile", "_hardware", "_desktop", "_bearer"] as const;
export const WALLET_DIRECTORY_INDEX_URL = "https://walletscrutiny.com/allWallets.js";
export const WALLET_DIRECTORY_INDEX_MAX_BYTES = 4 * 1024 * 1024;
export const WALLET_DIRECTORY_MARKDOWN_MAX = 45;
export const WALLET_DIRECTORY_LOPP_MAX = 45;
export const WALLET_APP_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export type WalletDirectoryPlatform = "android" | "ios" | "hardware" | "desktop" | "bearer";
export type WalletDirectorySubSource = "walletscrutiny" | "lopp";

export class DiscoveryRequestBudget extends Error {
  constructor(public readonly url?: string) {
    super(`wallet-directory request budget exceeded${url ? ` at ${url}` : ""}`);
    this.name = "DiscoveryRequestBudget";
  }
}

class RestrictedIndexParser {
  private cursor = 0;
  private depth = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.value();
    this.space();
    if (this.source[this.cursor] === ";") this.cursor += 1;
    return value;
  }

  private space(): void {
    while (this.cursor < this.source.length) {
      if (/\s/.test(this.source[this.cursor]!)) {
        this.cursor += 1;
      } else if (this.source.startsWith("//", this.cursor)) {
        const end = this.source.indexOf("\n", this.cursor + 2);
        this.cursor = end < 0 ? this.source.length : end + 1;
      } else if (this.source.startsWith("/*", this.cursor)) {
        const end = this.source.indexOf("*/", this.cursor + 2);
        if (end < 0) throw new Error("unterminated index comment");
        this.cursor = end + 2;
      } else {
        return;
      }
    }
  }

  private value(): unknown {
    this.space();
    if (++this.depth > 1000) throw new Error("wallet index nesting limit exceeded");
    const char = this.source[this.cursor];
    let value: unknown;
    if (char === "{") value = this.object();
    else if (char === "[") value = this.array();
    else if (char === "\"" || char === "'") value = this.string();
    else if (char === "-" || char === "." || (char !== undefined && /[0-9]/.test(char))) value = this.number();
    else if (this.source.startsWith("true", this.cursor)) {
      this.cursor += 4;
      value = true;
    } else if (this.source.startsWith("false", this.cursor)) {
      this.cursor += 5;
      value = false;
    } else if (this.source.startsWith("null", this.cursor)) {
      this.cursor += 4;
      value = null;
    } else {
      throw new Error(`unsupported wallet index token at ${this.cursor}`);
    }
    this.depth -= 1;
    return value;
  }

  private object(): Record<string, unknown> {
    this.cursor += 1;
    const result: Record<string, unknown> = {};
    this.space();
    if (this.source[this.cursor] === "}") {
      this.cursor += 1;
      return result;
    }
    while (this.source[this.cursor] !== "}") {
      const key = this.source[this.cursor] === "\"" || this.source[this.cursor] === "'"
        ? this.string()
        : this.identifier();
      this.space();
      if (this.source[this.cursor++] !== ":") throw new Error("wallet index object key missing colon");
      result[String(key)] = this.value();
      this.space();
      const delimiter = this.source[this.cursor++];
      if (delimiter === "}") break;
      if (delimiter !== ",") throw new Error("wallet index object missing comma");
      this.space();
      if (this.source[this.cursor] === "}") this.cursor += 1;
    }
    return result;
  }

  private array(): unknown[] {
    this.cursor += 1;
    const result: unknown[] = [];
    this.space();
    if (this.source[this.cursor] === "]") {
      this.cursor += 1;
      return result;
    }
    while (this.source[this.cursor] !== "]") {
      result.push(this.value());
      this.space();
      const delimiter = this.source[this.cursor++];
      if (delimiter === "]") break;
      if (delimiter !== ",") throw new Error("wallet index array missing comma");
      this.space();
      if (this.source[this.cursor] === "]") this.cursor += 1;
    }
    return result;
  }

  private identifier(): string {
    const start = this.cursor;
    while (this.cursor < this.source.length && /[A-Za-z0-9_$]/.test(this.source[this.cursor]!)) this.cursor += 1;
    if (start === this.cursor) throw new Error("wallet index key is not an identifier");
    return this.source.slice(start, this.cursor);
  }

  private string(): string {
    const quote = this.source[this.cursor++];
    let result = "";
    while (this.cursor < this.source.length) {
      const char = this.source[this.cursor++];
      if (char === quote) return result;
      if (char !== "\\") {
        result += char;
        continue;
      }
      const escaped = this.source[this.cursor++];
      if (escaped === "u") {
        const hex = this.source.slice(this.cursor, this.cursor + 4);
        if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error("invalid wallet index unicode escape");
        result += String.fromCharCode(Number.parseInt(hex, 16));
        this.cursor += 4;
      } else {
        result += ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" } as Record<string, string>)[escaped!] ?? escaped;
      }
    }
    throw new Error("unterminated wallet index string");
  }

  private number(): number {
    const match = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.cursor));
    if (!match) throw new Error(`invalid wallet index number at ${this.cursor}`);
    this.cursor += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("wallet index number is not finite");
    return value;
  }
}

type WalletFrontMatter = {
  wsId?: unknown;
  title?: unknown;
  website?: unknown;
  authors?: unknown;
  verdict?: unknown;
  meta?: unknown;
  [key: string]: unknown;
};

type WalletCandidate = {
  website: string;
  title: string;
  platforms: WalletDirectoryPlatform[];
  verdict?: string;
  users: number;
  updated?: string;
  bitcoinSupport: boolean;
  sourcePage: string;
  metadata: Record<string, unknown>;
};

export type WalletIndexEntry = {
  wsId?: string;
  title?: string;
  folder: string;
  appId: string;
  path: string;
  users: number;
  score: number;
  verdict?: string;
  meta?: string;
  features: string[];
  bitcoinSupport: boolean;
  source: "walletscrutiny";
};

export type WalletDirectoryFixtures = {
  index?: string;
  trees?: Partial<Record<(typeof WALLET_DIRECTORY_FOLDERS)[number], unknown>>;
  markdown?: Record<string, string>;
  lopp?: string;
  existingWebsites?: readonly string[];
};

export type WalletDirectoryOptions = {
  limit: number;
  configVersion?: string;
  fixtures?: WalletDirectoryFixtures;
  fetchImpl?: typeof fetch;
  maxRequests?: number;
  now?: Date;
  websiteCheck?: (url: string) => Promise<boolean>;
  isAlreadyTagged?: (url: string) => Promise<boolean>;
  loppUrl?: string;
  cacheDir?: string;
  dnsLookup?: typeof lookup;
  hostDelayMs?: number;
};

function indexDataObject(source: string): Record<string, unknown> {
  if (Buffer.byteLength(source, "utf8") > WALLET_DIRECTORY_INDEX_MAX_BYTES) throw new Error("wallet index exceeds 4 MB");
  const start = source.indexOf("const data=");
  if (start < 0) throw new Error("wallet index data object missing");
  const parsed = new RestrictedIndexParser(source.slice(start + "const data=".length)).parse();
  const data = record(parsed);
  if (!data) throw new Error("wallet index data object is not an object");
  return data;
}

function indexFolder(value: string): string {
  return value === "hardware" ? "_hardware" : value === "desktop" ? "_desktop" : value === "bearer" ? "_bearer" : "_mobile";
}

function indexNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function decodeIndexText(value: string | undefined): string | undefined {
  return value?.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

function indexVerdict(value: Record<string, unknown>): string | undefined {
  return text(value.verdict) ?? text(value.verdictAndroid) ?? text(value.verdictIphone);
}

function indexEntriesForSection(section: string, value: unknown): WalletIndexEntry[] {
  const object = record(value);
  const apps = object?.apps;
  const rows = Array.isArray(apps) ? apps : Array.isArray(value) ? value : object ? Object.values(object) : [];
  return rows.flatMap((item) => {
    const row = record(item);
    if (!row) return [];
    const appId = text(row.appId) ?? text(row.storeAppId) ?? text(row.androidAppId) ?? text(row.iphoneAppId) ?? text(row.wsId);
    if (!appId) return [];
    const folder = indexFolder(section);
    const fileId = appId;
    const verdict = indexVerdict(row)?.toLowerCase();
    const scoreValue = Array.isArray(row.score) ? Number(row.score[0]) / Math.max(1, Number(row.score[1])) : indexNumber(row.score);
    const features = Array.isArray(row.features) ? row.features.filter((item): item is string => typeof item === "string") : [];
    return [{
      wsId: text(row.wsId),
      title: decodeIndexText(text(row.title)),
      folder,
      appId,
      path: `${folder}/${fileId}.md`,
      users: indexNumber(row.users),
      score: Number.isFinite(scoreValue) ? scoreValue : 0,
      ...(verdict ? { verdict } : {}),
      ...(text(row.meta) ? { meta: text(row.meta)!.toLowerCase() } : {}),
      features,
      bitcoinSupport: verdict !== "nobtc",
      source: "walletscrutiny" as const,
    }];
  });
}

export function parseWalletScrutinyIndex(source: string): WalletIndexEntry[] {
  const data = indexDataObject(source);
  return ["mobile", "hardware", "bearer", "desktop"].flatMap((section) => indexEntriesForSection(section, data[section]));
}

const GITLAB_API_BASE = "https://gitlab.com/api/v4/projects/walletscrutiny%2FwalletScrutinyCom/repository/tree";
const GITLAB_RAW_BASE = "https://gitlab.com/walletscrutiny/walletScrutinyCom/-/raw/master";
const LOPP_URL = "https://www.lopp.net/bitcoin-information/recommended-wallets.html";
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function canonicalWebsite(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.toString();
}

function platformForFolder(folder: string): WalletDirectoryPlatform {
  if (folder === "_mobile") return "android";
  if (folder === "_hardware") return "hardware";
  if (folder === "_desktop") return "desktop";
  return "bearer";
}

function platformKey(value: string): WalletDirectoryPlatform | undefined {
  if (value === "iphone" || value === "ios") return "ios";
  if (value === "android") return "android";
  if (value === "hardware") return "hardware";
  if (value === "desktop") return "desktop";
  if (value === "bearer") return "bearer";
  return undefined;
}

function platformFields(frontMatter: WalletFrontMatter, folder: string): WalletDirectoryPlatform[] {
  const platform = platformForFolder(folder);
  const found = Object.entries(frontMatter).flatMap(([key, value]) => {
    const mapped = platformKey(key);
    return mapped && record(value) ? [mapped] : [];
  });
  return found.length ? [...new Set(found)] : [platform];
}

function parseWalletMarkdown(markdown: string, folder: string, sourcePath: string): WalletCandidate | { reason: string } {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(markdown);
  if (!match) return { reason: "missing front-matter" };
  let frontMatter: WalletFrontMatter;
  try {
    const parsed = parseYaml(match[1]) as unknown;
    if (!record(parsed)) return { reason: "invalid front-matter" };
    frontMatter = parsed as WalletFrontMatter;
  } catch {
    return { reason: "invalid front-matter" };
  }
  const website = text(frontMatter.website);
  if (!website) return { reason: "missing website" };
  let canonical: string;
  try {
    canonical = canonicalWebsite(website);
    if (new URL(canonical).protocol !== "https:") return { reason: "unsafe website" };
  } catch {
    return { reason: "invalid website" };
  }
  const platformDetails = Object.entries(frontMatter).flatMap(([key, value]) => {
    const platform = platformKey(key);
    const details = record(value);
    if (!platform || !details) return [];
    const meta = text(details.meta)?.toLowerCase();
    if (meta && ["removed", "obsolete", "defunct"].includes(meta)) return [];
    const verdict = text(details.verdict)?.toLowerCase();
    return [{ platform, users: number(details.users), updated: text(details.updated), meta, verdict }];
  });
  if (platformDetails.length === 0) return { reason: "no surviving platform" };
  if (platformDetails.some((item) => item.verdict === "nowallet")) return { reason: "nowallet verdict" };
  const verdicts = [...new Set(platformDetails.map((item) => item.verdict).filter((item): item is string => Boolean(item)))];
  const primary = [...platformDetails].sort((a, b) => b.users - a.users || (b.updated ?? "").localeCompare(a.updated ?? ""))[0]!;
  const users = Math.max(0, ...platformDetails.map((item) => item.users));
  const updated = platformDetails.map((item) => item.updated).filter((item): item is string => Boolean(item)).sort().at(-1);
  const title = text(frontMatter.title) ?? text(frontMatter.wsId) ?? sourcePath;
  const authors = Array.isArray(frontMatter.authors) ? frontMatter.authors.filter((author): author is string => typeof author === "string") : [];
  const features = Array.isArray(frontMatter.features) ? frontMatter.features.filter((item): item is string => typeof item === "string") : [];
  return {
    website: canonical,
    title,
    platforms: platformFields(frontMatter, folder),
    ...(primary.verdict ? { verdict: primary.verdict } : {}),
    users,
    ...(updated ? { updated } : {}),
    bitcoinSupport: true,
    sourcePage: `https://walletscrutiny.com/${folder.slice(1)}/${text(frontMatter.wsId) ?? ""}/`,
    metadata: { wsId: text(frontMatter.wsId), authors, sourcePath, rawVerdict: primary.verdict, verdicts, platformDetails, features },
  };
}

export function parseWalletScrutinyMarkdown(markdown: string, folder = "_mobile", sourcePath = "fixture.md"): WalletCandidate | { reason: string } {
  return parseWalletMarkdown(markdown, folder, sourcePath);
}

const INDEX_EXCLUDED_VERDICTS = new Set(["nobtc", "nowallet", "wip", "vapor", "fake", "prefilled", "plainkey", "defunct"]);
const INDEX_EXCLUDED_META = new Set(["removed", "obsolete", "defunct"]);

function indexEntryExcluded(entry: WalletIndexEntry): string | undefined {
  if (!entry.bitcoinSupport || (entry.verdict && INDEX_EXCLUDED_VERDICTS.has(entry.verdict))) return "excluded verdict";
  if (entry.meta && INDEX_EXCLUDED_META.has(entry.meta)) return "excluded metadata";
  return undefined;
}

function applyIndexEntry(parsed: WalletCandidate, entry: WalletIndexEntry): WalletCandidate {
  return {
    ...parsed,
    users: entry.users,
    bitcoinSupport: entry.bitcoinSupport,
    ...(entry.verdict ? { verdict: entry.verdict } : {}),
    metadata: {
      ...parsed.metadata,
      sourceSubSource: "walletscrutiny",
      indexScore: entry.score,
      indexVerdict: entry.verdict,
      indexMeta: entry.meta,
      features: entry.features,
    },
  };
}

function walletLabels(candidate: WalletCandidate): string[] {
  const labels = new Set<string>(["wallet", ...candidate.platforms]);
  if (candidate.platforms.includes("hardware")) labels.add("hardware-wallet");
  const verdictLabel = candidate.verdict ? WALLET_VERDICT_LABELS.get(candidate.verdict) : undefined;
  if (verdictLabel) labels.add(verdictLabel);
  if (Array.isArray(candidate.metadata.features) && candidate.metadata.features.includes("ln")) labels.add("lightning");
  return [...labels];
}

function walletScore(candidate: WalletCandidate): Record<string, number> {
  const verdictAuthority = candidate.verdict === "reproducible" || candidate.verdict === "verified" ? 8 : candidate.verdict === "custodial" ? 2 : 0;
  return {
    authority: verdictAuthority + Math.min(8, Math.log10(Math.max(1, candidate.users))),
    durability: 8,
    users: Math.min(8, Math.log10(Math.max(1, candidate.users))),
    freshness: candidate.updated ? 1 : 0,
    cost_penalty: 0,
    pubky_signal: 0,
  };
}

function candidateToInput(candidate: WalletCandidate, source: WalletDirectorySubSource): ExternalResourceInput {
  return {
    family: "url",
    value: candidate.website,
    source: WALLET_DIRECTORY_SOURCE_ID,
    labels: [],
    title: candidate.title,
    tagHints: walletLabels(candidate),
    metadata: { ...candidate.metadata, platforms: candidate.platforms, sourceSubSource: source, users: candidate.users, updated: candidate.updated, rawVerdict: candidate.verdict },
    observedAt: candidate.updated,
    taxonomy: {
      domain: candidate.bitcoinSupport ? ["bitcoin"] : [],
      type: [...candidate.platforms, ...(candidate.platforms.includes("hardware") ? ["hardware-wallet"] : [])],
      subject: [
        "wallet",
        ...(Array.isArray(candidate.metadata.features) && candidate.metadata.features.includes("ln") ? ["lightning"] : []),
        ...(candidate.verdict && WALLET_VERDICT_LABELS.has(candidate.verdict) ? [WALLET_VERDICT_LABELS.get(candidate.verdict)!] : []),
      ],
    },
    scoreComponents: walletScore(candidate),
  };
}

function treeRows(value: unknown): Array<{ path: string; type?: string }> {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Record<string, unknown> => Boolean(item)).flatMap((item) => {
      const path = text(item.path);
      return path ? [{ path, type: text(item.type) }] : [];
    })
    : [];
}

function loppLinks(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1]!)
    .flatMap((href) => {
      try {
        const url = new URL(href, LOPP_URL);
        return url.protocol === "https:" && url.hostname !== "www.lopp.net" ? [canonicalWebsite(url.toString())] : [];
      } catch {
        return [];
      }
    })
    .filter((url, index, all) => all.indexOf(url) === index);
}

export function parseLoppRecommendedWallets(html: string): { urls: string[]; parseFailed: boolean } {
  const urls = loppLinks(html);
  return { urls, parseFailed: urls.length < 20 };
}

type WalletFetchContext = {
  fetchImpl: typeof fetch;
  cacheDir?: string;
  dnsLookup?: typeof lookup;
  hostDelayMs?: number;
};

function fetchOptions(context: WalletFetchContext): Pick<FetchResourceOptions, "fetchImpl" | "cacheDir" | "dnsLookup" | "hostDelayMs"> {
  return {
    fetchImpl: context.fetchImpl,
    ...(context.cacheDir ? { cacheDir: context.cacheDir } : {}),
    ...(context.dnsLookup ? { dnsLookup: context.dnsLookup } : {}),
    ...(context.hostDelayMs !== undefined ? { hostDelayMs: context.hostDelayMs } : {}),
  };
}

function unavailableReason(source: string, result: { reason: string; status?: number }): string {
  return `${source}-unavailable${typeof result.status === "number" ? ` HTTP ${result.status}` : ` ${result.reason}`}`;
}

async function defaultWebsiteCheck(url: string, context: WalletFetchContext): Promise<boolean> {
  const result = await fetchResourceText(url, { ...fetchOptions(context), rawBody: true });
  return result.ok;
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  assertAllowedResourceReadUrl(url);
  const result = await fetchResourceText(url, {
    fetchImpl,
    acceptJson: true,
    rawBody: true,
    maxTextChars: 2 * 1024 * 1024,
    cacheNamespace: "wallet-directory-json-v2",
  });
  if (!result.ok) throw new Error(`wallet-directory fetch failed: ${result.reason}`);
  return JSON.parse(result.text) as unknown;
}

async function fetchWalletMarkdown(url: string, context: WalletFetchContext): Promise<FetchResourceResult> {
  assertAllowedResourceReadUrl(url);
  return fetchResourceText(url, { ...fetchOptions(context), rawBody: true, cacheNamespace: "wallet-directory" });
}

async function fetchWalletIndex(context: WalletFetchContext): Promise<FetchResourceResult> {
  assertAllowedResourceReadUrl(WALLET_DIRECTORY_INDEX_URL);
  return fetchResourceText(WALLET_DIRECTORY_INDEX_URL, {
    ...fetchOptions(context),
    rawBody: true,
    acceptJavaScript: true,
    maxTextChars: WALLET_DIRECTORY_INDEX_MAX_BYTES,
    maxBodyBytes: WALLET_DIRECTORY_INDEX_MAX_BYTES,
    cacheNamespace: "wallet-directory-index-v1",
  });
}

function mergeCandidates(values: WalletCandidate[]): WalletCandidate[] {
  const merged = new Map<string, WalletCandidate>();
  for (const value of values) {
    const current = merged.get(value.website);
    if (!current) {
      merged.set(value.website, value);
      continue;
    }
    current.platforms = [...new Set([...current.platforms, ...value.platforms])];
    current.users = Math.max(current.users, value.users);
    if ((value.updated ?? "") > (current.updated ?? "")) current.updated = value.updated;
    const currentDetails = Array.isArray(current.metadata.platformDetails) ? current.metadata.platformDetails : [];
    const valueDetails = Array.isArray(value.metadata.platformDetails) ? value.metadata.platformDetails : [];
    const details = [...currentDetails, ...valueDetails];
    const primary = details
      .filter((item): item is { users: number; verdict?: string } => Boolean(record(item)))
      .sort((a, b) => b.users - a.users)[0];
    current.verdict = primary?.verdict ?? current.verdict ?? value.verdict;
    current.metadata = {
      ...current.metadata,
      platforms: current.platforms,
      platformDetails: details,
      verdicts: [...new Set(details.map((item) => record(item)?.verdict).filter((item): item is string => typeof item === "string"))],
    };
  }
  return [...merged.values()];
}

function denylistedVerdict(candidate: WalletCandidate): boolean {
  const verdicts = new Set<string>();
  if (candidate.verdict) verdicts.add(candidate.verdict);
  const metaVerdicts = Array.isArray(candidate.metadata.verdicts) ? candidate.metadata.verdicts : [];
  for (const verdict of metaVerdicts) if (typeof verdict === "string") verdicts.add(verdict);
  return [...verdicts].some((verdict) => WALLET_VERDICT_DENYLIST.has(verdict));
}

export async function discoverWalletDirectory(options: WalletDirectoryOptions): Promise<ResourceRun> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > WALLET_DIRECTORY_LIMIT) {
    throw new Error(`wallet-directory limit must be an integer from 1 to ${WALLET_DIRECTORY_LIMIT}`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const fixtures = options.fixtures ?? {};
  const maxRequests = options.maxRequests ?? WALLET_DIRECTORY_REQUEST_BUDGET;
  // One budget for every HTTP request the run makes: index, robots, markdown,
  // the Lopp page, homepage checks, and redirects all go through budgetedFetch.
  const budget = { requests: 0, max: maxRequests, exhausted: false };
  const budgetedFetch: typeof fetch = (input, init) => {
    if (budget.requests >= budget.max) {
      budget.exhausted = true;
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return Promise.reject(new DiscoveryRequestBudget(url));
    }
    budget.requests += 1;
    return fetchImpl(input, init);
  };
  const context: WalletFetchContext = {
    fetchImpl: budgetedFetch,
    ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
    ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
    ...(options.hostDelayMs !== undefined ? { hostDelayMs: options.hostDelayMs } : {}),
  };
  let halt: { reason: string } | null = null;
  const markdown: Record<string, string> = { ...(fixtures.markdown ?? {}) };
  const candidates: WalletCandidate[] = [];
  const rejected: Array<{ reason: string }> = [];
  const markUnavailable = (reason: string): void => {
    rejected.push({ reason });
    halt = { reason: "source-unavailable" };
  };
  const useIndex = fixtures.index !== undefined || !fixtures.trees;
  if (useIndex) {
    let indexSource = fixtures.index;
    if (indexSource === undefined) {
      const result = await fetchWalletIndex(context);
      if (!result.ok) {
        if (!budget.exhausted) markUnavailable(unavailableReason("index", result));
      } else if (result.truncated) {
        markUnavailable("index-truncated");
      } else {
        indexSource = result.text;
      }
    }
    let entries: WalletIndexEntry[] = [];
    if (indexSource !== undefined) {
      try {
        entries = parseWalletScrutinyIndex(indexSource)
          .filter((entry) => !indexEntryExcluded(entry))
          .sort((a, b) => {
            const userBand = (users: number) => users > 0 ? Math.floor(Math.log10(users)) : -1;
            const verdictRank = (verdict?: string) => verdict === "custodial" || verdict === "nosendreceive" ? 0 : 1;
            return userBand(b.users) - userBand(a.users) ||
              verdictRank(b.verdict) - verdictRank(a.verdict) ||
              b.users - a.users ||
              b.score - a.score ||
              a.path.localeCompare(b.path);
          })
          .slice(0, Math.min(WALLET_DIRECTORY_MARKDOWN_MAX, Math.max(options.limit, options.limit * 2)));
      } catch {
        markUnavailable("index-unavailable parse");
      }
    }
    for (const entry of entries) {
      if (!WALLET_APP_ID_PATTERN.test(entry.appId) || entry.appId.includes("..")) {
        rejected.push({ reason: "invalid-app-id" });
        continue;
      }
      if (!markdown[entry.path]) {
        if (budget.exhausted) break;
        const result = await fetchWalletMarkdown(`${GITLAB_RAW_BASE}/${entry.path}`, context);
        if (!result.ok) {
          if (budget.exhausted) break;
          markUnavailable(unavailableReason("markdown", result));
          continue;
        }
        markdown[entry.path] = result.text;
      }
      const parsed = parseWalletMarkdown(markdown[entry.path]!, entry.folder, entry.path);
      if ("reason" in parsed) rejected.push(parsed);
      else candidates.push(applyIndexEntry(parsed, entry));
    }
  } else {
    for (const folder of WALLET_DIRECTORY_FOLDERS) {
      const rows = treeRows(fixtures.trees?.[folder]);
      for (const row of rows.filter((item) => item.type === "blob" && item.path.endsWith(".md"))) {
        if (!markdown[row.path]) {
          if (budget.exhausted) break;
          const result = await fetchWalletMarkdown(`${GITLAB_RAW_BASE}/${row.path}`, context);
          if (!result.ok) {
            if (budget.exhausted) break;
            markUnavailable(unavailableReason("markdown", result));
            continue;
          }
          markdown[row.path] = result.text;
        }
        const parsed = parseWalletMarkdown(markdown[row.path]!, folder, row.path);
        if ("reason" in parsed) rejected.push(parsed);
        else candidates.push(parsed);
      }
    }
  }
  const loppUrl = options.loppUrl ?? LOPP_URL;
  let loppHtml = fixtures.lopp;
  if (loppHtml === undefined) {
    assertAllowedResourceReadUrl(loppUrl);
    const result = await fetchResourceText(loppUrl, {
      ...fetchOptions(context),
      rawBody: true,
      maxTextChars: 256 * 1024,
      cacheNamespace: "wallet-directory-full-v2",
    });
    if (!result.ok) {
      if (!budget.exhausted) markUnavailable(unavailableReason("lopp", result));
    } else {
      loppHtml = result.text;
    }
  }
  const lopp = loppHtml === undefined ? { urls: [] as string[], parseFailed: false } : parseLoppRecommendedWallets(loppHtml);
  if (lopp.parseFailed) rejected.push({ reason: "parse-failed" });
  const checkWebsite = options.websiteCheck ?? ((url: string) => defaultWebsiteCheck(url, context));
  const tagged = new Set((fixtures.existingWebsites ?? []).map((url) => canonicalWebsite(url)));
  const acceptedCandidates: WalletCandidate[] = [];
  for (const candidate of mergeCandidates(candidates)) {
    if (denylistedVerdict(candidate)) {
      rejected.push({ reason: "verdict-denylisted" });
      continue;
    }
    if (tagged.has(candidate.website) || await options.isAlreadyTagged?.(candidate.website)) continue;
    if (budget.exhausted) break;
    const reachable = await checkWebsite(candidate.website);
    if (budget.exhausted) break;
    if (!reachable) {
      rejected.push({ reason: "website-unreachable" });
      continue;
    }
    acceptedCandidates.push(candidate);
  }
  for (const url of lopp.urls.slice(0, WALLET_DIRECTORY_LOPP_MAX)) {
    if (tagged.has(url) || await options.isAlreadyTagged?.(url)) continue;
    if (budget.exhausted) break;
    const reachable = await checkWebsite(url);
    if (budget.exhausted) break;
    if (!reachable) continue;
    acceptedCandidates.push({
      website: canonicalWebsite(url),
      title: url,
      platforms: ["desktop"],
      users: 0,
      bitcoinSupport: true,
      sourcePage: LOPP_URL,
      metadata: { sourceSubSource: "lopp", rawVerdict: "not-provided" },
    });
  }
  if (budget.exhausted) rejected.push({ reason: "request-budget-exhausted" });
  const verdictRank = (verdict?: string): number => verdict === "custodial" || verdict === "wip" ? 0 :
    verdict === "reproducible" || verdict === "sourceavailable" || verdict === "verified" ? 2 : 1;
  const usersBand = (users: number): number => users > 0 ? Math.floor(Math.log10(users)) : -1;
  const inputs = acceptedCandidates
    .sort((a, b) => usersBand(b.users) - usersBand(a.users) ||
      verdictRank(b.verdict) - verdictRank(a.verdict) ||
      b.users - a.users ||
      (b.updated ?? "").localeCompare(a.updated ?? "") ||
      a.website.localeCompare(b.website))
    .slice(0, options.limit)
    .map((candidate) => candidateToInput(candidate, candidate.metadata.sourceSubSource === "lopp" ? "lopp" : "walletscrutiny"));
  const run = discoverResources(inputs, {
    category: "pubky",
    limit: options.limit,
    configVersion: options.configVersion ?? RESOURCE_CONFIG_VERSION,
  });
  const byPlatform: Record<string, number> = Object.create(null);
  const byVerdict: Record<string, number> = Object.create(null);
  for (const resource of run.accepted) {
    const platforms = Array.isArray(resource.metadata?.platforms) ? resource.metadata.platforms : [];
    for (const platform of platforms) byPlatform[String(platform)] = (byPlatform[String(platform)] ?? 0) + 1;
    const verdict = resource.metadata?.rawVerdict;
    if (typeof verdict === "string") byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
    resource.provenance = {
      ...resource.provenance,
      sourcePage: resource.metadata?.sourceSubSource === "lopp" ? LOPP_URL : resource.metadata?.sourcePath ? `https://gitlab.com/walletscrutiny/walletScrutinyCom/-/blob/master/${resource.metadata.sourcePath}` : undefined,
      attribution: resource.metadata?.sourceSubSource === "walletscrutiny" ? "WalletScrutiny repository content © Leo Wandersleb, MIT license; reviews excluded from copied content." : undefined,
      rawVerdict: typeof verdict === "string" ? verdict : undefined,
    };
  }
  Object.assign(run.shadowReport, { byPlatform, byVerdict, requests: budget.requests, requestBudget: budget.max, defunctVerdicts: [...WALLET_VERDICT_DENYLIST], loppParseFailed: lopp.parseFailed, halt });
  run.rejected.push(...rejected.map((item) => ({
    input: { family: "url" as const, value: "", source: WALLET_DIRECTORY_SOURCE_ID, labels: [] },
    reason: item.reason,
    provenance: { source: WALLET_DIRECTORY_SOURCE_ID, configVersion: options.configVersion ?? RESOURCE_CONFIG_VERSION, decision: "rejected" as const, timestamp: new Date().toISOString() },
  })));
  for (const item of rejected) {
    run.shadowReport.byRejectionReason[item.reason] = (run.shadowReport.byRejectionReason[item.reason] ?? 0) + 1;
  }
  return run;
}

export async function writeN2LabelsReport(
  resources: readonly ExternalResource[],
  taggerMode: "rules" | "model" = "model",
  path = "/tmp/jeb-n2/LABELS-N2.md",
): Promise<void> {
  await mkdir("/tmp/jeb-n2", { recursive: true });
  const rounded = (value: unknown): string => typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "0.00";
  const rows = resources.map((resource) => {
    const platforms = Array.isArray(resource.metadata?.platforms) ? resource.metadata.platforms.join(", ") : "";
    const verdict = typeof resource.metadata?.rawVerdict === "string"
      ? resource.metadata.rawVerdict
      : "—";
    const subSource = resource.metadata?.sourceSubSource === "lopp" ? "lopp" : "walletscrutiny";
    const users = typeof resource.metadata?.users === "number" ? String(resource.metadata.users) : "—";
    const wsScore = typeof resource.metadata?.indexScore === "number" ? resource.metadata.indexScore.toFixed(2) : "—";
    const components = resource.provenance.scoreComponents ?? {};
    return `| [${resource.canonicalValue}](${resource.canonicalValue}) | ${subSource} | ${platforms} | ${verdict} | ${users} | ${wsScore} | ${resource.labels.join(", ")} | authority=${rounded(components.authority)}; durability=${rounded(components.durability)}; users=${rounded(components.users)}; freshness=${rounded(components.freshness)} |`;
  });
  await writeFile(path, [
    "# N2 Wallets, Services & Hardware Directory",
    `Tagger mode: ${taggerMode}`,
    "",
    "| Resource | Sub-source | Platforms | Raw verdict | Users | WS score | Labels | Score components |",
    "|---|---|---|---|---:|---:|---|---|",
    ...rows,
    "",
  ].join("\n"), "utf8");
}
