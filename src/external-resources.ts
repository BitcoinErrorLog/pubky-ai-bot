import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Config } from "./config.js";

export const RESOURCE_RECORD_MAX = 100;
export const RESOURCE_INPUT_MAX_BYTES = 1_048_576;
export const RESOURCE_FAMILIES = ["url", "geocoordinate", "stable-identifier"] as const;
export type ResourceFamily = (typeof RESOURCE_FAMILIES)[number];

export const RESOURCE_CATEGORIES = ["pubky"] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

const URL_LABELS = new Set(["documentation", "project", "release", "support"]);
const TRACKING_QUERY_KEYS = new Set(["utm_campaign", "utm_content", "utm_medium", "utm_source", "utm_term"]);
const QUERY_KEY_ALLOWLIST = new Set([
  "b",
  "filter",
  "lang",
  "locale",
  "page",
  "q",
  "ref",
  "sort",
  "tab",
  "v",
  "view",
]);
const CREDENTIAL_QUERY_TOKENS = new Set([
  "access_key",
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "auth_token",
  "authorization",
  "bearer",
  "client_secret",
  "credential",
  "id_token",
  "jwt",
  "key",
  "password",
  "passwd",
  "private_key",
  "refresh_token",
  "secret",
  "session",
  "sig",
  "signature",
  "token",
]);
const CREDENTIAL_QUERY_PATTERN = /(token|secret|passwd|password|credential|bearer|signature|auth)/;

export interface ExternalResourceInput {
  family: ResourceFamily;
  value: string;
  category?: ResourceCategory;
  labels: string[];
  source: string;
  sourcePriority?: number;
  title?: string;
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
  value: string;
  canonicalValue: string;
  identity: string;
  labels: string[];
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
  mode: "shadow";
  category: ResourceCategory;
  limit: number;
  accepted: ExternalResource[];
  rejected: ResourceRejection[];
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

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map((part) => Number(part));
  if (a === 0 || a === 10 || a === 127 || a === 255) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isPrivateIPv6(ip: string): boolean {
  const host = stripIpv6Brackets(ip).toLowerCase();
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("fe80:")) return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    return isIP(mapped) === 4 ? isPrivateIPv4(mapped) : true;
  }
  return false;
}

function isBlockedCatalogHost(hostname: string): boolean {
  const host = stripIpv6Brackets(hostname.toLowerCase().replace(/\.+$/, ""));
  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain") return true;
  const kind = isIP(host);
  if (kind === 4) return isPrivateIPv4(host);
  if (kind === 6) return isPrivateIPv6(host);
  if (host.includes(":")) return true;
  return false;
}

function normalizeQueryKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-.]/g, "_");
}

function isCredentialQueryKey(key: string): boolean {
  const normalized = normalizeQueryKey(key);
  if (!normalized) return false;
  if (QUERY_KEY_ALLOWLIST.has(normalized)) return false;
  if (CREDENTIAL_QUERY_TOKENS.has(normalized)) return true;
  const parts = normalized.split("_").filter(Boolean);
  if (parts.some((part) => CREDENTIAL_QUERY_TOKENS.has(part))) return true;
  return CREDENTIAL_QUERY_PATTERN.test(normalized);
}

function hasCredentialQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (isCredentialQueryKey(key)) return true;
  }
  return false;
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
  if (input.sourcePriority !== undefined && (typeof input.sourcePriority !== "number" || !Number.isFinite(input.sourcePriority))) return false;
  if (input.category !== undefined && typeof input.category !== "string") return false;
  return true;
}

function rejectReason(input: ExternalResourceInput, category: ResourceCategory, canonicalValue: string): string | null {
  if (!RESOURCE_FAMILIES.includes(input.family)) return "unsupported resource family";
  if (category !== "pubky") return "unsupported category";
  if (input.category !== undefined && input.category !== category) return "category conflict";
  if (!input.source.trim()) return "source is required";
  if ((input.sourcePriority ?? 0) < 0) return "invalid source priority";
  if (input.family === "url") {
    let original: URL;
    try {
      original = new URL(input.value.trim());
    } catch {
      return "invalid URL";
    }
    if (original.username || original.password) return "URL credentials are not allowed";
    if (hasCredentialQuery(original)) return "URL credentials are not allowed";
    const url = new URL(canonicalValue);
    if (url.protocol !== "https:") return "unsafe URL protocol";
    if (url.username || url.password) return "URL credentials are not allowed";
    if (hasCredentialQuery(url)) return "URL credentials are not allowed";
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (hostname === "pubky.app" || hostname.endsWith(".pubky.app") || hostname === "nexus.pubky.app" || hostname.endsWith(".nexus.pubky.app")) {
      return "production target is not allowed";
    }
    if (isBlockedCatalogHost(url.hostname)) return "private or loopback host is not allowed";
    if (url.hostname.length < 3 || !url.hostname.includes(".")) return "low-value URL host";
    if (url.pathname === "/") return "low-value URL";
    if (input.labels.some((label) => !URL_LABELS.has(label))) return "invalid URL taxonomy label";
  } else {
    return "resource family is not enabled in the staging URL slice";
  }
  return null;
}

