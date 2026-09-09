import { extractResourceText, fetchResourceText, type FetchResourceResult } from "./resource-fetch.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import type { ExternalResourceInput } from "./external-resources.js";

export const BITCOIN_CANON_SOURCE_ID = "bitcoin-canon";
export const BITCOIN_CANON_CONFIG_VERSION = "bitcoin-canon-v1";
export const BITCOIN_CANON_LIMIT = 100;
export const CROSSREF_API_HOST = "api.crossref.org";

export type CanonSubSource = "bips" | "bolts" | "optech-topics" | "optech-newsletters" | "mailing-lists" | "papers" | "time-anchors";

export type CanonCandidate = {
  url: string;
  title?: string;
  description?: string;
  bodyText?: string;
  metadata: Record<string, unknown>;
  sourceId: string;
  subSource: CanonSubSource;
  authority: number;
  durability: number;
  publishedAt?: string;
  score: {
    pubky_signal: number;
    authority: number;
    durability: number;
    origin_engagement: number;
    freshness: number;
    cost_penalty: number;
  };
};

export type CanonFixtureSet = {
  bips?: string;
  bolts?: string;
  optechTopics?: string;
  optechNewsletters?: string;
  mailingLists?: string;
  papers?: readonly PaperArtifact[];
  anchors?: readonly TimeAnchorArtifact[];
};

export type CanonDiscoverOptions = {
  enabled?: readonly CanonSubSource[];
  includeWithdrawn?: boolean;
  limit?: number;
  fixtures?: CanonFixtureSet;
  fetchText?: (url: string) => Promise<string>;
  now?: Date;
};

export type CanonSourceRegistryEntry = {
  id: typeof BITCOIN_CANON_SOURCE_ID;
  configVersion: string;
  enabled: boolean;
  subSources: readonly CanonSubSource[];
  canonicalForms: Record<CanonSubSource, string>;
};

export const BITCOIN_CANON_SOURCE: CanonSourceRegistryEntry = {
  id: BITCOIN_CANON_SOURCE_ID,
  configVersion: BITCOIN_CANON_CONFIG_VERSION,
  enabled: true,
  subSources: ["bips", "bolts", "optech-topics", "optech-newsletters", "mailing-lists", "papers", "time-anchors"],
  canonicalForms: {
    bips: "https://github.com/bitcoin/bips/blob/master/bip-NNNN.mediawiki|md",
    bolts: "https://github.com/lightning/bolts/blob/master/NN-name.md",
    "optech-topics": "https://bitcoinops.org/en/topics/<slug>/",
    "optech-newsletters": "https://bitcoinops.org/en/newsletters/YYYY/MM/DD/",
    "mailing-lists": "https://gnusha.org/pi/bitcoindev/<message-id>/|https://delvingbitcoin.org/t/<slug>/<id>",
    papers: "https://doi.org/<lowercase-doi>",
    "time-anchors": "https://mempool.space/block/<hash>|https://mempool.space/tx/<txid>",
  },
};

const BIP_INDEX_URL = "https://raw.githubusercontent.com/bitcoin/bips/master/README.mediawiki";
const BOLT_INDEX_URL = "https://github.com/lightning/bolts";
const OPTECH_TOPICS_URL = "https://bitcoinops.org/en/topics/";
const OPTECH_NEWSLETTERS_URL = "https://bitcoinops.org/en/newsletters/";
const GNUSHA_URL = "https://gnusha.org/pi/bitcoindev/";
const DELVING_URL = "https://delvingbitcoin.org/";

