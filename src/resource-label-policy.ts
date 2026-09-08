export const RESOURCE_LABEL_POLICY_VERSION = "resource-label-policy-v1";

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
]);

export function isAllowedResourceLabel(label: string): boolean {
  return !DENIED_RESOURCE_LABELS.has(label);
}
