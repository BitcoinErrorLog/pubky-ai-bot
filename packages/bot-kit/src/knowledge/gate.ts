import path from "node:path";
import { log } from "../log.js";

export type RefusalRule = string;

export interface GateResult {
  ok: boolean;
  rule?: RefusalRule;
}

export interface PathPatternRule {
  re: RegExp;
  rule: RefusalRule;
  /** Match against basename only (default: full normalized path). */
  basename?: boolean;
}

export interface ContentPatternRule {
  re: RegExp;
  rule: RefusalRule;
}

export interface GateRules {
  pathPatterns: PathPatternRule[];
  contentPatterns: ContentPatternRule[];
}

export const EMPTY_GATE_RULES: GateRules = {
  pathPatterns: [],
  contentPatterns: [],
};

export function refusePath(filePath: string, confidentiality?: string, rules: GateRules = EMPTY_GATE_RULES): GateResult {
  const norm = filePath.replaceAll("\\", "/");
  if (confidentiality === "excluded") return { ok: false, rule: "confidentiality-excluded" };
  const base = path.basename(norm);
  for (const { re, rule, basename } of rules.pathPatterns) {
    if (basename ? re.test(base) : re.test(norm)) return { ok: false, rule };
  }
  return { ok: true };
}

export function refuseContent(text: string, rules: GateRules = EMPTY_GATE_RULES): GateResult {
  for (const { re, rule } of rules.contentPatterns) {
    if (re.test(text)) return { ok: false, rule };
  }
  return { ok: true };
}

export function evaluateGate(
  filePath: string,
  content: string | null,
  confidentiality?: string,
  rules: GateRules = EMPTY_GATE_RULES,
): GateResult {
  const byPath = refusePath(filePath, confidentiality, rules);
  if (!byPath.ok) return byPath;
  if (content !== null) return refuseContent(content, rules);
  return { ok: true };
}

export function logRefusal(filePath: string, rule: RefusalRule): void {
  log.info({ path: filePath, rule }, "knowledge ingest refused");
}

export type EvaluateGate = (
  filePath: string,
  content: string | null,
  confidentiality?: string,
) => GateResult;
