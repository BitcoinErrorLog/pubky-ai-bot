import { getValidationLimits } from "pubky-app-specs";
import { scanForSecrets } from "../security/secret-scrub.js";
import { isDeniedPersonTag, isDeniedSlurTag, isPubkyIdTag } from "./denylist.js";

/** Operator style cap. Homeserver spec is stricter (`tagLabelMaxLength`, currently 20). */
export const TAG_STYLE_MAX_CHARS = 32;
export const TAG_MAX_HYPHEN_WORDS = 3;
export const MAX_OPEN_TAGS = 5;

/** Sentinel `approved_by` for artifact tags on posts Jeb already answered. SQL CHECK still requires nonempty. */
export const AUTO_ARTIFACT_APPROVER = "jeb-answered";

export function tagLabelMaxChars(): number {
  const limits = getValidationLimits() as { tagLabelMaxLength?: number };
  const spec = typeof limits.tagLabelMaxLength === "number" && limits.tagLabelMaxLength > 0 ? limits.tagLabelMaxLength : 20;
  return Math.min(TAG_STYLE_MAX_CHARS, spec);
}

/**
 * Open-vocabulary style: lowercase, `[a-z0-9-]`, at most 3 hyphenated words,
 * length capped by style (32) and pubky-app-specs `tagLabelMaxLength`.
 */
export function isValidOpenTagLabel(label: string): boolean {
  const max = tagLabelMaxChars();
  if (label.length < 1 || label.length > max) return false;
  if (label !== label.toLowerCase()) return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label)) return false;
  if (label.split("-").length > TAG_MAX_HYPHEN_WORDS) return false;
  if (label.startsWith("-") || label.endsWith("-") || label.includes("--")) return false;
  return true;
}

/** Spec-compatible alias used at PUT boundaries. */
export function isValidTagLabel(label: string): boolean {
  return isValidOpenTagLabel(label);
}

export type TagPolicyReject =
  | "style"
  | "denylist-slur"
  | "denylist-person"
  | "denylist-pubky"
  | "secret-scrubber";

export function rejectOpenTagReason(
  label: string,
  opts?: { personTokens?: readonly string[]; incrementSecurityEvent?: (rule: string) => void },
): TagPolicyReject | null {
  if (!isValidOpenTagLabel(label)) return "style";
  if (isPubkyIdTag(label)) return "denylist-pubky";
  if (isDeniedSlurTag(label)) return "denylist-slur";
  if (isDeniedPersonTag(label, opts?.personTokens ?? [])) return "denylist-person";
  const scan = scanForSecrets(label);
  if (!scan.clean) {
    for (const hit of scan.hits) opts?.incrementSecurityEvent?.(hit.rule);
    return "secret-scrubber";
  }
  return null;
}

/** Caller-side increment; skip `secret-scrubber` because rejectOpenTagReason already counted the hits. */
export function recordOpenTagDenial(denied: TagPolicyReject, increment: (rule: string) => void): void {
  if (denied === "secret-scrubber") return;
  increment(denied);
}

export function filterOpenTags(
  labels: readonly string[],
  opts?: { personTokens?: readonly string[]; incrementSecurityEvent?: (rule: string) => void; max?: number },
): string[] {
  const max = opts?.max ?? MAX_OPEN_TAGS;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    const label = raw.trim().toLowerCase();
    if (!label || seen.has(label)) continue;
    if (rejectOpenTagReason(label, opts)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Prefer an existing Nexus tag when it is the same string or a hyphen/underscore
 * variant of a proposed label. Model still chooses; this only remaps exact aliases.
 */
export function preferExistingTags(proposed: readonly string[], existing: readonly string[]): string[] {
  const index = new Map<string, string>();
  for (const e of existing) {
    const n = e.trim().toLowerCase();
    if (!n) continue;
    index.set(n, n);
    index.set(n.replace(/_/g, "-"), n);
    index.set(n.replace(/-/g, ""), n);
  }
  return proposed.map((p) => {
    const n = p.trim().toLowerCase();
    return index.get(n) ?? index.get(n.replace(/_/g, "-")) ?? index.get(n.replace(/-/g, "")) ?? n;
  });
}

export function isAutoArtifactApprover(approvedBy: string): boolean {
  return approvedBy.trim() === AUTO_ARTIFACT_APPROVER;
}
