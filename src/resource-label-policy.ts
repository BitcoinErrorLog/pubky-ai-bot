export const RESOURCE_LABEL_POLICY_VERSION = "resource-label-policy-v3";

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
  // Directory verdict codes and category headers, not search terms.
  "nosendreceive",
  "nosource",
  "people",
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

export function isAllowedResourceLabel(label: string): boolean {
  return !DENIED_RESOURCE_LABELS.has(label);
}