const PAPER_SEEDS = [
  { title: "Bitcoin: A Peer-to-Peer Electronic Cash System", url: "https://bitcoin.org/bitcoin.pdf", metadata: { kind: "whitepaper" } },
  { title: "The Bitcoin Lightning Network: Scalable Off-Chain Instant Payments", url: "https://lightning.network/lightning-network-paper.pdf", metadata: { kind: "paper" } },
  { title: "Bitcoin: Economics, Technology, and Governance", doi: "10.1257/jep.29.2.213" },
  { title: "The Economics of Bitcoin Mining, or Bitcoin in the Presence of Adversaries", doi: "10.1016/j.econlet.2016.06.006" },
  { title: "From Bitcoin to Bitcoin Cash", doi: "10.1145/3211933.3211947" },
  { title: "The Bitcoin Backbone Protocol: Analysis and Applications", doi: "10.1109/SP.2015.35" },
  { title: "Bitcoin", doi: "10.1007/s42354-018-0015-4" },
] as const;

export const CANON_PAPER_SEEDS = PAPER_SEEDS;

export type TimeAnchor = {
  kind: "block" | "tx";
  name: string;
  value: string;
  height?: number;
  url: string;
};

export type PaperArtifact = {
  doi: string;
  finalUrl: string;
  title: string;
  authors?: readonly string[];
  abstract?: string;
  venue?: string;
  year?: number;
  subjects?: readonly string[];
};

export function isCanonMetadataUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === CROSSREF_API_HOST && url.pathname.startsWith("/works/") && !url.search && !url.hash;
  } catch {
    return false;
  }
}
export type TimeAnchorArtifact = { name: string; kind: "block" | "tx"; value: string; height?: number };

const HALVINGS = [210_000, 420_000, 630_000, 840_000] as const;
const STATIC_ANCHOR_NAMES = [
  { name: "genesis-block", kind: "block" as const, value: "000000000019d6689c085ae165831e934ff763ae46a2e2a6c172b3f1b60a8ce26" },
  { name: "pizza-transaction", kind: "tx" as const, value: "a1075db55d416d3ca199f55b6084e2115b9345e16c5cf302fc80e9d5fbf5d48d" },
  { name: "segwit-activation", kind: "block" as const, value: "0000000000000000001c8018d9cb3b742ef25114f27563e3fc4a1902167f9893", height: 481824 },
  { name: "taproot-activation", kind: "block" as const, value: "0000000000000000000687bca986194dc2c1f949318629b44bb54ec0a94d8244", height: 709632 },
];

function absoluteUrl(value: string, base: string): string {
  return new URL(value, base).toString();
}

function links(html: string, base: string): string[] {
  const htmlLinks = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]!);
  const markdownLinks = [...html.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!);
  return [...htmlLinks, ...markdownLinks]
    .map((value) => absoluteUrl(value, base))
    .filter((url, index, all) => all.indexOf(url) === index);
}

