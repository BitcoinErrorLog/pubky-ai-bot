import type { ExternalResourceInput, ResourceRun } from "./external-resources.js";
import { discoverResources, validateResourceLimit } from "./external-resources.js";
import { normalizeUri } from "./resource-identity.js";
import { fetchResourceText } from "./resource-fetch.js";
import { assertAllowedResourceReadUrl } from "./outbound-gate.js";

export const PUBKY_ECOSYSTEM_SOURCE_ID = "pubky-ecosystem";
export const PUBKY_ECOSYSTEM_LIMIT = 100;
export const PUBKY_ECOSYSTEM_REQUEST_BUDGET = 100;
export const PUBKY_ECOSYSTEM_SUB_SOURCES = ["vibes", "docs", "github", "privacyguides"] as const;
export type EcosystemSubSource = (typeof PUBKY_ECOSYSTEM_SUB_SOURCES)[number];

export type EcosystemGithubRepo = {
  html_url?: unknown;
  homepage?: unknown;
  description?: unknown;
  topics?: unknown;
  language?: unknown;
  stargazers_count?: unknown;
  pushed_at?: unknown;
  archived?: unknown;
  fork?: unknown;
  name?: unknown;
};

export type EcosystemPrivacyEntry = {
  path?: unknown;
  type?: unknown;
  download_url?: unknown;
  html_url?: unknown;
};

export type EcosystemVibeRegistryEntry = {
  name?: unknown;
  path?: unknown;
  type?: unknown;
};

export type EcosystemFixtures = {
  vibesRegistry?: readonly EcosystemVibeRegistryEntry[];
  vibeManifests?: Record<string, unknown>;
  sitemap?: string;
  pubkyGithub?: readonly EcosystemGithubRepo[];
  synonymGithub?: readonly EcosystemGithubRepo[];
  privacyguides?: readonly EcosystemPrivacyEntry[];
  privacyMarkdown?: Record<string, string>;
};

export type EcosystemDiscoverOptions = {
  limit?: number;
  configVersion: string;
  fixtures?: EcosystemFixtures;
  fetchText?: (url: string, acceptJson?: boolean) => Promise<string>;
  existingTags?: (resource: ExternalResourceInput) => Promise<readonly string[]>;
  now?: Date;
  maxRequests?: number;
};

export class DiscoveryRequestBudget extends Error {
  constructor(url?: string) {
    super(`pubky ecosystem request budget exceeded${url ? ` at ${url}` : ""}`);
    this.name = "DiscoveryRequestBudget";
  }
}

type Candidate = ExternalResourceInput & { subSource: EcosystemSubSource };

const VIBES_REGISTRY_URL = "https://api.github.com/repos/pubky/vibes/contents/registry";
const VIBES_RAW_BASE_URL = "https://raw.githubusercontent.com/pubky/vibes/main/registry";
const SITEMAP_URL = "https://pubky.org/sitemap-index.xml";
const GITHUB_URL = (org: string) => `https://api.github.com/orgs/${org}/repos?per_page=100`;
const PRIVACY_URL = "https://api.github.com/repos/privacyguides/privacyguides.org/contents";
const PRIVACY_LICENSE = "CC BY-SA 4.0 — Privacy Guides";
const SITEMAP_INDEX_REJECTION_REASON = "sitemap index is discovery-only";
const VIBES_UNAVAILABLE_REASON_PREFIX = "vibes registry unavailable";
const MAX_SITEMAP_URLS = 1_000;
const MAX_SITEMAP_INDEX_ENTRIES = 20;

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function labelsForText(value: string): string[] {
  const text = value.toLowerCase();
  const labels = ["freedom-tech"];
  const terms: readonly [string, string][] = [
    ["bitcoin", "bitcoin"], ["lightning", "lightning"], ["pubky", "pubky"], ["nostr", "nostr"],
    ["privacy", "privacy"], ["security", "security"], ["social", "social"], ["wallet", "wallet"],
    ["vpn", "vpn"], ["browser", "browser"], ["messaging", "messaging"], ["decentral", "decentralized"],
  ];
  for (const [term, label] of terms) if (text.includes(term)) labels.push(label);
  return [...new Set(labels)];
}

