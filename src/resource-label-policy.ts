export const RESOURCE_LABEL_POLICY_VERSION = "resource-label-policy-v2";

export const DENIED_RESOURCE_LABELS = new Set([
  "documentation",
  "general-tech",
  "homepage",
  "tool",
  "protocol",
  "company",
  "article",
  "software",
  "web",
  "general",
  "misc",
  "other",
  "page",
  "link",
  "resource",
  "shared-link",
  "x-post",
  "video-link",
  "post",
  "repost",
  "shared",
  "openstreetmap",
  "btcmap",
  "btc-map",
  "osm",
  "constructor",
  "prototype",
  "__proto__",
  "hasownproperty",
  "tostring",
  "valueof",
]);

export function resourceLabelRejectReason(label: string): string | null {
  const normalized = label.toLowerCase();
  const compact = normalized.replace(/[-_.]/g, "");
  if (
    (normalized.startsWith("sk_live_") || normalized.startsWith("sk_test_") ||
      normalized.startsWith("ghp_") || normalized.startsWith("gho_") ||
      /^xox[abp]-/.test(normalized)) && compact.length >= 12
  ) return "secret-shape";
  if (/^(?:eyj|aiza|akia)/.test(compact) && compact.length >= 16) return "secret-shape";
  if (/^[0-9a-f]{24,}$/.test(compact)) return "secret-shape";
  if (/^0x[0-9a-f]{12,}$/.test(compact)) return "secret-shape";
  if (/^[a-z0-9+/=]{24,}$/.test(compact) && !/[aeiou]/.test(compact)) return "secret-shape";
  return null;
}

export function isAllowedResourceLabel(label: string): boolean {
  const normalized = label.toLowerCase();
  return !DENIED_RESOURCE_LABELS.has(normalized) && resourceLabelRejectReason(normalized) === null;
}