function text(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function score(authority: number, durability: number, publishedAt?: string): CanonCandidate["score"] {
  const freshness = publishedAt ? Math.max(0, 10 - Math.floor((Date.now() - Date.parse(publishedAt)) / 31_536_000_000)) : 0;
  return { pubky_signal: 0, authority, durability, origin_engagement: 0, freshness, cost_penalty: 0 };
}

function candidate(
  url: string,
  subSource: CanonSubSource,
  metadata: Record<string, unknown>,
  title?: string,
  description?: string,
  publishedAt?: string,
  bodyText?: string,
): CanonCandidate {
  const canonical = normalizeUri(url);
  const authority = Number(metadata.status === "Final" || metadata.status === "Active" ? 10 : metadata.kind === "paper" ? 9 : 7);
  const durability = subSource === "optech-newsletters" || subSource === "mailing-lists" ? 6 : 10;
  return {
    url: canonical,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(bodyText ? { bodyText } : {}),
    metadata,
    sourceId: BITCOIN_CANON_SOURCE_ID,
    subSource,
    authority,
    durability,
    ...(publishedAt ? { publishedAt } : {}),
    score: score(authority, durability, publishedAt),
  };
}

export function parseBips(readme: string, includeWithdrawn = false): CanonCandidate[] {
  const out: CanonCandidate[] = [];
  const lines = readme.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = line.match(/\[\[(?:bip-)?(\d{1,4})(?:\.mediawiki|\.md)?\|[^\]]+\]\]/i);
    if (!match) continue;
    const block = lines.slice(index, lines.findIndex((value, offset) => offset > index && value.startsWith("|-")) < 0 ? lines.length : index + lines.slice(index).findIndex((value, offset) => offset > 0 && value.startsWith("|-")));
    const fields = block.flatMap((value) => {
      const field = value.match(/^\|\s*(.*)$/)?.[1]?.trim();
      return field ? [field] : [];
    });
    const number = match[1]!;
    const inline = line.split("|").map((field) => field.trim()).filter(Boolean);
    const statusIndex = fields.findIndex((field) => /^(?:Final|Active|Draft|Proposed|Withdrawn|Rejected|Obsolete|Closed|Deployed|Deferred|Replaced)$/i.test(field));
    const typeIndex = fields.findIndex((field) => /^(?:Process|Standards Track|Informational|Consensus)$/i.test(field));
    const status = statusIndex >= 0 ? fields[statusIndex]! : inline[5] ?? "Draft";
    const type = typeIndex >= 0 ? fields[typeIndex]! : inline[3] ?? "Standards Track";
    const authors = typeIndex > 0 ? fields[typeIndex - 1]! : fields[2] ?? inline[4] ?? "";
    const title = typeIndex > 1 ? fields[typeIndex - 2]! : fields[1] ?? inline[2] ?? `BIP ${number}`;
    if (!includeWithdrawn && /withdrawn|rejected|obsolete/i.test(status)) continue;
    const padded = number!.padStart(4, "0");
    const extension = /\.md\|/i.test(line) ? "md" : "mediawiki";
    out.push(candidate(
      `https://github.com/bitcoin/bips/blob/master/bip-${padded}.${extension}`,
      "bips",
      { number: Number(number), status: text(status), type: text(type), authors: text(authors), layer: "consensus" },
      text(title),
    ));
  }
  return out;
}

export function parseBolts(readme: string): CanonCandidate[] {
  const names = new Set<string>();
  for (const url of links(readme, "https://github.com/lightning/bolts/")) {
    const match = url.match(/\/(\d{2})-([a-z0-9-]+)\.md$/i);
    if (match) names.add(`${match[1]}-${match[2]}.md`);
  }
  for (const match of readme.matchAll(/(?:^|\/)(\d{2}-[a-z0-9-]+\.md)\b/gi)) names.add(match[1]!);
  return [...names].sort().map((name) => {
    const match = name.match(/^(\d{2})-([a-z0-9-]+)\.md$/i)!;
    return candidate(
      `https://github.com/lightning/bolts/blob/master/${match[1]}-${match[2]}.md`,
      "bolts",
      { number: Number(match[1]), status: "Active", type: "protocol" },
      `BOLT ${match[1]} ${match[2].replace(/-/g, " ")}`,
    );
  });
}

export function parseOptechTopics(index: string): CanonCandidate[] {
  return links(index, OPTECH_TOPICS_URL)
    .filter((url) => /\/en\/topics\/[^/]+\/?$/.test(new URL(url).pathname))
    .map((url) => candidate(url, "optech-topics", { kind: "topic" }, text(new URL(url).pathname.split("/").at(-1) ?? "")));
}

export function parseOptechNewsletters(index: string, now = new Date()): CanonCandidate[] {
  const rows = links(index, OPTECH_NEWSLETTERS_URL)
    .map((url) => ({ url, match: new URL(url).pathname.match(/\/newsletters\/(\d{4})\/(\d{2})\/(\d{2})\/?$/) }))
    .filter((row): row is { url: string; match: RegExpMatchArray } => Boolean(row.match))
    .sort((a, b) => b.url.localeCompare(a.url))
    .slice(0, 52);
  return rows.map(({ url, match }) => {
    const publishedAt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString();
    return candidate(url, "optech-newsletters", { kind: "newsletter" }, `Bitcoin Optech Newsletter ${match[1]}-${match[2]}-${match[3]}`, undefined, publishedAt);
  }).filter((item) => Date.parse(item.publishedAt!) <= now.getTime());
}

