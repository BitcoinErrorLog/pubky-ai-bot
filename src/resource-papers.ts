import { assertAllowedResourceReadUrl } from "./outbound-gate.js";
import { discoverResources, type ExternalResourceInput, type ResourceRun } from "./external-resources.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";

export const PAPERS_SOURCE_ID = "papers";
export const PAPERS_REQUEST_BUDGET = 100;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_XML_DEPTH = 32;
const MAX_PAPERS_PER_SOURCE = 100;
const ARXIV_URL = "https://export.arxiv.org/api/query?search_query=%28all%3Abitcoin%20OR%20all%3A%22lightning%20network%22%29%20AND%20%28cat%3Acs.CR%20OR%20cat%3Acs.DC%20OR%20cat%3Aq-fin%29&start=0&max_results=40";
const IACR_URL = "https://eprint.iacr.org/rss/rss.xml";
const DOI_PATTERN = /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i;
const ARXIV_ID_PATTERN = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
const EPRINT_ID_PATTERN = /^\d{4}\/\d{1,6}$/;
const XML_FORBIDDEN = /<!DOCTYPE|<!ENTITY/i;

type SubSource = "arxiv" | "iacr-eprint" | "crossref";
type Paper = {
  url: string;
  source: SubSource;
  title: string;
  abstract?: string;
  categories: string[];
  doi?: string;
};

export type PapersDiscoverOptions = {
  limit: number;
  contactEmail?: string;
  configVersion?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

type SubSourceResult = { papers: Paper[]; requests: number; unavailable?: string; truncated?: boolean };

function clean(value: string, max = 4_096): string {
  return value.replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function xmlTag(value: string, name: string): string | undefined {
  return value.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1];
}

function xmlValues(value: string, name: string): string[] {
  return [...value.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "gi"))].map((match) => clean(match[1]!, 512)).filter(Boolean);
}

function assertSafeXml(body: string): void {
  if (!body.trim()) throw new Error("empty response");
  if (XML_FORBIDDEN.test(body)) throw new Error("forbidden XML declaration");
  let depth = 0;
  for (const match of body.matchAll(/<\/?([A-Za-z][\w:.-]*)(?:\s[^>]*)?>/g)) {
    if (match[0]!.startsWith("</")) depth -= 1;
    else if (!match[0]!.endsWith("/>")) depth += 1;
    if (depth < 0 || depth > MAX_XML_DEPTH) throw new Error("invalid XML depth");
  }
  if (depth !== 0) throw new Error("unbalanced XML");
}

export function canonicalPaperUrl(paper: Pick<Paper, "doi" | "url">): string {
  if (paper.doi && DOI_PATTERN.test(paper.doi)) return `https://doi.org/${paper.doi.toLowerCase()}`;
  const url = new URL(paper.url);
  if (url.hostname === "arxiv.org") {
    const id = url.pathname.match(/^\/abs\/([^/]+)$/)?.[1];
    if (!id || !ARXIV_ID_PATTERN.test(id)) throw new Error("invalid arXiv id");
    return `https://arxiv.org/abs/${id.replace(/v\d+$/i, "")}`;
  }
  if (url.hostname === "eprint.iacr.org") {
    const id = url.pathname.slice(1);
    if (!EPRINT_ID_PATTERN.test(id)) throw new Error("invalid ePrint id");
    return `https://eprint.iacr.org/${id}`;
  }
  throw new Error("invalid canonical paper host");
}

