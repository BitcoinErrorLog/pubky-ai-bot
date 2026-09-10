import { mkdir, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { discoverResources, type ExternalResourceInput, type ResourceRun, type ExternalResource } from "./external-resources.js";
import { fetchResourceText } from "./resource-fetch.js";
import { assertAllowedResourceReadUrl } from "./outbound-gate.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";

export const WALLET_DIRECTORY_SOURCE_ID = "wallet-directory";
export const WALLET_DIRECTORY_LIMIT = 100;
export const WALLET_DIRECTORY_REQUEST_BUDGET = 100;
export const WALLET_DIRECTORY_FOLDERS = ["_mobile", "_hardware", "_desktop", "_bearer"] as const;
export type WalletDirectoryPlatform = "android" | "ios" | "hardware" | "desktop" | "bearer";
export type WalletDirectorySubSource = "walletscrutiny" | "lopp";

export class DiscoveryRequestBudget extends Error {
  constructor(public readonly url?: string) {
    super(`wallet-directory request budget exceeded${url ? ` at ${url}` : ""}`);
    this.name = "DiscoveryRequestBudget";
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
  sourcePage: string;
  metadata: Record<string, unknown>;
};

export type WalletDirectoryFixtures = {
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
};

const GITLAB_API_BASE = "https://gitlab.com/api/v4/projects/walletscrutiny%2FwalletScrutinyCom/repository/tree";
const GITLAB_RAW_BASE = "https://gitlab.com/walletscrutiny/walletScrutinyCom/-/raw/master";
const LOPP_URL = "https://www.lopp.net/bitcoin-information/recommended-wallets.html";
const DEFUNCT_VERDICTS = new Set(["obsolete", "defunct", "fewusers"]);
const VERDICT_LABELS = new Map([
  ["reproducible", "reproducible-build"],
  ["verified", "verified"],
  ["nonverifiable", "custodial"],
  ["custodial", "custodial"],
]);

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

function platformFields(frontMatter: WalletFrontMatter, folder: string): WalletDirectoryPlatform[] {
  const platform = platformForFolder(folder);
  const fields = platform === "android" || platform === "ios" ? ["android", "ios"] : [platform];
  const found = fields.filter((field) => record(frontMatter[field]));
  if (found.includes("android") && found.includes("ios")) return ["android", "ios"];
  return found.length ? found as WalletDirectoryPlatform[] : [platform];
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
  const verdict = text(frontMatter.verdict)?.toLowerCase();
  const stats = platformFields(frontMatter, folder).map((platform) => record(frontMatter[platform])).filter(Boolean) as Record<string, unknown>[];
  const users = Math.max(0, ...stats.map((item) => number(item.users)));
  const updated = stats.map((item) => text(item.updated)).filter((item): item is string => Boolean(item)).sort().at(-1);
  const title = text(frontMatter.title) ?? text(frontMatter.wsId) ?? sourcePath;
  const authors = Array.isArray(frontMatter.authors) ? frontMatter.authors.filter((author): author is string => typeof author === "string") : [];
  return {
    website: canonical,
    title,
    platforms: platformFields(frontMatter, folder),
    ...(verdict ? { verdict } : {}),
    users,
    ...(updated ? { updated } : {}),
    sourcePage: `https://walletscrutiny.com/${folder.slice(1)}/${text(frontMatter.wsId) ?? ""}/`,
    metadata: { wsId: text(frontMatter.wsId), authors, sourcePath, rawVerdict: verdict },
  };
}

export function parseWalletScrutinyMarkdown(markdown: string, folder = "_mobile", sourcePath = "fixture.md"): WalletCandidate | { reason: string } {
  return parseWalletMarkdown(markdown, folder, sourcePath);
}

function walletLabels(candidate: WalletCandidate): string[] {
  const labels = new Set<string>(["wallet", ...candidate.platforms]);
  if (candidate.platforms.includes("hardware")) labels.add("hardware-wallet");
  const verdictLabel = candidate.verdict ? VERDICT_LABELS.get(candidate.verdict) : undefined;
  if (verdictLabel) labels.add(verdictLabel);
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
    taxonomy: { domain: ["bitcoin"], type: [...candidate.platforms, ...(candidate.platforms.includes("hardware") ? ["hardware-wallet"] : [])], subject: ["wallet"] },
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

async function defaultWebsiteCheck(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  const result = await fetchResourceText(url, { fetchImpl, rawBody: true });
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

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  assertAllowedResourceReadUrl(url);
  const result = await fetchResourceText(url, { fetchImpl, rawBody: true, cacheNamespace: "wallet-directory" });
  if (!result.ok) throw new Error(`wallet-directory fetch failed: ${result.reason}`);
  return result.text;
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
    if (!current.verdict && value.verdict) current.verdict = value.verdict;
    current.metadata = { ...current.metadata, platforms: current.platforms };
  }
  return [...merged.values()];
}

export async function discoverWalletDirectory(options: WalletDirectoryOptions): Promise<ResourceRun> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > WALLET_DIRECTORY_LIMIT) {
    throw new Error(`wallet-directory limit must be an integer from 1 to ${WALLET_DIRECTORY_LIMIT}`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const fixtures = options.fixtures ?? {};
  const maxRequests = options.maxRequests ?? WALLET_DIRECTORY_REQUEST_BUDGET;
  let requests = 0;
  let rawFetched = 0;
  const rawBudget = Math.min(
    Math.max(0, maxRequests - WALLET_DIRECTORY_FOLDERS.length - 1),
    options.limit * 2,
  );
  const consume = (url: string): void => {
    requests += 1;
    if (requests > maxRequests) throw new DiscoveryRequestBudget(url);
  };
  const markdown: Record<string, string> = { ...(fixtures.markdown ?? {}) };
  const candidates: WalletCandidate[] = [];
  const rejected: Array<{ reason: string }> = [];
  for (const folder of WALLET_DIRECTORY_FOLDERS) {
    let rows = treeRows(fixtures.trees?.[folder]);
    if (!fixtures.trees?.[folder]) {
      for (let page = 1; ; page += 1) {
        const url = new URL(GITLAB_API_BASE);
        url.searchParams.set("path", folder);
        url.searchParams.set("per_page", "100");
        url.searchParams.set("page", String(page));
        consume(url.toString());
        const pageRows = treeRows(await fetchJson(url.toString(), fetchImpl));
        rows.push(...pageRows);
        if (pageRows.length < 100 || rows.length >= options.limit * 2) break;
      }
    }
    for (const row of rows.filter((item) => item.type === "blob" && item.path.endsWith(".md"))) {
      if (!markdown[row.path]) {
        if (rawFetched >= rawBudget) break;
        const rawUrl = `${GITLAB_RAW_BASE}/${row.path}`;
        consume(rawUrl);
        rawFetched += 1;
        markdown[row.path] = await fetchText(rawUrl, fetchImpl);
      }
      const parsed = parseWalletMarkdown(markdown[row.path]!, folder, row.path);
      if ("reason" in parsed) rejected.push(parsed);
      else if (!parsed.verdict || !DEFUNCT_VERDICTS.has(parsed.verdict)) candidates.push(parsed);
    }
  }
  let loppHtml = fixtures.lopp;
  if (loppHtml === undefined) {
    consume(LOPP_URL);
    const result = await fetchResourceText(LOPP_URL, {
      fetchImpl,
      rawBody: true,
      maxTextChars: 256 * 1024,
      cacheNamespace: "wallet-directory-full-v2",
    });
    if (!result.ok) throw new Error(`wallet-directory fetch failed: ${result.reason}`);
    loppHtml = result.text;
  }
  const lopp = parseLoppRecommendedWallets(loppHtml);
  if (lopp.parseFailed) rejected.push({ reason: "parse-failed" });
  const checkWebsite = options.websiteCheck ?? ((url: string) => defaultWebsiteCheck(url, fetchImpl));
  const tagged = new Set((fixtures.existingWebsites ?? []).map((url) => canonicalWebsite(url)));
  const acceptedCandidates: WalletCandidate[] = [];
  for (const candidate of mergeCandidates(candidates)) {
    if (tagged.has(candidate.website) || await options.isAlreadyTagged?.(candidate.website)) continue;
    if (!(await checkWebsite(candidate.website))) {
      rejected.push({ reason: "website-unreachable" });
      continue;
    }
    acceptedCandidates.push(candidate);
  }
  for (const url of lopp.urls) {
    if (tagged.has(url)) continue;
    if (!(await checkWebsite(url))) continue;
    acceptedCandidates.push({
      website: canonicalWebsite(url),
      title: url,
      platforms: ["desktop"],
      users: 0,
      sourcePage: LOPP_URL,
      metadata: { sourceSubSource: "lopp" },
    });
  }
  const score = (item: WalletCandidate) => 3 * (item.verdict === "reproducible" || item.verdict === "verified" ? 1 : 0) + item.users;
  const orderedWallets = acceptedCandidates
    .filter((item) => item.metadata.sourceSubSource === undefined)
    .sort((a, b) => score(b) - score(a) || (b.updated ?? "").localeCompare(a.updated ?? "") || a.website.localeCompare(b.website));
  const orderedLopp = acceptedCandidates
    .filter((item) => item.metadata.sourceSubSource === "lopp")
    .sort((a, b) => a.website.localeCompare(b.website));
  const roundRobin: WalletCandidate[] = [];
  for (let index = 0; index < Math.max(orderedWallets.length, orderedLopp.length); index += 1) {
    if (orderedWallets[index]) roundRobin.push(orderedWallets[index]!);
    if (orderedLopp[index]) roundRobin.push(orderedLopp[index]!);
  }
  const inputs = roundRobin
    .slice(0, options.limit)
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
  Object.assign(run.shadowReport, { byPlatform, byVerdict, requests, requestBudget: maxRequests, defunctVerdicts: [...DEFUNCT_VERDICTS], loppParseFailed: lopp.parseFailed });
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

export async function writeN2LabelsReport(resources: readonly ExternalResource[], path = "/tmp/jeb-n2/LABELS-N2.md"): Promise<void> {
  await mkdir("/tmp/jeb-n2", { recursive: true });
  const rows = resources.map((resource) => {
    const platforms = Array.isArray(resource.metadata?.platforms) ? resource.metadata.platforms.join(", ") : "";
    const verdict = typeof resource.metadata?.rawVerdict === "string" ? resource.metadata.rawVerdict : "";
    const components = resource.provenance.scoreComponents ?? {};
    return `| [${resource.canonicalValue}](${resource.canonicalValue}) | ${platforms} | ${verdict} | ${resource.labels.join(", ")} | authority=${components.authority ?? 0}; durability=${components.durability ?? 0}; users=${components.users ?? 0}; freshness=${components.freshness ?? 0} |`;
  });
  await writeFile(path, [
    "# N2 Wallets, Services & Hardware Directory",
    "",
    "| Resource | Platforms | Raw verdict | Labels | Score components |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"), "utf8");
}