export function canonicalizeDelvingUrl(raw: string): string {
  const url = new URL(raw);
  const match = url.pathname.match(/^\/t\/([^/]+)\/(\d+)(?:\/\d+)?\/?$/);
  if (!match) throw new Error("invalid Delving Bitcoin thread URL");
  return normalizeUri(`https://delvingbitcoin.org/t/${match[1]}/${match[2]}`);
}

export function parseMailingLists(index: string): CanonCandidate[] {
  const out: CanonCandidate[] = [];
  for (const url of links(index, GNUSHA_URL)) {
    if (/\/pi\/bitcoindev\/(?:[^/]+\/)*[^/]+\/?$/.test(new URL(url).pathname)) {
      out.push(candidate(url, "mailing-lists", { kind: "bitcoin-dev", archive: "gnusha" }));
    }
  }
  for (const url of links(index, DELVING_URL)) {
    if (/\/t\/[^/]+\/\d+(?:\/\d+)?\/?$/.test(new URL(url).pathname)) {
      out.push(candidate(canonicalizeDelvingUrl(url), "mailing-lists", { kind: "thread", archive: "delving-bitcoin" }));
    }
  }
  return out;
}

export function paperCandidates(artifacts: readonly PaperArtifact[] = []): CanonCandidate[] {
  const verified = new Map(artifacts.map((artifact) => [artifact.doi.toLowerCase(), artifact]));
  return PAPER_SEEDS.map((seed) => {
    if ("doi" in seed) {
      // DOI Handbook §2.5 says DOI names are case-insensitive:
      // https://www.doi.org/doi-handbook/HTML/doi-handbook.html#2.5
      const doi = seed.doi.toLowerCase();
      const artifact = verified.get(doi);
      const context = [
        `Title: ${artifact?.title ?? seed.title}`,
        artifact?.abstract,
        artifact?.authors?.length ? `Authors: ${artifact.authors.join(", ")}` : undefined,
        artifact?.venue ? `Venue: ${artifact.venue}` : undefined,
        artifact?.year ? `Year: ${artifact.year}` : undefined,
        artifact?.subjects?.length ? `Subjects: ${artifact.subjects.join(", ")}` : undefined,
      ].filter(Boolean).join(". ");
      return candidate(
        `https://doi.org/${doi}`,
        "papers",
        { kind: "paper", doi, resolvedUrl: artifact?.finalUrl, authors: artifact?.authors, venue: artifact?.venue, year: artifact?.year, subjects: artifact?.subjects },
        artifact?.title ?? seed.title,
        context || seed.title,
        undefined,
        context || seed.title,
      );
    }
    return candidate(seed.url, "papers", seed.metadata, seed.title);
  });
}

export function timeAnchorCandidates(artifacts: readonly TimeAnchorArtifact[] = []): CanonCandidate[] {
  const resolved = new Map(artifacts.map((item) => [item.name, item]));
  const anchors: TimeAnchor[] = [...STATIC_ANCHOR_NAMES, ...HALVINGS.map((height) => ({
    name: `halving-${height}`,
    kind: "block" as const,
    value: resolved.get(`halving-${height}`)?.value ?? "",
    height,
  }))].map((item) => ({ ...item, value: resolved.get(item.name)?.value || item.value, url: `https://mempool.space/${item.kind}/${resolved.get(item.name)?.value || item.value}` }));
  return anchors.filter((item) => item.value.length > 0).map((item) => {
    const context = anchorContext(item);
    return candidate(item.url, "time-anchors", { kind: item.kind, name: item.name, ...(item.height ? { height: item.height } : {}) }, item.name, context, undefined, context);
  });
}

