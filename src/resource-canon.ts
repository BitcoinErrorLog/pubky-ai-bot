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
  maxRequests?: number;
  log?: (line: Record<string, unknown>) => void;
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
const MEMPOOL_BLOCK_HEIGHT_URL = "https://mempool.space/api/block-height/";
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CROSSREF_TITLE_CHARS = 512;

export class DiscoveryRequestBudgetExceeded extends Error {
  constructor(url?: string) {
    super(`canon request budget exceeded${url ? ` at ${url}` : ""}`);
    this.name = "DiscoveryRequestBudgetExceeded";
  }
}

function cleanCrossrefTitle(value: string): string {
  return [...value].filter((char) => {
    const code = char.codePointAt(0)!;
    return !((code < 0x20 && code !== 0x09 && code !== 0x0a) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0x200e || code === 0x200f || code === 0x061c);
  }).join("").slice(0, MAX_CROSSREF_TITLE_CHARS);
}

const cleanCrossrefText = cleanCrossrefTitle;

type PaperSeed = {
  title: string;
  url?: string;
  doi?: string;
  authors?: readonly string[];
  publishedAt?: string;
  authorityBoost?: number;
};

const PAPER_SEEDS: readonly PaperSeed[] = [
  {
    url: "https://bitcoin.org/bitcoin.pdf",
    title: "Bitcoin: A Peer-to-Peer Electronic Cash System",
    authors: ["Satoshi Nakamoto"],
    publishedAt: "2008-10-31T00:00:00.000Z",
    authorityBoost: 20,
  },
  {
    url: "https://lightning.network/lightning-network-paper.pdf",
    title: "The Bitcoin Lightning Network: Scalable Off-Chain Instant Payments",
    authors: ["Joseph Poon", "Thaddeus Dryja"],
    publishedAt: "2016-01-14T00:00:00.000Z",
    authorityBoost: 19,
  },
  { title: "The Bitcoin Backbone Protocol: Analysis and Applications", doi: "10.1007/978-3-662-46803-6_10" },
  { title: "Majority Is Not Enough: Bitcoin Mining Is Vulnerable", doi: "10.1007/978-3-662-45472-5_28" },
  { title: "SoK: Research Perspectives and Challenges for Bitcoin and Cryptocurrencies", doi: "10.1109/SP.2015.14" },
  { title: "A fistful of bitcoins", doi: "10.1145/2504730.2504747" },
  { title: "Zerocash: Decentralized Anonymous Payments from Bitcoin", doi: "10.1109/SP.2014.36" },
  { title: "Deanonymisation of Clients in Bitcoin P2P Network", doi: "10.1145/2660267.2660379" },
  { title: "On the Security and Performance of Proof of Work Blockchains", doi: "10.1145/2976749.2978341" },
  { title: "Bitcoin: Economics, Technology, and Governance", doi: "10.1257/jep.29.2.213" },
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

function pinnedLinks(index: string, base: string, host: string): URL[] {
  return links(index, base).flatMap((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === host && !url.search && !url.hash ? [url] : [];
    } catch {
      return [];
    }
  });
}

function text(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function titleTokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(/\s+/).filter(Boolean));
}

function titlesMatch(seedTitle: string, crossrefTitle: string): boolean {
  const seedTokens = titleTokens(seedTitle);
  const candidateTokens = titleTokens(crossrefTitle);
  if (seedTokens.size === 0 || candidateTokens.size === 0) return false;
  const overlap = [...seedTokens].filter((token) => candidateTokens.has(token)).length;
  return overlap / Math.max(seedTokens.size, candidateTokens.size) >= 0.8;
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
  const priority = subSource === "papers" ? 1000 :
    subSource === "time-anchors" ? 900 :
      subSource === "bips" ? 800 :
        subSource === "optech-topics" ? 700 :
          subSource === "optech-newsletters" ? 600 :
            subSource === "mailing-lists" ? 500 : 400;
  const authority = priority +
    Number(metadata.status === "Final" || metadata.status === "Active" ? 10 : 0) +
    Number(metadata.authorityBoost ?? 0);
  const durability = priority + (subSource === "optech-newsletters" || subSource === "mailing-lists" ? 6 : 10);
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
  const seenNumbers = new Set<string>();
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
    if (seenNumbers.has(number)) continue;
    seenNumbers.add(number);
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
  return pinnedLinks(index, OPTECH_TOPICS_URL, "bitcoinops.org")
    .filter((url) => /\/en\/topics\/[^/]+\/?$/.test(url.pathname))
    .map((url) => candidate(url.toString(), "optech-topics", { kind: "topic" }, text(url.pathname.split("/").at(-1) ?? "")));
}

