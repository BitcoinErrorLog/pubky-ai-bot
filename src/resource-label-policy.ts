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
  if (/^akia[0-9a-z]{16}$/.test(label)) return "secret-shape";
  if (/^[0-9a-f]{32,}$/.test(label)) return "secret-shape";
  if (/^0x[0-9a-f]{16,}$/.test(label)) return "secret-shape";
  if (/^[a-z0-9+/=_-]{24,}$/.test(label) && !/[aeiou]/.test(label)) return "secret-shape";
  return null;
}

export function isAllowedResourceLabel(label: string): boolean {
  return !DENIED_RESOURCE_LABELS.has(label) && resourceLabelRejectReason(label) === null;
}