function anchorContext(anchor: TimeAnchor): string {
  const details = (() => {
    switch (anchor.name) {
      case "genesis-block":
        return "Bitcoin genesis block, the first block of the chain mined by Satoshi Nakamoto on 2009-01-03.";
      case "pizza-transaction":
        return "Bitcoin pizza transaction: 10,000 BTC paid by Laszlo Hanyecz for two pizzas on 2010-05-22, widely recognized as the first commercial Bitcoin transaction.";
      case "segwit-activation":
        return "SegWit activation block, BIP-141 deployment and witness-version consensus activation.";
      case "taproot-activation":
        return "Taproot activation block, BIP-341 and BIP-342 deployment with Schnorr signatures.";
      default:
        if (/^halving-\d+$/.test(anchor.name) && anchor.height !== undefined) {
          return `Bitcoin halving block at height ${anchor.height}, a canonical subsidy-schedule time anchor.`;
        }
        throw new Error(`unknown time anchor: ${anchor.name}`);
    }
  })();
  return `${anchor.name}: ${details} Canonical ${anchor.kind} identifier ${anchor.value}.`;
}

async function fetchText(url: string, supplied?: (url: string) => Promise<string>): Promise<string> {
  const result: FetchResourceResult = supplied
    ? { ok: true, text: await supplied(url), finalUrl: url, bytes: 0, truncated: false, fromCache: false }
    : await fetchResourceText(url, { rawBody: true });
  if (!result.ok) throw new Error(`canon fetch failed for ${url}: ${result.reason}`);
  return result.text;
}

async function fetchCrossrefMetadata(doi: string, supplied?: (url: string) => Promise<string>): Promise<PaperArtifact> {
  const url = `https://${CROSSREF_API_HOST}/works/${doi}`;
  if (!isCanonMetadataUrl(url)) throw new Error("Crossref metadata URL is outside the canon gate");
  const raw = supplied
    ? await supplied(url)
    : await (async () => {
      const result = await fetchResourceText(url, { rawBody: true, acceptJson: true, cacheNamespace: "crossref" });
      if (!result.ok) throw new Error(`Crossref fetch failed: ${result.reason}`);
      return result.text;
    })();
  const message = (JSON.parse(raw) as { message?: Record<string, unknown> }).message;
  if (!message) throw new Error("Crossref response has no message");
  const title = Array.isArray(message.title) && typeof message.title[0] === "string" ? message.title[0] : doi;
  const authors = Array.isArray(message.author)
    ? message.author.map((author) => {
      if (!author || typeof author !== "object") return "";
      const value = author as { given?: unknown; family?: unknown };
      return [value.given, value.family].filter((part): part is string => typeof part === "string").join(" ");
    }).filter(Boolean)
    : [];
  const abstract = typeof message.abstract === "string" ? extractResourceText(message.abstract).text : undefined;
  const container = message["container-title"];
  const venue = Array.isArray(container) && typeof container[0] === "string" ? container[0] : undefined;
  const dateParts = (message.issued as { ["date-parts"]?: unknown } | undefined)?.["date-parts"];
  const year = Array.isArray(dateParts) && Array.isArray(dateParts[0]) && typeof dateParts[0][0] === "number" ? dateParts[0][0] : undefined;
  const subjects = Array.isArray(message.subject) ? message.subject.filter((subject): subject is string => typeof subject === "string") : [];
  return { doi, finalUrl: `https://doi.org/${doi}`, title, authors, abstract, venue, year, subjects };
}

export function toResourceInputs(candidates: readonly CanonCandidate[]): ExternalResourceInput[] {
  return candidates.map((item) => ({
    family: "url",
    value: item.url,
    source: BITCOIN_CANON_SOURCE_ID,
    labels: [],
    title: item.title,
    description: item.description,
    bodyText: item.bodyText,
    observedAt: item.publishedAt,
    metadata: item.metadata,
    scoreComponents: item.score,
    taxonomy: { domain: ["bitcoin"], type: [item.subSource === "bips" ? "bip" : item.subSource === "bolts" ? "bolt" : "reference"] },
  }));
}