export function parseOptechNewsletters(index: string, now = new Date()): CanonCandidate[] {
  const rows = pinnedLinks(index, OPTECH_NEWSLETTERS_URL, "bitcoinops.org")
    .map((url) => ({ url, match: url.pathname.match(/\/newsletters\/(\d{4})\/(\d{2})\/(\d{2})\/?$/) }))
    .filter((row): row is { url: URL; match: RegExpMatchArray } => Boolean(row.match))
    .sort((a, b) => b.url.toString().localeCompare(a.url.toString()))
    .slice(0, 52);
  return rows.map(({ url, match }) => {
    const publishedAt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString();
    return candidate(url.toString(), "optech-newsletters", { kind: "newsletter" }, `Bitcoin Optech Newsletter ${match[1]}-${match[2]}-${match[3]}`, undefined, publishedAt);
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
  for (const value of links(index, GNUSHA_URL)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || url.hostname !== "gnusha.org" || url.search) continue;
    const match = url.pathname.match(/^\/pi\/bitcoindev\/([^/]+)(?:\/T)?\/?$/);
    const messageId = match?.[1];
    if (!messageId || messageId === "_" || messageId.includes("%") || !messageId.includes("@") || /[/?#]/.test(messageId)) continue;
    const messageOffset = index.indexOf(messageId);
    const anchorStart = Math.max(0, index.lastIndexOf("<a", messageOffset));
    const anchorEnd = index.indexOf("</a>", messageOffset);
    const anchor = index.slice(anchorStart, anchorEnd >= 0 ? anchorEnd + 304 : messageOffset + messageId.length + 300);
    const subject = text(anchor.match(/>\s*(?:\[bitcoindev\]\s*)?([^<]+)</i)?.[1] ?? "").trim();
    const from = text(anchor.match(/\bFrom:\s*([^<\n]+)/i)?.[1] ?? "").trim();
    out.push(candidate(`https://gnusha.org/pi/bitcoindev/${messageId}/`, "mailing-lists", {
      kind: "bitcoin-dev", archive: "gnusha", ...(from ? { from } : {}),
    }, subject && subject !== "[bitcoindev]" ? subject : undefined));
  }
  for (const url of pinnedLinks(index, DELVING_URL, "delvingbitcoin.org")) {
    if (/\/t\/[^/]+\/\d+(?:\/\d+)?\/?$/.test(url.pathname)) {
      const offset = index.indexOf(url.pathname);
      const rowStart = index.lastIndexOf("<tr", offset);
      const rowEnd = index.indexOf("</tr>", offset);
      const row = index.slice(rowStart >= 0 ? rowStart : offset, rowEnd >= 0 ? rowEnd : offset + 2_000);
      const category = text(row.match(/class=['"][^'"]*category-name[^'"]*['"][^>]*>([^<]+)/i)?.[1] ?? "");
      if (category.toLowerCase() === "meta") continue;
      out.push(candidate(canonicalizeDelvingUrl(url.toString()), "mailing-lists", { kind: "thread", archive: "delving-bitcoin" }));
    }
  }
  return out;
}

export function paperCandidates(artifacts: readonly PaperArtifact[] = []): CanonCandidate[] {
  const verified = new Map(artifacts.map((artifact) => [artifact.doi.toLowerCase(), artifact]));
  return PAPER_SEEDS.map((seed) => {
    if (seed.url) {
      const context = [`Title: ${seed.title}`, seed.authors?.length ? `Authors: ${seed.authors.join(", ")}` : undefined]
        .filter(Boolean).join(". ");
      return candidate(
        seed.url,
        "papers",
        { kind: "paper", direct: true, authors: seed.authors, publishedAt: seed.publishedAt, authorityBoost: seed.authorityBoost },
        seed.title,
        context,
        seed.publishedAt,
      );
    }
    if (!seed.doi) throw new Error("paper seed must have a DOI or URL");
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
  });
}

export function timeAnchorCandidates(artifacts: readonly TimeAnchorArtifact[] = []): CanonCandidate[] {
  for (const item of artifacts) {
    if (!HASH_PATTERN.test(item.value)) throw new Error(`invalid time anchor hash: ${item.name}`);
    if (!HALVINGS.some((height) => item.name === `halving-${height}`)) throw new Error(`static time anchor cannot be overridden: ${item.name}`);
  }
  const resolved = new Map(artifacts.map((item) => [item.name, item]));
  const anchors: TimeAnchor[] = [...STATIC_ANCHOR_NAMES, ...HALVINGS.map((height) => ({
    name: `halving-${height}`,
    kind: "block" as const,
    value: resolved.get(`halving-${height}`)?.value ?? "",
    height,
  }))].map((item) => {
    const value = resolved.get(item.name)?.value || item.value;
    return { ...item, value, url: `https://mempool.space/${item.kind}/${value}` };
  });
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
  const title = Array.isArray(message.title) && typeof message.title[0] === "string" ? cleanCrossrefTitle(message.title[0]) : doi;
  const authors = Array.isArray(message.author)
    ? message.author.map((author) => {
      if (!author || typeof author !== "object") return "";
      const value = author as { given?: unknown; family?: unknown };
      return [value.given, value.family]
        .filter((part): part is string => typeof part === "string")
        .map(cleanCrossrefText)
        .join(" ");
    }).filter(Boolean)
    : [];
  const abstract = typeof message.abstract === "string" ? extractResourceText(message.abstract).text : undefined;
  const container = message["container-title"];
  const venue = Array.isArray(container) && typeof container[0] === "string" ? cleanCrossrefText(container[0]) : undefined;
  const dateParts = (message.issued as { ["date-parts"]?: unknown } | undefined)?.["date-parts"];
  const year = Array.isArray(dateParts) && Array.isArray(dateParts[0]) && typeof dateParts[0][0] === "number" ? dateParts[0][0] : undefined;
  const subjects = Array.isArray(message.subject)
    ? message.subject.filter((subject): subject is string => typeof subject === "string").map(cleanCrossrefText)
    : [];
  return { doi, finalUrl: `https://doi.org/${doi}`, title, authors, abstract, venue, year, subjects };
}

export function toResourceInputs(candidates: readonly CanonCandidate[]): ExternalResourceInput[] {
  return candidates.map((item) => ({
    family: "url",
    value: item.url,
    source: BITCOIN_CANON_SOURCE_ID,
    labels: item.subSource === "papers" && typeof item.metadata.doi === "string" ? ["project"] : [],
    authors: Array.isArray(item.metadata.authors)
      ? item.metadata.authors.filter((value): value is string => typeof value === "string")
      : typeof item.metadata.from === "string" ? [item.metadata.from] : undefined,
    title: item.title,
    description: item.description,
    bodyText: item.bodyText,
    observedAt: item.subSource === "papers" ? undefined : item.publishedAt,
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
  const sourceOrder: CanonSubSource[] = [
    "papers", "time-anchors", "bips", "optech-topics", "optech-newsletters", "mailing-lists", "bolts",
  ];
  const groups = new Map<CanonSubSource, CanonCandidate[]>();
  for (const item of candidates) groups.set(item.subSource, [...(groups.get(item.subSource) ?? []), item]);
  const enabled = sourceOrder
    .map((source) => [source, [...(groups.get(source) ?? [])].sort((a, b) => interest(b) - interest(a) || a.url.localeCompare(b.url))] as const)
    .filter(([, values]) => values.length > 0);
  if (enabled.length === 0) return [];
  const slots = Math.floor(capped / enabled.length);
  const result: CanonCandidate[] = [];
  const selected = new Set<CanonCandidate>();
  for (const [, values] of enabled) {
    for (const item of values.slice(0, slots)) {
      result.push(item);
      selected.add(item);
    }
  }
  const remaining = [...candidates]
    .filter((item) => !selected.has(item))
    .sort((a, b) => interest(b) - interest(a) || a.subSource.localeCompare(b.subSource) || a.url.localeCompare(b.url));
  result.push(...remaining.slice(0, Math.max(0, capped - result.length)));
  return result.slice(0, capped);
}

export async function discoverBitcoinCanon(options: CanonDiscoverOptions = {}): Promise<CanonCandidate[]> {
  const enabled = new Set(options.enabled ?? BITCOIN_CANON_SOURCE.subSources);
  const fixtures = options.fixtures ?? {};
  let requests = 0;
  const maxRequests = options.maxRequests ?? 200;
  const consumeRequest = (url: string): void => {
    requests += 1;
    if (requests > maxRequests) throw new DiscoveryRequestBudgetExceeded(url);
  };
  const read = (url: string) => {
    consumeRequest(url);
    return fetchText(url, options.fetchText);
  };
  const all: CanonCandidate[] = [];
  if (enabled.has("bips")) all.push(...parseBips(fixtures.bips ?? await read(BIP_INDEX_URL), options.includeWithdrawn));
  if (enabled.has("bolts")) all.push(...parseBolts(fixtures.bolts ?? await read(BOLT_INDEX_URL)));
  if (enabled.has("optech-topics")) all.push(...parseOptechTopics(fixtures.optechTopics ?? await read(OPTECH_TOPICS_URL)));
  if (enabled.has("optech-newsletters")) all.push(...parseOptechNewsletters(fixtures.optechNewsletters ?? await read(OPTECH_NEWSLETTERS_URL), options.now));
  if (enabled.has("mailing-lists")) all.push(...parseMailingLists(fixtures.mailingLists ?? `${await read(GNUSHA_URL)}\n${await read(DELVING_URL)}`));
  if (enabled.has("papers")) {
    const artifacts = fixtures.papers ? [...fixtures.papers] : [];
    const rejectedDois = new Set<string>();
    if (!fixtures.papers) {
      for (const seed of PAPER_SEEDS) {
        if (!seed.doi) continue;
        const doi = seed.doi;
        consumeRequest(`https://${CROSSREF_API_HOST}/works/${doi}`);
        try {
          const artifact = await fetchCrossrefMetadata(doi, options.fetchText);
          if (!titlesMatch(seed.title, artifact.title)) {
            options.log?.({ doi, reason: "doi-title-mismatch", seedTitle: seed.title, crossrefTitle: artifact.title });
            rejectedDois.add(doi.toLowerCase());
            continue;
          }
          artifacts.push(artifact);
        } catch {
          // The DOI remains a valid candidate with its configured seed title.
        }
      }
    }
    for (const artifact of artifacts) {
      const seed = PAPER_SEEDS.find((item) => item.doi?.toLowerCase() === artifact.doi.toLowerCase());
      if (seed && !titlesMatch(seed.title, artifact.title)) {
        options.log?.({ doi: artifact.doi, reason: "doi-title-mismatch", seedTitle: seed.title, crossrefTitle: artifact.title });
        rejectedDois.add(artifact.doi.toLowerCase());
      }
    }
    all.push(...paperCandidates(artifacts).filter((item) => !rejectedDois.has(String(item.metadata.doi).toLowerCase())));
  }
  if (enabled.has("time-anchors")) {
    const anchors = fixtures.anchors ? [...fixtures.anchors] : [];
    if (!fixtures.anchors) {
      for (const height of HALVINGS) {
        const name = `halving-${height}`;
        const url = `${MEMPOOL_BLOCK_HEIGHT_URL}${height}`;
        consumeRequest(url);
        try {
          const raw = options.fetchText
            ? await options.fetchText(url)
            : await (async () => {
              const result = await fetchResourceText(url, { rawBody: true, requiredContentType: "text/plain", ttlDays: 14 });
              if (!result.ok) throw new Error(`halving fetch failed: ${result.reason}`);
              return result.text;
            })();
          const value = raw.trim();
          if (HASH_PATTERN.test(value)) anchors.push({ name, kind: "block", value, height });
          else options.log?.({ url, anchor: name, reason: "invalid_anchor_hash" });
        } catch (error) {
          (options.log ?? ((line) => console.error(JSON.stringify(line))))({
            url,
            anchor: name,
            reason: "anchor-unresolved",
            detail: error instanceof Error ? error.message : "halving_fetch_failed",
          });
        }
      }
    }
    all.push(...timeAnchorCandidates(anchors));
  }
  const selected = capCanonCandidates(all, options.limit);
  for (const item of selected) {
    if (!["optech-newsletters", "optech-topics", "mailing-lists"].includes(item.subSource) || item.bodyText) continue;
    if (!options.fetchText && (
      (item.subSource === "optech-newsletters" && options.fixtures?.optechNewsletters) ||
      (item.subSource === "optech-topics" && options.fixtures?.optechTopics) ||
      (item.subSource === "mailing-lists" && options.fixtures?.mailingLists)
    )) continue;
    try {
      // Use the raw-artifact cache namespace so an older truncated/extracted
      // cache entry can never hide the issue body from the model.
      consumeRequest(item.url);
      const page = options.fetchText
        ? { ok: true as const, text: await options.fetchText(item.url) }
        : await fetchResourceText(item.url, { rawBody: true });
      if (page.ok) {
        const extracted = extractResourceText(page.text);
        item.bodyText = extracted.text;
        const genericMailingSubject = item.subSource === "mailing-lists" && item.title === undefined;
        if (genericMailingSubject && extracted.title && extracted.title !== "[bitcoindev]") item.title = extracted.title;
        if (genericMailingSubject && !item.title) {
          const firstLine = extracted.text.split(/\r?\n/, 1)[0]?.trim();
          if (firstLine) item.title = firstLine.slice(0, 300);
        }
        if (!item.title && extracted.title) item.title = extracted.title;
        if (item.subSource === "mailing-lists" && extracted.authors[0]) item.metadata.from = extracted.authors[0];
      }
    } catch (error) {
      if (error instanceof DiscoveryRequestBudgetExceeded) throw error;
      // The candidate remains valid; provenance records the absence of page text.
    }
  }
  return selected;
}

export function candidateIdentity(candidateValue: CanonCandidate): string {
  return resourceIdentity(normalizeUri(candidateValue.url));
}