function validLabels(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((value) => value.length >= 1 && value.length <= 20 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)))];
}

function candidate(
  subSource: EcosystemSubSource,
  value: string,
  labels: string[],
  metadata: Record<string, unknown>,
  extra: Partial<ExternalResourceInput> = {},
): Candidate {
  return {
    family: "url",
    value,
    source: PUBKY_ECOSYSTEM_SOURCE_ID,
    labels: [...new Set(labels)],
    sourcePriority: subSource === "vibes" ? 140 : subSource === "docs" ? 130 : subSource === "github" ? 120 : 110,
    taxonomy: { domain: ["pubky"], subject: [...new Set(labels.filter((label) => label !== "freedom-tech" && label !== "pubky"))] },
    metadata: { subSource, ...metadata, ...(extra.metadata ?? {}) },
    ...extra,
    subSource,
  };
}

function parseVibeManifest(
  manifest: unknown,
  id: string | undefined,
): Candidate[] {
  if (!manifest || typeof manifest !== "object") return [];
  const item = manifest as Record<string, unknown>;
  const hosted = item.hosted && typeof item.hosted === "object" ? item.hosted as Record<string, unknown> : {};
  const website = stringValue(hosted.url) ?? stringValue(item.website);
  if (!website) return [];
  const description = stringValue(item.description);
  const name = stringValue(item.name) ?? id;
  return [candidate("vibes", website, ["pubky", "vibe", ...labelsForText(`${name ?? ""} ${description ?? ""}`)], {
    id,
  }, { title: name, description, tagHints: labelsForText(`${name ?? ""} ${description ?? ""}`) })];
}

export function parsePubkySitemap(xml: string): string[] {
  const urls = [...xml.matchAll(/<url\b[^>]*>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/url>/gi)]
    .flatMap((match) => validSitemapUrl(match[1]));
  return [...new Set(urls)].slice(0, MAX_SITEMAP_URLS);
}

function parsePubkySitemapIndex(xml: string): string[] {
  const urls = [...xml.matchAll(/<sitemap\b[^>]*>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>[\s\S]*?<\/sitemap>/gi)]
    .flatMap((match) => validSitemapUrl(match[1]));
  return [...new Set(urls)].slice(0, MAX_SITEMAP_INDEX_ENTRIES);
}

function validSitemapUrl(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.hostname !== "pubky.org" || url.search || url.hash) return [];
    return [normalizeUri(url.toString())];
  } catch {
    return [];
  }
}

export function parseEcosystemGithub(rows: readonly EcosystemGithubRepo[]): Candidate[] {
  return rows
    .filter((repo) => repo.archived !== true && repo.fork !== true && stringValue(repo.description))
    .flatMap((repo) => {
      const html = stringValue(repo.html_url);
      if (!html) return [];
      const description = stringValue(repo.description)!;
      const topics = Array.isArray(repo.topics) ? repo.topics.filter((topic): topic is string => typeof topic === "string") : [];
      const labels = validLabels(["pubky", ...labelsForText(`${description} ${topics.join(" ")} ${repo.language ?? ""}`), ...topics.slice(0, 4)]);
      const stars = typeof repo.stargazers_count === "number" ? repo.stargazers_count : 0;
      const pushedAt = stringValue(repo.pushed_at);
      const homepage = stringValue(repo.homepage);
      const home = homepage && new URL(homepage).hostname !== new URL(html).hostname ? [candidate("github", homepage, labels, {
        organization: new URL(html).pathname.split("/")[1], stars, pushedAt, kind: "homepage",
      }, { title: stringValue(repo.name), description })] : [];
      return [candidate("github", html, labels, {
        organization: new URL(html).pathname.split("/")[1], stars, pushedAt, kind: "repository",
      }, { title: stringValue(repo.name), description }), ...home];
    })
    .sort((a, b) => Number(b.metadata?.stars ?? 0) - Number(a.metadata?.stars ?? 0) ||
      String(b.metadata?.pushedAt ?? "").localeCompare(String(a.metadata?.pushedAt ?? "")) ||
      a.value.localeCompare(b.value));
}

