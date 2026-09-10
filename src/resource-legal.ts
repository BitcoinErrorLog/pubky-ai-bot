import { fetchResourceText } from "./resource-fetch.js";
import { lookup } from "node:dns/promises";
import { assertAllowedResourceReadUrl } from "./outbound-gate.js";
import { discoverResources, type ExternalResourceInput, type ResourceRun } from "./external-resources.js";
import { RESOURCE_CONFIG_VERSION } from "./resource-taxonomy.js";

export const LEGAL_SOURCE_ID = "legal";
export const FEDERAL_REGISTER_API_URL = "https://www.federalregister.gov/api/v1/documents.json";
export const EDGAR_SEARCH_API_URL = "https://efts.sec.gov/LATEST/search-index";
export const LEGAL_REQUEST_BUDGET = 100;
export const LEGAL_MAX_BODY_BYTES = 512 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ELEMENTS = 10_000;
const FEDERAL_DOCUMENT_PATH = /^\/documents\/(\d{4})\/(\d{2})\/(\d{2})\/([A-Za-z0-9][A-Za-z0-9-]{0,63})\/([a-z0-9][a-z0-9-]{0,159})\/?$/;
const DOCUMENT_NUMBER = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const CIK = /^\d{1,10}$/;
const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const FILE_NAME = /^[A-Za-z0-9._-]{1,120}$/;
const FORM_TYPE = /^[0-9a-z-]{1,12}$/;
const AGENCY_LABELS: Record<string, string> = {
  sec: "sec",
  treasury: "treasury",
  irs: "irs",
  fincen: "fincen",
  cftc: "cftc",
  "federal reserve": "federal-reserve",
  occ: "occ",
  fdic: "fdic",
};

export type LegalSubSource = "federal-register" | "edgar";
export type LegalRejection = { subSource: LegalSubSource; reason: string; value?: string };

export type LegalDiscoveryOptions = {
  limit: number;
  configVersion?: string;
  now?: Date;
  contactEmail?: string;
  fetchImpl?: typeof fetch;
  dnsLookup?: typeof lookup;
  sleep?: (ms: number) => Promise<void>;
  cacheDir?: string;
  maxRequests?: number;
  federalFixture?: unknown;
  edgarFixture?: unknown;
  parseJson?: (body: string) => unknown;
};

type LegalDiscoveryResult = ResourceRun & {
  legalRejections: LegalRejection[];
  legalSubSources: { federalRegister: number; edgar: number };
};