/**
 * Identity and displayed `canonicalValue` use the same string: scheme, host,
 * path, and surviving (non-tracking) query pairs, with userinfo and hash
 * removed. Distinct allowed queries are distinct resources. Raw `value` on
 * accepted/rejected records still strips query and userinfo so operator
 * output never echoes credentials or unreviewed query text.
 */
export function canonicalizeUrl(raw: string): string {
  const url = new URL(raw.trim());
  url.username = "";
  url.password = "";
  url.protocol = url.protocol.toLowerCase();
  url.hostname = stripIpv6Brackets(url.hostname.toLowerCase().replace(/\.+$/, ""));
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  url.hash = "";
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_QUERY_KEYS.has(key.toLowerCase()))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  url.search = "";
  for (const [key, value] of params) url.searchParams.append(key, value);
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

export function resourceIdentity(family: ResourceFamily, canonicalValue: string): string {
  return `${family}:${createHash("sha256").update(canonicalValue).digest("hex")}`;
}

export function validateResourceLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > RESOURCE_RECORD_MAX) {
    throw new Error(`resource limit must be an integer from 1 to ${RESOURCE_RECORD_MAX}`);
  }
  return limit;
}

export function discoverResources(
  inputs: readonly ExternalResourceInput[],
  opts: { category?: ResourceCategory; limit: number; configVersion: string; now?: Date },
): ResourceRun {
  if (inputs.length > RESOURCE_RECORD_MAX) {
    throw new Error(`resource input batch must contain no more than ${RESOURCE_RECORD_MAX} records`);
  }
  const category = opts.category ?? "pubky";
  const limit = validateResourceLimit(opts.limit);
  const now = (opts.now ?? new Date()).toISOString();
  const accepted: ExternalResource[] = [];
  const rejected: ResourceRejection[] = [];
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
      continue;
    }
    let canonicalValue: string;
    try {
      canonicalValue = input.family === "url" ? canonicalizeUrl(input.value) : input.value.trim();
    } catch {
      rejected.push({ input: safeInput(input), reason: "invalid URL", provenance: { source: input.source, configVersion: opts.configVersion, decision: "rejected", timestamp: now } });
      continue;
    }
    const reason = rejectReason(input, category, canonicalValue);
    if (reason) {
      rejected.push({ input: safeInput(input), reason, provenance: { source: input.source, configVersion: opts.configVersion, decision: "rejected", timestamp: now } });
      continue;
    }
    const identity = resourceIdentity(input.family, canonicalValue);
    if (seen.has(identity)) {
      rejected.push({ input: safeInput(input), reason: "duplicate canonical identity", provenance: { source: input.source, configVersion: opts.configVersion, decision: "rejected", timestamp: now } });
      continue;
    }
    seen.add(identity);
    accepted.push({
      family: input.family,
      category,
      value: input.family === "url" ? redactUrl(input.value) : input.value,
      canonicalValue,
      identity,
      labels: [...input.labels].sort(),
      title: input.title?.trim() || undefined,
      sourcePriority: input.sourcePriority ?? 0,
      provenance: { source: input.source, configVersion: opts.configVersion, decision: "accepted", timestamp: now },
    });
  }
  return { mode: "shadow", category, limit, accepted, rejected };
}

export function assertStagingResourceConfig(cfg: Pick<Config, "resourceTarget" | "resourceMode" | "resourceMaxRecords">): void {
  if (cfg.resourceTarget !== "staging" || cfg.resourceMode !== "shadow") {
    throw new Error("external-resource seeding is staging-only and shadow-only");
  }
  validateResourceLimit(cfg.resourceMaxRecords);
}