export function parseArxivAtom(body: string): Paper[] {
  assertSafeXml(body);
  const entries = [...body.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].slice(0, MAX_PAPERS_PER_SOURCE);
  if (entries.length === 0) throw new Error("arXiv response has no entries");
  const papers: Paper[] = [];
  for (const entry of entries) {
    const row = entry[1]!;
    const id = clean(xmlTag(row, "id") ?? "", 256);
    const title = clean(xmlTag(row, "title") ?? "", 512);
    const abstract = clean(xmlTag(row, "summary") ?? "");
    const arxivId = id.match(/^https:\/\/arxiv\.org\/abs\/([^/?#]+)$/)?.[1];
    const doi = clean(xmlTag(row, "arxiv:doi") ?? "", 256).toLowerCase();
    const categories = [...row.matchAll(/<category\s+[^>]*term=["']([^"']+)["'][^>]*\/?>/gi)].map((m) => m[1]!).filter((v) => /^[a-z-]+\.[A-Z]{2}$/.test(v));
    if (!arxivId || !ARXIV_ID_PATTERN.test(arxivId) || !title) continue;
    papers.push({ url: `https://arxiv.org/abs/${arxivId}`, source: "arxiv", title, abstract, categories, ...(DOI_PATTERN.test(doi) ? { doi } : {}) });
  }
  if (papers.length === 0) throw new Error("arXiv rows are malformed");
  return papers;
}

export function parseIacrRss(body: string): Paper[] {
  assertSafeXml(body);
  const items = [...body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].slice(0, MAX_PAPERS_PER_SOURCE);
  if (items.length === 0) throw new Error("IACR response has no items");
  const papers: Paper[] = [];
  for (const item of items) {
    const row = item[1]!;
    const url = clean(xmlTag(row, "link") ?? "", 256);
    const title = clean(xmlTag(row, "title") ?? "", 512);
    if (!title || !/^https:\/\/eprint\.iacr\.org\/\d{4}\/\d{1,6}$/.test(url)) continue;
    papers.push({ url, source: "iacr-eprint", title, abstract: clean(xmlTag(row, "description") ?? ""), categories: ["cryptography"] });
  }
  if (papers.length === 0) throw new Error("IACR rows are malformed");
  return papers;
}

export function parseCrossrefJson(body: string): Paper[] {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error("invalid Crossref JSON"); }
  const rows = parsed && typeof parsed === "object" && Array.isArray((parsed as { message?: { items?: unknown } }).message?.items)
    ? (parsed as { message: { items: unknown[] } }).message.items.slice(0, MAX_PAPERS_PER_SOURCE) : [];
  if (rows.length === 0) throw new Error("Crossref response has no items");
  const papers: Paper[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as { DOI?: unknown; title?: unknown; abstract?: unknown; subject?: unknown };
    const doi = typeof item.DOI === "string" ? item.DOI.trim().toLowerCase() : "";
    const title = Array.isArray(item.title) && typeof item.title[0] === "string" ? clean(item.title[0], 512) : "";
    if (!DOI_PATTERN.test(doi) || !title) continue;
    papers.push({ url: `https://doi.org/${doi}`, source: "crossref", title, abstract: typeof item.abstract === "string" ? clean(item.abstract) : undefined, categories: Array.isArray(item.subject) ? item.subject.filter((v): v is string => typeof v === "string").map((v) => clean(v, 64)) : [], doi });
  }
  if (papers.length === 0) throw new Error("Crossref rows are malformed");
  return papers;
}

async function read(url: string, fetchImpl: typeof fetch): Promise<{ body: string; truncated: boolean }> {
  assertAllowedResourceReadUrl(url);
  const response = await fetchImpl(url, { headers: { accept: "application/atom+xml, application/rss+xml, application/json" }, redirect: "manual" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  return { body: body.slice(0, MAX_BODY_BYTES), truncated: body.length > MAX_BODY_BYTES };
}

async function source(name: SubSource, url: string, parser: (body: string) => Paper[], fetchImpl: typeof fetch): Promise<SubSourceResult> {
  try {
    const result = await read(url, fetchImpl);
    if (result.truncated) return { papers: [], requests: 1, unavailable: `${name}-truncated`, truncated: true };
    return { papers: parser(result.body), requests: 1 };
  } catch (error) {
    return { papers: [], requests: 1, unavailable: name, ...(error instanceof Error ? { error: error.message } : {}) } as SubSourceResult;
  }
}

function paperInput(paper: Paper): ExternalResourceInput {
  const labels = ["paper", "academic", paper.source, ...paper.categories.map((category) => category === "cs.CR" || category === "cryptography" ? "cryptography" : category.toLowerCase().replace(/[^a-z0-9]+/g, "-"))]
    .filter((label) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label) && label.length <= 20);
  return {
    family: "url", value: canonicalPaperUrl(paper), source: PAPERS_SOURCE_ID, labels: [], title: paper.title, description: paper.abstract,
    bodyText: paper.abstract, tagHints: labels, metadata: { subSource: paper.source, ...(paper.doi ? { doi: paper.doi } : {}) },
    taxonomy: { type: ["research"], subject: labels },
    scoreComponents: { authority: 8, durability: 8, freshness: 0, origin_engagement: 0, cost_penalty: 0, pubky_signal: 0 },
  };
}

export async function discoverPapers(options: PapersDiscoverOptions): Promise<ResourceRun> {
  if (options.limit > PAPERS_REQUEST_BUDGET) throw new Error("papers limit exceeds request budget");
  const contact = options.contactEmail?.trim();
  if (!contact) throw new Error("JEB_CONTACT_EMAIL is required for Crossref");
  const fetchImpl = options.fetchImpl ?? fetch;
  const arxiv = await source("arxiv", ARXIV_URL, parseArxivAtom, fetchImpl);
  await (options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(1_000);
  const iacr = await source("iacr-eprint", IACR_URL, parseIacrRss, fetchImpl);
  const crossrefUrl = `https://api.crossref.org/works?query.bibliographic=bitcoin&mailto=${encodeURIComponent(contact)}`;
  const crossref = await source("crossref", crossrefUrl, parseCrossrefJson, fetchImpl);
  const results = [arxiv, iacr, crossref];
  const unavailable = results.flatMap((result) => result.unavailable ? [result.unavailable] : []);
  const inputs = results.flatMap((result) => result.papers).map(paperInput);
  const deduped = new Map<string, ExternalResourceInput>();
  for (const input of inputs) deduped.set(input.value, input);
  const run = discoverResources([...deduped.values()], { category: "pubky", limit: options.limit, configVersion: options.configVersion ?? RESOURCE_CONFIG_VERSION });
  run.shadowReport.poolSize = inputs.length;
  run.shadowReport.rejectionHistogram = run.rejected.reduce<Record<string, number>>((out, item) => ({ ...out, [item.reason]: (out[item.reason] ?? 0) + 1 }), {});
  if (unavailable.length > 0) run.shadowReport.halt = { reason: unavailable.includes("arxiv-truncated") || unavailable.includes("iacr-eprint-truncated") || unavailable.includes("crossref-truncated") ? unavailable.filter((reason) => reason.endsWith("-truncated")).join(",") : "source-unavailable", subSources: unavailable };
  return run;
}
