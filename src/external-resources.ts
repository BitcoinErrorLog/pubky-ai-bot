import type { Config } from "./config.js";
import { assertStagingHomeserverPk } from "./outbound-gate.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import { classifyResource, RESOURCE_LABELS_PER_RESOURCE_MAX } from "./resource-classify.js";
import {
  canonicalizeGeocoordinate,
  canonicalizeStableIdentifier,
  flattenTaxonomy,
  mergeTaxonomy,
  sourceDefinition,
  validateTaxonomy,
  type ResourceFamily as RegistryResourceFamily,
  type Taxonomy,
} from "./resource-taxonomy.js";
import { httpUrlRejectReason } from "./resource-url-safety.js";
import { isAllowedResourceLabel } from "./resource-label-policy.js";
import { isValidOpenTagLabel } from "./bot-kit/tags/policy.js";

export { normalizeUri, resourceIdentity } from "./resource-identity.js";

/** Hard maximum records accepted in one resource run; publish caps derive from this. */
export const RESOURCE_RECORD_MAX = 100;
export const RESOURCE_INPUT_MAX_BYTES = 1_048_576;
export const RESOURCE_FAMILIES = ["url", "geocoordinate", "stable-identifier"] as const satisfies readonly RegistryResourceFamily[];
export type ResourceFamily = (typeof RESOURCE_FAMILIES)[number];

export const RESOURCE_CATEGORIES = ["pubky", "bitcoin", "lightning", "music", "news", "software", "nostr"] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number] | (string & {});

const URL_LABELS = new Set(["documentation", "project", "release", "support"]);
const LANGUAGE_LABELS = new Map<string, string>([
  ["es", "spanish"], ["de", "german"], ["pt", "portuguese"], ["fr", "french"], ["ja", "japanese"],
  ["zh", "chinese"], ["ru", "russian"], ["it", "italian"], ["nl", "dutch"], ["pl", "polish"],
  ["tr", "turkish"], ["ko", "korean"], ["ar", "arabic"], ["he", "hebrew"], ["sv", "swedish"],
]);
const LOW_CONFIDENCE_DESCRIPTION_LABELS = new Set(["node", "research"]);

export function sanitizeResourceText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F\r]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
}

export interface ExternalResourceInput {
  family: ResourceFamily;
  value: string;
  category?: ResourceCategory;
  labels: string[];
  source: string;
  sourcePriority?: number;
  title?: string;
  description?: string;
  bodyText?: string;
  site_name?: string;
  observedAt?: string;
  publishedAt?: string;
  freshnessWindowMs?: number;
  language?: string;
  authors?: string[];
  taxonomy?: Partial<Taxonomy>;
  identifierType?: string;
  pool?: string;
  existingTags?: string[];
  linkedUrl?: string;
  tagHints?: string[];
  placeProvenance?: {
    attribution: string;
    lat: number;
    lon: number;
    city?: string;
    country?: string;
    osmVersion?: number;
    updatedAt?: string;
    verifiedAt?: string;
  };
  metadata?: Record<string, unknown>;
  scoreComponents?: Record<string, number>;
  attribution?: string;
}

export interface ResourceProvenance {
  source: string;
  configVersion: string;
  decision: "accepted" | "rejected";
  timestamp: string;
  truncatedFields?: readonly string[];
  subjectMatches?: { id: string; score: number; fields: readonly string[] }[];
  labelProvenance?: Record<string, string>;
  taggedAt?: string;
  pool?: string;
  existingTags?: string[];
  linkedUrl?: string;
  place?: ExternalResourceInput["placeProvenance"];
  scoreComponents?: Record<string, number>;
  attribution?: string;
}

export interface ExternalResource {
  family: ResourceFamily;
  category: ResourceCategory;
  displayValue: string;
  canonicalValue: string;
  identity: string;
  labels: string[];
  taxonomy: Taxonomy;
  rules: string[];
  score: number;
  title?: string;
  description?: string;
  bodyText?: string;
  site_name?: string;
  language?: string;
  authors?: string[];
  tagHints?: string[];
  sourcePriority: number;
  provenance: ResourceProvenance;
  metadata?: Record<string, unknown>;
}