export function capCanonCandidates(candidates: readonly CanonCandidate[], limit = BITCOIN_CANON_LIMIT): CanonCandidate[] {
  const capped = Math.min(limit, BITCOIN_CANON_LIMIT);
  const interest = (item: CanonCandidate): number => {
    const parts = item.score;
    return 3 * parts.pubky_signal + 2 * parts.authority + 2 * parts.durability +
      parts.origin_engagement + parts.freshness - parts.cost_penalty;
  };
  const sorted = [...candidates].sort((a, b) => interest(b) - interest(a) || a.subSource.localeCompare(b.subSource) || a.url.localeCompare(b.url));
  const groups = new Map<CanonSubSource, CanonCandidate[]>();
  for (const item of sorted) groups.set(item.subSource, [...(groups.get(item.subSource) ?? []), item]);
  const enabled = [...groups.entries()].filter(([, values]) => values.length > 0);
  const perSource = Math.max(1, Math.floor(capped * 0.4));
  const floor = Math.min(5, Math.floor(capped / Math.max(1, enabled.length)));
  const result: CanonCandidate[] = [];
  for (const [, values] of enabled) result.push(...values.slice(0, Math.min(perSource, floor)));
  let cursor = 0;
  while (result.length < capped && enabled.length > 0) {
    const [, values] = enabled[cursor % enabled.length]!;
    const item = values[result.filter((candidate) => candidate.subSource === values[0]?.subSource).length];
    if (item && !result.includes(item)) result.push(item);
    cursor += 1;
    if (cursor > sorted.length * 3) break;
  }
  return result.sort((a, b) => a.url.localeCompare(b.url)).slice(0, capped);
}

export async function discoverBitcoinCanon(options: CanonDiscoverOptions = {}): Promise<CanonCandidate[]> {
  const enabled = new Set(options.enabled ?? BITCOIN_CANON_SOURCE.subSources);
  const fixtures = options.fixtures ?? {};
  const read = (url: string) => fetchText(url, options.fetchText);
  const all: CanonCandidate[] = [];
  if (enabled.has("bips")) all.push(...parseBips(fixtures.bips ?? await read(BIP_INDEX_URL), options.includeWithdrawn));
  if (enabled.has("bolts")) all.push(...parseBolts(fixtures.bolts ?? await read(BOLT_INDEX_URL)));
  if (enabled.has("optech-topics")) all.push(...parseOptechTopics(fixtures.optechTopics ?? await read(OPTECH_TOPICS_URL)));
  if (enabled.has("optech-newsletters")) all.push(...parseOptechNewsletters(fixtures.optechNewsletters ?? await read(OPTECH_NEWSLETTERS_URL), options.now));
  if (enabled.has("mailing-lists")) all.push(...parseMailingLists(fixtures.mailingLists ?? `${await read(GNUSHA_URL)}\n${await read(DELVING_URL)}`));
  if (enabled.has("papers")) {
    const artifacts = fixtures.papers ? [...fixtures.papers] : [];
    if (!fixtures.papers) {
      for (const seed of PAPER_SEEDS) {
        if (!("doi" in seed)) continue;
        try {
          artifacts.push(await fetchCrossrefMetadata(seed.doi, options.fetchText));
        } catch {
          // The DOI remains a valid candidate with its configured seed title.
        }
      }
    }
    all.push(...paperCandidates(artifacts));
  }
  if (enabled.has("time-anchors")) all.push(...timeAnchorCandidates(fixtures.anchors));
  const selected = capCanonCandidates(all, options.limit);
  for (const item of selected) {
    if (item.subSource !== "optech-newsletters" || item.bodyText) continue;
    try {
      // Use the raw-artifact cache namespace so an older truncated/extracted
      // cache entry can never hide the issue body from the model.
      const page = await fetchResourceText(item.url, { rawBody: true });
      if (page.ok) item.bodyText = extractResourceText(page.text).text;
    } catch {
      // The candidate remains valid; provenance records the absence of page text.
    }
  }
  return selected;
}

export function candidateIdentity(candidateValue: CanonCandidate): string {
  return resourceIdentity(normalizeUri(candidateValue.url));
}
