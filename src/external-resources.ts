import type { Config } from "./config.js";
import { assertStagingHomeserverPk } from "./outbound-gate.js";
import { normalizeUri, resourceIdentity } from "./resource-identity.js";
import { classifyResource, RESOURCE_LABEL_CAP } from "./resource-classify.js";
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

export { normalizeUri, resourceIdentity } from "./resource-identity.js";

export const RESOURCE_RECORD_MAX = 100;
export const RESOURCE_INPUT_MAX_BYTES = 1_048_576;
export const RESOURCE_FAMILIES = ["url", "geocoordinate", "stable-identifier"] as const satisfies readonly RegistryResourceFamily[];
export type ResourceFamily = (typeof RESOURCE_FAMILIES)[number];

export const RESOURCE_CATEGORIES = ["pubky", "bitcoin", "lightning", "music", "news", "software", "nostr"] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number] | (string & {});

const URL_LABELS = new Set(["documentation", "project", "release", "support"]);

export interface ExternalResourceInput {
  family: ResourceFamily;
  value: string;
  category?: ResourceCategory;
  labels: string[];
  source: string;
  sourcePriority?: number;
  title?: string;
  observedAt?: string;
  taxonomy?: Partial<Taxonomy>;
  identifierType?: string;
}

export interface ResourceProvenance {
  source: string;
  configVersion: string;
  decision: "accepted" | "rejected";
  timestamp: string;
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
  sourcePriority: number;
  provenance: ResourceProvenance;
}

export interface ResourceRejection {
  input: ExternalResourceInput;
  reason: string;
  provenance: ResourceProvenance;
}

export interface ResourceRun {
  mode: "shadow" | "publish";
  category: ResourceCategory;
  limit: number;
  accepted: ExternalResource[];
  rejected: ResourceRejection[];
  shadowReport: {
    bySource: Record<string, number>;
    byFamily: Record<string, number>;
    byTag: Record<string, number>;
    byRejectionReason: Record<string, number>;
    byRule: Record<string, number>;
  };
}

export interface ResourcePublisher {
  publish(resource: ExternalResource): Promise<{ identity: string; published: boolean }>;
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
  if (input.observedAt !== undefined && typeof input.observedAt !== "string") return false;
  if (input.identifierType !== undefined && typeof input.identifierType !== "string") return false;
  if (input.taxonomy !== undefined && (!isRecord(input.taxonomy) || Object.values(input.taxonomy).some((value) => !Array.isArray(value) || value.some((tag) => typeof tag !== "string")))) return false;
  if (input.sourcePriority !== undefined && (typeof input.sourcePriority !== "number" || !Number.isFinite(input.sourcePriority))) return false;
  if (input.category !== undefined && typeof input.category !== "string") return false;
  return true;
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
  if (input.observedAt !== undefined) {
    const observedMs = Date.parse(input.observedAt);
    if (!Number.isFinite(observedMs)) return "invalid observation timestamp";
    if (nowMs - observedMs > source.freshnessWindowMs || observedMs > nowMs) return "stale or future resource";
  }
  const taxonomyReason = validateTaxonomy(taxonomy);
  if (taxonomyReason) return taxonomyReason;
  if (input.family === "url") {
    if (input.labels.some((label) => !URL_LABELS.has(label))) return "invalid URL taxonomy label";
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
    bySource: {} as Record<string, number>,
    byFamily: {} as Record<string, number>,
    byTag: {} as Record<string, number>,
    byRejectionReason: {} as Record<string, number>,
    byRule: {} as Record<string, number>,
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
        provenance: { source: safeUnknownInput(input).source, configVersion: opts.configVersion, decision: "rejected", timestamp: now },
      });
      count(shadowReport.byRejectionReason, "invalid resource record");
      continue;
    }
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
      rejected.push({ input: safeInput(input), reason, provenance: { source: input.source, configVersion: opts.configVersion, decision: "rejected", timestamp: now } });
      count(shadowReport.byRejectionReason, reason);
      continue;
    }
    const urlSafetyReason = httpUrlRejectReason(normalizedValue, input.value, { treatAsUrl: input.family === "url" });
    if (urlSafetyReason) {
      rejected.push({
        input: safeInput(input),
        reason: urlSafetyReason,
        provenance: { source: input.source, configVersion: opts.configVersion, decision: "rejected", timestamp: now },
      });
      count(shadowReport.byRejectionReason, urlSafetyReason);
      continue;
    }
    const source = sourceDefinition(input.source);
    const classification =
      input.family === "url"
        ? classifyResource(input, source)
        : { taxonomy: { domain: [], type: [], subject: [], geography: [] }, rules: [], score: 0, matched: true };
    const mergedTaxonomy = mergeTaxonomy(input.taxonomy, input.value, input.family);
    const taxonomy: Taxonomy = {
      ...mergedTaxonomy,
      domain: [...new Set([...mergedTaxonomy.domain, ...classification.taxonomy.domain])],
      type: [...new Set([...mergedTaxonomy.type, ...classification.taxonomy.type])],
      subject: [...new Set([...mergedTaxonomy.subject, ...classification.taxonomy.subject])],
      geography: [...new Set([...mergedTaxonomy.geography, ...classification.taxonomy.geography])],
    };
    const outputLabels = [...new Set([...classification.taxonomy.domain, ...classification.taxonomy.type, ...classification.taxonomy.subject, ...classification.taxonomy.geography])]
      .slice(0, RESOURCE_LABEL_CAP);
    const inputLabels = input.family === "url" ? (source?.allowOperatorLabels ? input.labels : []) : input.labels;
    const finalLabels = [...new Set([...outputLabels, ...inputLabels])].slice(0, RESOURCE_LABEL_CAP).sort();
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
      (finalLabels.length === 0 ? "no publishable labels" : null);
    for (const rule of classification.rules) count(shadowReport.byRule, rule);
    if (reason) {
      rejected.push({ input: safeInput(input), reason, provenance: { source: input.source, configVersion: opts.configVersion, decision: "rejected", timestamp: now } });
      count(shadowReport.byRejectionReason, reason);
      continue;
    }
    const identity = resourceIdentity(normalizedValue);
    if (seen.has(identity)) {
      rejected.push({ input: safeInput(input), reason: "duplicate canonical identity", provenance: { source: input.source, configVersion: opts.configVersion, decision: "rejected", timestamp: now } });
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
      rejected.push({ input: safeInput(input), reason: "low-value resource", provenance: { source: input.source, configVersion: opts.configVersion, decision: "rejected", timestamp: now } });
      count(shadowReport.byRejectionReason, "low-value resource");
      continue;
    }
    count(shadowReport.bySource, input.source);
    count(shadowReport.byFamily, input.family);
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
      sourcePriority: sourcePriority,
      provenance: { source: input.source, configVersion: opts.configVersion, decision: "accepted", timestamp: now },
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
  if (cfg.resourceMode !== "shadow" && cfg.resourceMode !== "publish") {
    throw new Error("invalid JEB_RESOURCE_MODE");
  }
  validateResourceLimit(cfg.resourceMaxRecords);
    if (cfg.resourceMode === "publish") {
    assertStagingHomeserverPk(cfg.homeserverPk ?? "");
  }
}