export interface ResourceRejection {
  input: ExternalResourceInput;
  reason: string;
  provenance: ResourceProvenance;
}

export interface ResourceRun {
  mode: "shadow" | "publish" | "reconcile";
  category: ResourceCategory;
  limit: number;
  accepted: ExternalResource[];
  rejected: ResourceRejection[];
  shadowReport: {
    bySource: Record<string, number>;
    byFamily: Record<string, number>;
    byTag: Record<string, number>;
    byRejectionReason: Record<string, number>;
    bySubSource?: Record<string, number>;
    byRule: Record<string, number>;
    labelsPerResource: Record<string, number>;
    topSubjects: Record<string, number>;
    halt?: { reason: string };
    poolSize?: number;
    unknownCountryRatio?: number;
    rejectionHistogram?: Record<string, number>;
    areaRequests?: number;
  };
}

export interface ResourcePublisher {
  publish(resource: ExternalResource): Promise<{ identity: string; published: boolean }>;
}

export function rankResourceLabels(buckets: {
  domain: readonly string[];
  entities: readonly string[];
  subjects: readonly string[];
  form: readonly string[];
}): string[] {
  return [...new Set([
    ...buckets.domain,
    ...buckets.entities,
    ...buckets.subjects,
    ...buckets.form,
  ])]
    .filter(isAllowedResourceLabel)
    .filter(isValidOpenTagLabel)
    .slice(0, RESOURCE_LABELS_PER_RESOURCE_MAX);
}

/**
 * Process-local shadow idempotency only. Durable idempotency requires a real
 * publisher to reserve deterministic storage paths before publishing.
 */
export class IdempotentResourcePublisher implements ResourcePublisher {
  private readonly published = new Set<string>();
  private readonly inFlight = new Map<string, Promise<{ identity: string; published: boolean }>>();

  constructor(private readonly delegate: ResourcePublisher) {}

  async publish(resource: ExternalResource): Promise<{ identity: string; published: boolean }> {
    if (this.published.has(resource.identity)) return { identity: resource.identity, published: false };
    const current = this.inFlight.get(resource.identity);
    if (current) return current;
    const operation = this.delegate.publish(resource).then((result) => {
      if (result.published) this.published.add(resource.identity);
      return result;
    }).finally(() => {
      this.inFlight.delete(resource.identity);
    });
    this.inFlight.set(resource.identity, operation);
    return operation;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[invalid URL]";
  }
}

function safeInput(input: ExternalResourceInput): ExternalResourceInput {
  return input.family === "url" ? { ...input, value: redactUrl(input.value) } : { ...input };
}

function safeUnknownInput(input: unknown): ExternalResourceInput {
  if (!isRecord(input)) return { family: "url", value: "", source: "unknown", labels: [] };
  const family = typeof input.family === "string" ? input.family as ResourceFamily : "url";
  const value = typeof input.value === "string" ? (family === "url" ? redactUrl(input.value) : input.value) : "";
  return {
    family,
    value,
    source: typeof input.source === "string" ? input.source : "unknown",
    labels: Array.isArray(input.labels) ? input.labels.filter((label): label is string => typeof label === "string") : [],
  };
}