class LegalRequestBudgetExceeded extends Error {
  constructor() {
    super("request-budget-exhausted");
    this.name = "ResourceRequestBudgetExceeded";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedJson(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_JSON_DEPTH) return false;
    if (typeof current.value === "number" && !Number.isFinite(current.value)) return false;
    if (current.value === null || typeof current.value !== "object") continue;
    count += 1;
    if (count > MAX_JSON_ELEMENTS) return false;
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    } else {
      for (const [key, item] of Object.entries(current.value)) {
        if (key.length > 512) return false;
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

function text(value: unknown, max = 4_096): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "").trim();
  return clean ? clean.slice(0, max) : undefined;
}

function agencyLabels(agencies: unknown): string[] {
  if (!Array.isArray(agencies)) return [];
  return [...new Set(agencies.flatMap((agency) => {
    const name = isRecord(agency) ? text(agency.name, 200)?.toLowerCase() : undefined;
    if (!name) return [];
    const match = Object.entries(AGENCY_LABELS).find(([key]) => name === key || name.includes(key));
    return match ? [match[1]] : [];
  }))];
}

function federalCanonical(value: unknown, documentNumber: unknown): string | null {
  const raw = typeof value === "string" && value.length <= 512 ? value : undefined;
  const number = typeof documentNumber === "string" && documentNumber.length <= 64 ? documentNumber.toUpperCase() : undefined;
  if (!raw || !number || !DOCUMENT_NUMBER.test(number)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "www.federalregister.gov" || url.search || url.hash) return null;
  const match = FEDERAL_DOCUMENT_PATH.exec(url.pathname);
  if (!match || match[4]!.toUpperCase() !== number) return null;
  return `https://www.federalregister.gov${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;
}

function federalInput(row: Record<string, unknown>): ExternalResourceInput | LegalRejection {
  const canonical = federalCanonical(row.html_url, row.document_number);
  if (!canonical) return { subSource: "federal-register", reason: "invalid-canonical-url", value: text(row.html_url) };
  const kind = text(row.type, 64);
  const labels = ["jurisdiction:us", "federal-register"];
  const taxonomyType =
    kind === "Rule" ? "regulation" :
      kind === "Proposed Rule" ? "proposed-rule" :
        kind === "Notice" ? "notice" :
          kind === "Presidential Document" ? "presidential-document" :
            undefined;
  if (!taxonomyType) return { subSource: "federal-register", reason: "unknown-document-type", value: canonical };
  if (kind === "Presidential Document") labels.push("executive-order", "presidential-document");
  else labels.push(taxonomyType);
  labels.push(...agencyLabels(row.agencies));
  const title = text(row.title, 512);
  const description = text(row.abstract, 4_096);
  const publishedAt = text(row.publication_date, 64);
  return {
    family: "url",
    value: canonical,
    source: LEGAL_SOURCE_ID,
    labels,
    title,
    description,
    observedAt: publishedAt,
    publishedAt,
    taxonomy: { domain: ["legal"], type: [taxonomyType], geography: ["jurisdiction:us"] },
    metadata: { subSource: "federal-register", documentNumber: text(row.document_number, 64), kind, agencies: row.agencies },
    scoreComponents: { authority: 5, durability: 5, origin_engagement: 0, freshness: 1, cost_penalty: 0, pubky_signal: 0 },
    sourcePriority: 115,
  };
}

function edgarCanonical(id: unknown, source: Record<string, unknown>): { url: string; cik: string; accession: string; file: string } | LegalRejection {
  const rawId = typeof id === "string" && id.length <= 256 ? id : undefined;
  const parts = rawId?.split(":");
  const accession = parts?.[0];
  const file = parts?.slice(1).join(":");
  const ciks = Array.isArray(source.ciks) ? source.ciks : [];
  const cik = typeof ciks[0] === "string" && ciks[0].length <= 16 ? ciks[0] : undefined;
  if (!cik || !CIK.test(cik)) return { subSource: "edgar", reason: "invalid-cik", value: cik };
  if (!accession || !ACCESSION.test(accession)) return { subSource: "edgar", reason: "invalid-accession", value: accession };
  if (!file || !FILE_NAME.test(file) || file.includes("..") || file.includes("/") || file.includes("%2e")) {
    return { subSource: "edgar", reason: "invalid-file-name", value: file };
  }
  return { url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replaceAll("-", "")}/${file}`, cik, accession, file };
}

function edgarInput(hit: unknown): ExternalResourceInput | LegalRejection {
  if (!isRecord(hit) || !isRecord(hit._source)) return { subSource: "edgar", reason: "invalid-hit" };
  const source = hit._source;
  const canonical = edgarCanonical(hit._id, source);
  if ("reason" in canonical) return canonical;
  const rawForm = source.form_type ?? source.form;
  const rawFormValue = Array.isArray(rawForm) ? rawForm[0] : rawForm;
  const form = typeof rawFormValue === "string" && rawFormValue.length <= 32 ? rawFormValue.toLowerCase() : undefined;
  if (!form || !FORM_TYPE.test(form)) return { subSource: "edgar", reason: "invalid-form-type", value: form };
  const names = Array.isArray(source.display_names) ? source.display_names.filter((item): item is string => typeof item === "string").map((item) => text(item, 512)).filter((item): item is string => Boolean(item)) : [];
  const labels = ["jurisdiction:us", "sec-filing", form];
  const haystack = `${form} ${names.join(" ")}`.toLowerCase();
  if (/(administrative proceeding|litigation release|enforcement action|enforcement proceeding)/.test(haystack)) labels.push("enforcement-action");
  const date = text(source.file_date, 64);
  return {
    family: "url",
    value: canonical.url,
    source: LEGAL_SOURCE_ID,
    labels,
    title: names[0] ?? `${form} SEC filing`,
    description: `${form} filing dated ${date ?? "unknown"}`,
    observedAt: date,
    publishedAt: date,
    taxonomy: { domain: ["legal"], type: ["filing"], geography: ["jurisdiction:us"] },
    metadata: { subSource: "edgar", cik: canonical.cik, accession: canonical.accession, file: canonical.file, formType: form, displayNames: names },
    scoreComponents: { authority: 5, durability: 4, origin_engagement: 0, freshness: 1, cost_penalty: 0, pubky_signal: 0 },
    sourcePriority: 114,
  };
}