export function parsePrivacyGuidesEntries(rows: readonly EcosystemPrivacyEntry[], markdown: Record<string, string>): Candidate[] {
  return rows
    .filter((entry) => entry.type === "file" && typeof entry.path === "string" && entry.path.startsWith("docs/") && entry.path.endsWith(".md"))
    .flatMap((entry) => {
      const path = String(entry.path);
      const page = markdown[path] ?? "";
      const privacyPageUrl = `https://www.privacyguides.org/${path.replace(/^docs\//, "").replace(/\.md$/, "/")}`;
      const url = stringValue(page.match(/(?:website|url):\s*[`"]?(https:\/\/[^\s`"]+)/i)?.[1]) ?? privacyPageUrl;
      const category = validLabels([path.split("/")[1]?.replace(/\.md$/, "") || "privacy"])[0] ?? "privacy";
      return [candidate("privacyguides", url, ["privacy", category], {
        license: PRIVACY_LICENSE, category, sourcePage: privacyPageUrl,
      }, { attribution: PRIVACY_LICENSE, description: page.slice(0, 500), tagHints: ["privacy", category] })];
    });
}

async function expandPrivacyGuides(
  rows: readonly EcosystemPrivacyEntry[],
  read: (url: string, acceptJson?: boolean) => Promise<string>,
  depth = 0,
): Promise<EcosystemPrivacyEntry[]> {
  const files: EcosystemPrivacyEntry[] = [];
  for (const entry of rows) {
    const path = stringValue(entry.path);
    if (
      entry.type !== "dir" ||
      !(path === "docs" || path?.startsWith("docs/")) ||
      depth >= 3 ||
      (depth >= 1 && !path.toLowerCase().includes("tool"))
    ) {
      files.push(entry);
      continue;
    }
    const raw = await read(`https://api.github.com/repos/privacyguides/privacyguides.org/contents/${path}`, true);
    const children: unknown = JSON.parse(raw);
    if (Array.isArray(children)) files.push(...await expandPrivacyGuides(children as EcosystemPrivacyEntry[], read, depth + 1));
  }
  return files;
}

async function readSource(url: string, options: EcosystemDiscoverOptions, acceptJson = false): Promise<string> {
  assertAllowedResourceReadUrl(url);
  let status: number | undefined;
  const result = options.fetchText
    ? { ok: true as const, text: await options.fetchText(url, acceptJson) }
    : await fetchResourceText(url, {
      rawBody: true,
      acceptJson,
      acceptXml: url.endsWith(".xml"),
      maxTextChars: acceptJson ? 1_000_000 : undefined,
      cacheNamespace: "pubky-ecosystem",
      log: (line) => {
        if (line.url === url && typeof line.status === "number") status = line.status;
      },
    });
  if (!result.ok) throw new Error(`ecosystem fetch failed for ${url}: ${result.reason}${status ? ` HTTP ${status}` : ""}`);
  return result.text;
}

function score(candidateValue: Candidate): number {
  const scoreComponents = candidateValue.scoreComponents ?? {};
  return 3 * Number(scoreComponents.pubky_signal ?? 0) + 2 * Number(scoreComponents.authority ?? 0) +
    2 * Number(scoreComponents.durability ?? 0);
}

function skippedGithubRows(rows: readonly EcosystemGithubRepo[], organization: string): Array<{ input: Candidate; reason: string }> {
  return rows.flatMap((repo) => {
    const html = stringValue(repo.html_url);
    if (!html) return [];
    const reason = repo.archived === true
      ? "archived repository"
      : repo.fork === true
        ? "fork repository"
        : !stringValue(repo.description)
          ? "repository has no description"
          : undefined;
    if (!reason) return [];
    return [{ input: candidate("github", html, ["pubky"], { organization, skipReason: reason }), reason }];
  });
}

export async function discoverPubkyEcosystem(options: EcosystemDiscoverOptions): Promise<ResourceRun> {
  const limit = validateResourceLimit(options.limit ?? PUBKY_ECOSYSTEM_LIMIT);
  const fixtures = options.fixtures ?? {};
  const maxRequests = options.maxRequests ?? PUBKY_ECOSYSTEM_REQUEST_BUDGET;
  let requests = 0;
  const read = async (url: string, acceptJson = false): Promise<string> => {
    requests += 1;
    if (requests > maxRequests) throw new DiscoveryRequestBudget(url);
    return readSource(url, options, acceptJson);
  };
  const readAvailable = async (url: string, acceptJson = false): Promise<string> => {
    try {
      return await read(url, acceptJson);
    } catch (error) {
      if (error instanceof DiscoveryRequestBudget) throw error;
      return acceptJson ? "[]" : "";
    }
  };
  let vibesUnavailableReason: string | undefined;
  let vibesRegistry: readonly EcosystemVibeRegistryEntry[] = fixtures.vibesRegistry ?? [];
  let vibeManifests: Record<string, unknown> = fixtures.vibeManifests ?? {};
  if (!fixtures.vibesRegistry) {
    try {
      const raw = await read(VIBES_REGISTRY_URL, true);
      vibesRegistry = JSON.parse(raw) as EcosystemVibeRegistryEntry[];
    } catch (error) {
      vibesUnavailableReason = `${VIBES_UNAVAILABLE_REASON_PREFIX}: ${error instanceof Error ? error.message.replace(/^ecosystem fetch failed for \S+: /, "") : "unavailable"}`;
    }
  }
  const vibeCandidates = await Promise.all(vibesRegistry
    .filter((entry) => entry.type === "dir" && stringValue(entry.name))
    .slice(0, MAX_SITEMAP_URLS)
    .map(async (entry) => {
      const id = stringValue(entry.name)!;
      if (vibeManifests[id]) return parseVibeManifest(vibeManifests[id], id);
      try {
        const raw = await read(`${VIBES_RAW_BASE_URL}/${encodeURIComponent(id)}/vibe.json`, true);
        vibeManifests[id] = JSON.parse(raw);
        return parseVibeManifest(vibeManifests[id], id);
      } catch {
        return [];
      }
    }));
  const vibes = vibeCandidates.flat();
  const sitemapIndex = fixtures.sitemap ?? await readAvailable(SITEMAP_URL);
  const sitemapEntries = parsePubkySitemapIndex(sitemapIndex);
  const sitemapPages = parsePubkySitemap(sitemapIndex);
  const nestedSitemaps = await Promise.all(sitemapEntries.map((url) => readAvailable(url).then(parsePubkySitemap)));
  const sitemap = [...new Set([...sitemapPages, ...nestedSitemaps.flat()])].slice(0, MAX_SITEMAP_URLS);
  const docs = sitemap.map((url) => candidate("docs", url, ["pubky", "documentation"], { kind: "documentation" }, { title: url.split("/").at(-1) }));
  const pubkyGithub = fixtures.pubkyGithub ?? JSON.parse(await readAvailable(GITHUB_URL("pubky"), true));
  const synonymGithub = fixtures.synonymGithub ?? JSON.parse(await readAvailable(GITHUB_URL("synonymdev"), true));
  const skipped = skippedGithubRows(pubkyGithub, "pubky").concat(skippedGithubRows(synonymGithub, "synonymdev"));
  const github = parseEcosystemGithub(pubkyGithub).concat(parseEcosystemGithub(synonymGithub));
  const initialPrivacyRows = fixtures.privacyguides ?? JSON.parse(await readAvailable(PRIVACY_URL, true));
  const privacyRows = fixtures.privacyguides
    ? initialPrivacyRows
    : await expandPrivacyGuides(initialPrivacyRows, readAvailable);
  const privacyMarkdown = { ...(fixtures.privacyMarkdown ?? {}) };
  if (!fixtures.privacyguides) {
    for (const entry of privacyRows.slice(0, Math.min(20, Math.max(0, maxRequests - requests)))) {
      const path = stringValue(entry.path);
      const downloadUrl = stringValue(entry.download_url);
      if (!path?.startsWith("docs/") || !path.endsWith(".md") || !downloadUrl) continue;
      privacyMarkdown[path] = await readAvailable(downloadUrl);
    }
  }
  const privacy = parsePrivacyGuidesEntries(privacyRows, privacyMarkdown);
  const all = [...vibes, ...docs, ...github, ...privacy].map((item) => ({
    ...item,
    scoreComponents: {
      pubky_signal: item.subSource === "vibes" || item.subSource === "docs" ? 10 : 5,
      authority: item.subSource === "github" ? Math.min(20, Math.log10(Math.max(1, Number(item.metadata?.stars ?? 0))) * 10) : 5,
      durability: 10,
    },
  }));
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const item of all.sort((a, b) => score(b) - score(a) || a.subSource.localeCompare(b.subSource) || a.value.localeCompare(b.value))) {
    const identity = normalizeUri(item.value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const existing = await options.existingTags?.(item);
    if (existing?.length) continue;
    deduped.push(item);
  }
  const groups = new Map<EcosystemSubSource, Candidate[]>();
  for (const item of deduped) groups.set(item.subSource, [...(groups.get(item.subSource) ?? []), item]);
  const selected: Candidate[] = [];
  while (selected.length < limit) {
    let added = false;
    for (const subSource of PUBKY_ECOSYSTEM_SUB_SOURCES) {
      const group = groups.get(subSource) ?? [];
      const item = group.shift();
      if (!item) continue;
      selected.push(item);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  const run = discoverResources(selected, { category: "pubky", limit, configVersion: options.configVersion });
  for (const sitemapUrl of sitemapEntries) {
    run.rejected.push({
      input: candidate("docs", sitemapUrl, ["pubky", "documentation"], { kind: "sitemap-index" }),
      reason: SITEMAP_INDEX_REJECTION_REASON,
      provenance: {
        source: PUBKY_ECOSYSTEM_SOURCE_ID,
        configVersion: options.configVersion,
        decision: "rejected",
        timestamp: (options.now ?? new Date()).toISOString(),
      },
    });
    run.shadowReport.byRejectionReason[SITEMAP_INDEX_REJECTION_REASON] =
      (run.shadowReport.byRejectionReason[SITEMAP_INDEX_REJECTION_REASON] ?? 0) + 1;
  }
  if (vibesUnavailableReason) {
    run.rejected.push({
      input: candidate("vibes", VIBES_REGISTRY_URL, ["pubky", "vibe"], { kind: "registry", unavailableReason: vibesUnavailableReason }),
      reason: vibesUnavailableReason,
      provenance: {
        source: PUBKY_ECOSYSTEM_SOURCE_ID,
        configVersion: options.configVersion,
        decision: "rejected",
        timestamp: (options.now ?? new Date()).toISOString(),
      },
    });
    run.shadowReport.byRejectionReason[vibesUnavailableReason] =
      (run.shadowReport.byRejectionReason[vibesUnavailableReason] ?? 0) + 1;
  }
  for (const item of skipped) {
    run.rejected.push({
      input: item.input,
      reason: item.reason,
      provenance: {
        source: PUBKY_ECOSYSTEM_SOURCE_ID,
        configVersion: options.configVersion,
        decision: "rejected",
        timestamp: (options.now ?? new Date()).toISOString(),
        scoreComponents: { pubky_signal: 5, authority: 0, durability: 10 },
      },
    });
    run.shadowReport.byRejectionReason[item.reason] = (run.shadowReport.byRejectionReason[item.reason] ?? 0) + 1;
  }
  const bySubSource: Record<string, number> = Object.create(null);
  for (const item of run.accepted) bySubSource[String(item.metadata?.subSource ?? "unknown")] = (bySubSource[String(item.metadata?.subSource ?? "unknown")] ?? 0) + 1;
  run.shadowReport.bySubSource = bySubSource;
  return run;
}