function validateInput(input: unknown): input is ExternalResourceInput {
  if (!isRecord(input)) return false;
  if (typeof input.family !== "string" || typeof input.value !== "string" || typeof input.source !== "string") return false;
  if (!Array.isArray(input.labels) || input.labels.some((label) => typeof label !== "string")) return false;
  if (input.title !== undefined && typeof input.title !== "string") return false;
  if (input.description !== undefined && typeof input.description !== "string") return false;
  if (input.bodyText !== undefined && typeof input.bodyText !== "string") return false;
  if (input.site_name !== undefined && typeof input.site_name !== "string") return false;
  if (input.observedAt !== undefined && typeof input.observedAt !== "string") return false;
  if (input.publishedAt !== undefined && typeof input.publishedAt !== "string") return false;
  if (input.freshnessWindowMs !== undefined && (typeof input.freshnessWindowMs !== "number" || !Number.isFinite(input.freshnessWindowMs))) return false;
  if (input.language !== undefined && typeof input.language !== "string") return false;
  if (input.authors !== undefined && (!Array.isArray(input.authors) || input.authors.some((author) => typeof author !== "string"))) return false;
  if (input.identifierType !== undefined && typeof input.identifierType !== "string") return false;
  if (input.tagHints !== undefined && (!Array.isArray(input.tagHints) || input.tagHints.some((hint) => typeof hint !== "string"))) return false;
  if (input.placeProvenance !== undefined && !isRecord(input.placeProvenance)) return false;
  if (input.taxonomy !== undefined && (!isRecord(input.taxonomy) || Object.values(input.taxonomy).some((value) => !Array.isArray(value) || value.some((tag) => typeof tag !== "string")))) return false;
  if (input.sourcePriority !== undefined && (typeof input.sourcePriority !== "number" || !Number.isFinite(input.sourcePriority))) return false;
  if (input.category !== undefined && typeof input.category !== "string") return false;
  if (input.metadata !== undefined && (!isRecord(input.metadata) || Object.values(input.metadata).some((value) => typeof value === "function" || typeof value === "symbol"))) return false;
  if (input.scoreComponents !== undefined && (!isRecord(input.scoreComponents) || Object.values(input.scoreComponents).some((value) => typeof value !== "number" || !Number.isFinite(value)))) return false;
  return true;
}

function boundMatchedFields(input: ExternalResourceInput): string[] {
  for (const field of ["title", "description", "site_name"] as const) {
    if (input[field] !== undefined) input[field] = sanitizeResourceText(input[field]!);
  }
  if (input.tagHints) input.tagHints = input.tagHints.map(sanitizeResourceText);
  const truncatedFields: string[] = [];
  const bounds = [
    ["title", 512],
    ["description", 4096],
    ["site_name", 256],
  ] as const;
  for (const [field, limit] of bounds) {
    const value = input[field];
    if (value !== undefined && value.length > limit) {
      input[field] = value.slice(0, limit);
      truncatedFields.push(field);
    }
  }
  return truncatedFields;
}

function provenance(
  input: ExternalResourceInput,
  configVersion: string,
  decision: ResourceProvenance["decision"],
  timestamp: string,
  truncatedFields: readonly string[],
  extra: Pick<ResourceProvenance, "subjectMatches"> = {},
): ResourceProvenance {
  return {
    source: input.source,
    configVersion,
    decision,
    timestamp,
    ...(truncatedFields.length > 0 ? { truncatedFields } : {}),
    ...extra,
    ...(input.pool ? { pool: input.pool } : {}),
    ...(input.existingTags ? { existingTags: input.existingTags } : {}),
    ...(input.linkedUrl ? { linkedUrl: input.linkedUrl } : {}),
    ...(input.scoreComponents ? { scoreComponents: input.scoreComponents } : {}),
    ...(input.attribution ? { attribution: input.attribution } : {}),
  };
}

function rejectReason(
  input: ExternalResourceInput,
  category: ResourceCategory,
  normalizedValue: string,
  taxonomy: Taxonomy,
  nowMs: number,
  disabledSources: ReadonlySet<string>,
  disabledFamilies: ReadonlySet<string>,
): string | null {
  if (!RESOURCE_FAMILIES.includes(input.family)) return "unsupported resource family";
  if (disabledFamilies.has(input.family)) return "resource family disabled";
  const source = sourceDefinition(input.source);
  if (!source) return "unregistered source";
  if (!source.enabled || disabledSources.has(source.id)) return "source disabled";
  if (!source.families.includes(input.family)) return "resource family is not enabled in the staging URL slice";
  if (category !== "pubky") return "unsupported category";
  if (input.category !== undefined && input.category !== category) return "category conflict";
  if (!input.source.trim()) return "source is required";
  if ((input.sourcePriority ?? 0) < 0) return "invalid source priority";
  if (input.observedAt !== undefined || input.publishedAt !== undefined) {
    const observedMs = Date.parse(input.publishedAt ?? input.observedAt ?? "");
    if (!Number.isFinite(observedMs)) return input.source === "pubky-posts" ? "invalid timestamp" : "invalid observation timestamp";
    if (input.source === "pubky-posts") {
      if (observedMs > nowMs) return "future timestamp";
      if (nowMs - observedMs > (input.freshnessWindowMs ?? source.freshnessWindowMs)) return "stale timestamp";
    } else if (nowMs - observedMs > source.freshnessWindowMs || observedMs > nowMs) return "stale or future resource";
  }
  const taxonomyReason = validateTaxonomy(taxonomy);
  if (taxonomyReason) return taxonomyReason;
  if (input.family === "url") {
    if (input.source !== "pubky-ecosystem" && input.labels.some((label) => !URL_LABELS.has(label) && isAllowedResourceLabel(label))) return "invalid URL taxonomy label";
  } else if (input.family === "geocoordinate") {
    if (normalizedValue === "0,0" || normalizedValue === "geo:0,0") return "low-value geocoordinate";
  } else {
    if (!normalizedValue) return "empty stable identifier";
  }
  return null;
}