function hasDuplicateJsonKeys(textBody: string): boolean {
  const objects: Array<Set<string> | null> = [];
  let index = 0;
  while (index < textBody.length) {
    const char = textBody[index]!;
    if (char === "\"") {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < textBody.length) {
        const current = textBody[index++]!;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === "\"") break;
      }
      const token = textBody.slice(start, index);
      let cursor = index;
      while (/\s/.test(textBody[cursor] ?? "")) cursor += 1;
      if (textBody[cursor] === ":" && objects.at(-1) instanceof Set) {
        const key = JSON.parse(token) as string;
        const current = objects.at(-1)! as Set<string>;
        if (current.has(key)) return true;
        current.add(key);
      }
      continue;
    }
    if (char === "{") objects.push(new Set<string>());
    else if (char === "[") objects.push(null);
    else if (char === "}" || char === "]") objects.pop();
    index += 1;
  }
  return false;
}

export function parseLegalJson(textBody: string): unknown {
  if (hasDuplicateJsonKeys(textBody)) throw new Error("duplicate-json-key");
  let parsed: unknown;
  try {
    parsed = JSON.parse(textBody) as unknown;
  } catch {
    throw new Error("invalid-json");
  }
  if (!boundedJson(parsed)) throw new Error("json-bounds-exceeded");
  return parsed;
}

function responseRows(value: unknown, subSource: LegalSubSource): unknown[] {
  if (!isRecord(value)) throw new Error(`${subSource}-shape-invalid`);
  if (subSource === "federal-register" && Array.isArray(value.results)) {
    if (value.results.length === 0) throw new Error(`${subSource}-empty`);
    return value.results;
  }
  if (subSource === "edgar" && isRecord(value.hits) && Array.isArray(value.hits.hits)) {
    if (value.hits.hits.length === 0) throw new Error(`${subSource}-empty`);
    return value.hits.hits;
  }
  throw new Error(`${subSource}-shape-invalid`);
}

function uniqueInputs(inputs: ExternalResourceInput[]): ExternalResourceInput[] {
  const seen = new Set<string>();
  return inputs.filter((input) => {
    if (seen.has(input.value)) return false;
    seen.add(input.value);
    return true;
  });
}

