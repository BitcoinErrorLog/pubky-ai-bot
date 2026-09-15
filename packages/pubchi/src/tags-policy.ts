import { InjectionDetector, normalizeForMatching } from "../bot-kit/security/injection-detector.js";
import { isValidTagLabel, rejectOpenTagReason } from "../bot-kit/tags/policy.js";
import { isDeniedPersonTag, isDeniedSlurTag, isPubkyIdTag } from "../bot-kit/tags/denylist.js";

export type TaintedField = {
  value: string;
  source_uri: string;
  field_path: string;
  tainted: boolean;
};

export type C5RejectCode =
  | "tainted"
  | "pubky"
  | "person"
  | "slur"
  | "word_count"
  | "invalid_label"
  | "secret"
  | "evidence"
  | "duplicate";

export type C5Candidate = {
  raw: string;
  evidence: TaintedField[];
  rationale?: TaintedField;
  already_applied?: boolean;
};

export type C5PolicyResult =
  | { accepted: true; label: string; evidence: string[]; already_applied: boolean }
  | { accepted: false; code: C5RejectCode };

export function taintField(value: unknown, source_uri: string, field_path: string): TaintedField {
  const text = typeof value === "string" ? value : "";
  return { value: text, source_uri, field_path, tainted: new InjectionDetector().detect(text).detected };
}

export function evaluateC5Candidate(
  candidate: C5Candidate,
  personTokens: readonly string[],
  seenLabels: ReadonlySet<string>,
): C5PolicyResult {
  const raw = candidate.raw;
  const skeleton = normalizeForMatching(raw);
  if (
    candidate.evidence.some((field) => field.tainted) ||
    candidate.rationale?.tainted ||
    new InjectionDetector().detect(raw).detected ||
    new InjectionDetector().detect(skeleton.replace(/-/g, " ")).detected
  ) {
    return { accepted: false, code: "tainted" };
  }
  const compact = skeleton.replace(/\s/g, "");
  if (
    isPubkyIdTag(raw) ||
    /^[a-z0-9]{52}$/.test(compact) ||
    (compact.length >= 8 && personTokens.some((token) => /^[a-z0-9]{52}$/.test(token) && token.startsWith(compact)))
  ) {
    return { accepted: false, code: "pubky" };
  }
  // Product policy intentionally over-rejects ambiguous short names such as "alice".
  const normalizedPeople = personTokens.map(normalizeForMatching).filter(Boolean);
  if (
    normalizedPeople.some((token) => skeleton === token || skeleton === `@${token}`) ||
    isDeniedPersonTag(raw, personTokens)
  ) {
    return { accepted: false, code: "person" };
  }
  if (isDeniedSlurTag(skeleton.replace(/\s+/g, "-"))) return { accepted: false, code: "slur" };
  if (
    skeleton.split(/\s+/u).filter(Boolean).length > 3 ||
    raw.split("-").length > 3 ||
    raw.split(/[\u00AD\u180E\u200B-\u200D\u2060\uFEFF]+/u).filter(Boolean).length > 3
  ) {
    return { accepted: false, code: "word_count" };
  }
  const label = raw.trim();
  if (!isValidTagLabel(label)) return { accepted: false, code: "invalid_label" };
  const legacy = rejectOpenTagReason(label, { personTokens });
  if (legacy === "secret-scrubber") return { accepted: false, code: "secret" };
  const evidence = [...new Set(candidate.evidence.filter((field) => !field.tainted).map((field) => field.source_uri))];
  if (evidence.length < 1 || evidence.length > 8 || evidence.some((uri) => !/^pubky:\/\/[a-z0-9]{52}\//.test(uri))) {
    return { accepted: false, code: "evidence" };
  }
  if (seenLabels.has(label)) return { accepted: false, code: "duplicate" };
  return { accepted: true, label, evidence: [...new Set(evidence)], already_applied: Boolean(candidate.already_applied) };
}