export function canonicalizeUrl(raw: string): string {
  return normalizeUri(raw);
}

export function validateResourceLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > RESOURCE_RECORD_MAX) {
    throw new Error(`resource limit must be an integer from 1 to ${RESOURCE_RECORD_MAX}`);
  }
  return limit;
}

export function discoverResources(
  inputs: readonly ExternalResourceInput[],
  opts: {
    category?: ResourceCategory;
    limit: number;
    configVersion: string;
    now?: Date;
    disabledSources?: readonly string[];
    disabledFamilies?: readonly ResourceFamily[];
  },
): ResourceRun {
  if (inputs.length > RESOURCE_RECORD_MAX) {
    throw new Error(`resource input batch must contain no more than ${RESOURCE_RECORD_MAX} records`);
  }
  const requestedCategory = opts.category ?? "pubky";
  const limit = validateResourceLimit(opts.limit);
  const nowDate = opts.now ?? new Date();
  const now = nowDate.toISOString();
  const nowMs = nowDate.getTime();
  const accepted: ExternalResource[] = [];
  const rejected: ResourceRejection[] = [];
  const shadowReport = {
    bySource: Object.create(null) as Record<string, number>,
    byFamily: Object.create(null) as Record<string, number>,
    byTag: Object.create(null) as Record<string, number>,
    byRejectionReason: Object.create(null) as Record<string, number>,
    byRule: Object.create(null) as Record<string, number>,
    labelsPerResource: Object.create(null) as Record<string, number>,
    topSubjects: Object.create(null) as Record<string, number>,
  };
  const count = (record: Record<string, number>, key: string) => {
    record[key] = (record[key] ?? 0) + 1;
  };
  const seen = new Set<string>();
  const sorted = [...inputs].sort(
    (a, b) => {
      const aRecord: Record<string, unknown> = isRecord(a) ? a : {};
      const bRecord: Record<string, unknown> = isRecord(b) ? b : {};
      const aPriority = typeof aRecord.sourcePriority === "number" ? aRecord.sourcePriority : 0;
      const bPriority = typeof bRecord.sourcePriority === "number" ? bRecord.sourcePriority : 0;
      const aSource = typeof aRecord.source === "string" ? aRecord.source : "";
      const bSource = typeof bRecord.source === "string" ? bRecord.source : "";
      const aValue = typeof aRecord.value === "string" ? aRecord.value : "";
      const bValue = typeof bRecord.value === "string" ? bRecord.value : "";
      return bPriority - aPriority || aSource.localeCompare(bSource) || aValue.localeCompare(bValue);
    },
  );
  for (const input of sorted) {
    if (accepted.length >= limit) break;
    if (!validateInput(input)) {
      rejected.push({
        input: safeUnknownInput(input),
        reason: "invalid resource record",
        provenance: {
          source: safeUnknownInput(input).source,
          configVersion: opts.configVersion,
          decision: "rejected",
          timestamp: now,
        },
      });
      count(shadowReport.byRejectionReason, "invalid resource record");
      continue;
    }
    input.labels = input.labels.map(sanitizeResourceText);
    const truncatedFields = boundMatchedFields(input);
    let normalizedValue: string;
    try {
      normalizedValue =
        input.family === "url"
          ? canonicalizeUrl(input.value)
          : input.family === "geocoordinate"
            ? canonicalizeGeocoordinate(input.value)
            : canonicalizeStableIdentifier(input.value, input.identifierType);
    } catch {
      const reason = input.family === "url" ? "invalid URL" : `invalid ${input.family}`;
      rejected.push({ input: safeInput(input), reason, provenance: provenance(input, opts.configVersion, "rejected", now, truncatedFields) });
      count(shadowReport.byRejectionReason, reason);
      continue;
    }
    const urlSafetyReason = httpUrlRejectReason(normalizedValue, input.value, { treatAsUrl: input.family === "url" });
    if (urlSafetyReason) {
      rejected.push({
        input: safeInput(input),
        reason: urlSafetyReason,
        provenance: provenance(input, opts.configVersion, "rejected", now, truncatedFields),
      });
      count(shadowReport.byRejectionReason, urlSafetyReason);
      continue;
    }
    const source = sourceDefinition(input.source);
    const classification =
      input.family === "url" && input.source !== "btcmap-places"
        ? classifyResource(input, source)
        : { taxonomy: { domain: [], type: [], subject: [], geography: [] }, rules: [], score: 0, matched: true, subjectMatches: [], entityMatches: [], computedLabels: [] };
    const mergedTaxonomy = mergeTaxonomy(input.taxonomy, input.value, input.family);
    const taxonomy: Taxonomy = {
      ...mergedTaxonomy,
      domain: [...new Set([...mergedTaxonomy.domain, ...classification.taxonomy.domain])].filter(isAllowedResourceLabel),
      type: [...new Set([...mergedTaxonomy.type, ...classification.taxonomy.type])].filter(isAllowedResourceLabel),
      subject: [...new Set([...mergedTaxonomy.subject, ...classification.taxonomy.subject])].filter(isAllowedResourceLabel),
      geography: [...new Set([...mergedTaxonomy.geography, ...classification.taxonomy.geography])].filter(isAllowedResourceLabel),
    };
    const domainLabels = [...new Set(classification.taxonomy.domain)];
    const entityLabels = classification.entityMatches
      .filter((entity) => entity.kind === "person" || entity.kind === "project" || entity.kind === "org" || entity.kind === "product")
      .map((entity) => entity.id);
    const subjectLabels = [...classification.subjectMatches]
      .filter((match) => match.score >= 1 || !LOW_CONFIDENCE_DESCRIPTION_LABELS.has(match.id))
      .sort((a, b) => b.score - a.score)
      .map((match) => match.id);
    const formLabels = [...new Set([
      ...classification.taxonomy.type,
      ...classification.taxonomy.subject,
      ...classification.taxonomy.geography,
    ])];
    const inputLabels = input.family === "url" ? (source?.allowOperatorLabels ? input.labels : []) : input.labels;
    const docsRule = classification.rules.some((rule) => rule === "docs.host" || rule === "docs.path" || rule === "developer.bitcoin.org") ||
      (input.family === "url" && /^\/docs(?:\/|$)/i.test(new URL(input.value).pathname));
    const languageCode = input.language?.toLowerCase();
    const languageLabel = languageCode && languageCode !== "en" ? LANGUAGE_LABELS.get(languageCode) : undefined;
    const languageLabels = languageLabel
      ? [languageLabel]
      : [];
    // Ranking is intentional: rule domain topics, named entities, scored subjects,
    // then form/source labels. The denylist runs before the cap so filler cannot
    // consume a useful slot.
    const allowDocumentation = input.family !== "url" || docsRule;
    const finalLabels = rankResourceLabels({
      domain: domainLabels,
      entities: entityLabels,
      subjects: subjectLabels,
      form: [...classification.computedLabels, ...languageLabels, ...formLabels, ...inputLabels]
        .filter((label) => allowDocumentation || label !== "documentation"),
    });
    taxonomy.subject = [...new Set([...taxonomy.subject, ...subjectLabels])];
    const baseReason = rejectReason(input, requestedCategory, normalizedValue, taxonomy, nowMs, new Set(opts.disabledSources ?? []), new Set(opts.disabledFamilies ?? []));
    const reason =
      baseReason ??
      (input.family === "url" && !classification.matched
        ? classification.rejectionReason ??
          (classification.taxonomy.domain.includes("music")
          ? "music host has no recognisable type"
          : source?.unmatched === "reject"
            ? "no taxonomy match"
            : null)
        : null) ??
      (finalLabels.length === 0 && input.source !== "pubky-posts" && (input.tagHints?.length ?? 0) === 0 ? "no publishable labels" : null);
    for (const rule of classification.rules) count(shadowReport.byRule, rule);
    if (reason) {
      rejected.push({ input: safeInput(input), reason, provenance: provenance(input, opts.configVersion, "rejected", now, truncatedFields) });
      count(shadowReport.byRejectionReason, reason);
      continue;
    }
    const identity = resourceIdentity(normalizedValue);
    if (seen.has(identity)) {
      rejected.push({ input: safeInput(input), reason: "duplicate canonical identity", provenance: provenance(input, opts.configVersion, "rejected", now, truncatedFields) });
      count(shadowReport.byRejectionReason, "duplicate canonical identity");
      continue;
    }
    seen.add(identity);
    const sourcePriority = source?.priority ?? input.sourcePriority ?? 0;
    const completeness = (input.title?.trim() ? 10 : 0) + (flattenTaxonomy(taxonomy).length > 0 ? 10 : 0);
    const freshness = input.observedAt ? 20 : 10;
    const genericHomepagePenalty = classification.taxonomy.domain.includes("news") && normalizedValue.endsWith("/") ? 20 : 0;
    const score = sourcePriority + completeness + freshness + classification.score - genericHomepagePenalty;
    if (score < 20) {
      rejected.push({ input: safeInput(input), reason: "low-value resource", provenance: provenance(input, opts.configVersion, "rejected", now, truncatedFields) });
      count(shadowReport.byRejectionReason, "low-value resource");
      continue;
    }
    count(shadowReport.bySource, input.source);
    count(shadowReport.byFamily, input.family);
    count(shadowReport.labelsPerResource, String(finalLabels.length));
    for (const subjectMatch of classification.subjectMatches) count(shadowReport.topSubjects, subjectMatch.id);
    for (const tag of flattenTaxonomy(taxonomy)) count(shadowReport.byTag, tag);
    const outputCategory = classification.category ?? (taxonomy.domain[0] as ResourceCategory | undefined) ?? requestedCategory;
    accepted.push({
      family: input.family,
      category: outputCategory,
      displayValue: input.family === "url" ? redactUrl(input.value) : input.value,
      canonicalValue: normalizedValue,
      identity,
      labels: finalLabels,
      taxonomy,
      rules: classification.rules,
      score,
      title: input.title?.trim() || undefined,
      description: input.description?.trim() || undefined,
      bodyText: input.bodyText,
      site_name: input.site_name?.trim() || undefined,
      language: input.language?.trim() || undefined,
      authors: input.authors,
      tagHints: input.tagHints,
      sourcePriority: sourcePriority,
      provenance: provenance(input, opts.configVersion, "accepted", now, truncatedFields, { subjectMatches: classification.subjectMatches }),
      metadata: input.metadata,
    });
  }
  return { mode: "shadow", category: requestedCategory, limit, accepted, rejected, shadowReport };
}

export function assertStagingResourceConfig(
  cfg: Pick<Config, "resourceTarget" | "resourceMode" | "resourceMaxRecords"> & { homeserverPk?: string },
): void {
  if (cfg.resourceTarget !== "staging") {
    throw new Error("external-resource seeding is staging-only");
  }
  if (cfg.resourceMode !== "shadow" && cfg.resourceMode !== "publish" && cfg.resourceMode !== "reconcile") {
    throw new Error("invalid JEB_RESOURCE_MODE");
  }
  validateResourceLimit(cfg.resourceMaxRecords);
    if (cfg.resourceMode === "publish" || cfg.resourceMode === "reconcile") {
    assertStagingHomeserverPk(cfg.homeserverPk ?? "");
  }
}