export async function discoverLegalResources(options: LegalDiscoveryOptions): Promise<LegalDiscoveryResult> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error("resource limit must be an integer from 1 to 100");
  const maxRequests = options.maxRequests ?? LEGAL_REQUEST_BUDGET;
  let requests = 0;
  const rejections: LegalRejection[] = [];
  const unavailable: Array<{ id: LegalSubSource; reason: string }> = [];
  const fetchJson = async (url: string, headers?: Record<string, string>): Promise<unknown> => {
    assertAllowedResourceReadUrl(url);
    const result = await fetchResourceText(url, {
      rawBody: true,
      acceptJson: true,
      maxBodyBytes: LEGAL_MAX_BODY_BYTES,
      rawBodyMaxChars: LEGAL_MAX_BODY_BYTES,
      cacheNamespace: "legal",
      cacheDir: options.cacheDir,
      fetchImpl: options.fetchImpl,
      dnsLookup: options.dnsLookup,
      headers,
      assertAllowedUrl: assertAllowedResourceReadUrl,
      onRequest: () => {
        requests += 1;
        if (requests > maxRequests || requests > LEGAL_REQUEST_BUDGET) throw new LegalRequestBudgetExceeded();
      },
      log: () => {},
    });
    if (!result.ok) throw new Error(result.reason === "too_large" ? "truncated" : result.reason);
    if (result.truncated) throw new Error("truncated");
    if (result.text.trim().length === 0) throw new Error("empty-body");
    return options.parseJson ? options.parseJson(result.text) : parseLegalJson(result.text);
  };
  const federal: ExternalResourceInput[] = [];
  const edgar: ExternalResourceInput[] = [];
  try {
    let page: unknown = options.federalFixture;
    let nextUrl: string | undefined;
    do {
      if (page === undefined) {
        const url = nextUrl ? new URL(nextUrl) : new URL(FEDERAL_REGISTER_API_URL);
        if (!nextUrl) {
          url.searchParams.set("conditions[term]", "bitcoin");
          url.searchParams.set("per_page", "100");
          url.searchParams.set("order", "newest");
        }
        page = await fetchJson(url.toString());
      }
      for (const row of responseRows(page, "federal-register")) {
        const parsed = isRecord(row) ? federalInput(row) : { subSource: "federal-register" as const, reason: "invalid-record" };
        if ("reason" in parsed) rejections.push(parsed);
        else federal.push(parsed);
      }
      const candidate = isRecord(page) ? page.next_page_url : undefined;
      nextUrl = typeof candidate === "string" && candidate.length < 512 ? candidate : undefined;
      if (nextUrl) assertAllowedResourceReadUrl(nextUrl);
      if (options.federalFixture !== undefined) nextUrl = undefined;
      page = undefined;
    } while (nextUrl && federal.length < options.limit * 2);
  } catch (error) {
    unavailable.push({ id: "federal-register", reason: error instanceof LegalRequestBudgetExceeded ? "request-budget-exhausted" : error instanceof Error ? error.message : "unavailable" });
  }
  if (!options.contactEmail?.trim()) {
    unavailable.push({ id: "edgar", reason: "contact-missing" });
  } else {
    try {
      await options.sleep?.(150);
      const edgarUrl = new URL(EDGAR_SEARCH_API_URL);
      edgarUrl.searchParams.set("q", "bitcoin");
      edgarUrl.searchParams.set("forms", "8-K,10-K,10-Q,S-1,424B,N-1A");
      const page = options.edgarFixture ?? await fetchJson(edgarUrl.toString(), { "user-agent": `Jeb/1.1.0 (${options.contactEmail.trim()})` });
      for (const hit of responseRows(page, "edgar")) {
        const parsed = edgarInput(hit);
        if ("reason" in parsed) rejections.push(parsed);
        else edgar.push(parsed);
      }
    } catch (error) {
      unavailable.push({ id: "edgar", reason: error instanceof LegalRequestBudgetExceeded ? "request-budget-exhausted" : error instanceof Error ? error.message : "unavailable" });
    }
  }
  const inputs = [];
  for (let index = 0; index < Math.max(federal.length, edgar.length) && inputs.length < options.limit; index += 1) {
    if (federal[index]) inputs.push(federal[index]!);
    if (edgar[index] && inputs.length < options.limit) inputs.push(edgar[index]!);
  }
  const run = discoverResources(uniqueInputs(inputs), {
    category: "pubky",
    limit: options.limit,
    configVersion: options.configVersion ?? RESOURCE_CONFIG_VERSION,
    now: options.now,
  });
  run.shadowReport.requests = requests;
  run.shadowReport.unavailableSources = unavailable;
  run.shadowReport.halt = unavailable.length
    ? { reason: unavailable.some((item) => item.reason === "request-budget-exhausted") ? "request-budget-exhausted" : "source-unavailable" }
    : null;
  return {
    ...run,
    legalRejections: rejections,
    legalSubSources: { federalRegister: federal.length, edgar: edgar.length },
  };
}
