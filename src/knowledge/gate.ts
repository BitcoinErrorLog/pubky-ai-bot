import path from "node:path";
import { log } from "../log.js";

export type RefusalRule =
  | "annual-reports"
  | "cursor-plans"
  | "internal-strategy-document"
  | "confidential-marker"
  | "budget-marker"
  | "filename-plan"
  | "filename-master-plan"
  | "filename-claim-chart"
  | "filename-review-packet"
  | "filename-source-notes"
  | "filename-prior-art"
  | "blog-draft"
  | "confidentiality-excluded";

export interface GateResult {
  ok: boolean;
  rule?: RefusalRule;
}

const NAME_RULES: Array<{ re: RegExp; rule: RefusalRule }> = [
  { re: /blog-draft/i, rule: "blog-draft" },
  { re: /master-plan/i, rule: "filename-master-plan" },
  { re: /claim-chart/i, rule: "filename-claim-chart" },
  { re: /review-packet/i, rule: "filename-review-packet" },
  { re: /source-notes/i, rule: "filename-source-notes" },
  { re: /prior-art/i, rule: "filename-prior-art" },
  { re: /plan/i, rule: "filename-plan" },
];

export function refusePath(filePath: string, confidentiality?: string): GateResult {
  const norm = filePath.replaceAll("\\", "/");
  if (confidentiality === "excluded") return { ok: false, rule: "confidentiality-excluded" };
  if (/\/annual reports\//i.test(norm) || /\/annual-reports\//i.test(norm)) {
    return { ok: false, rule: "annual-reports" };
  }
  if (norm.includes("/.cursor/plans/") || norm.endsWith("/.cursor/plans")) {
    return { ok: false, rule: "cursor-plans" };
  }
  const base = path.basename(norm);
  for (const { re, rule } of NAME_RULES) {
    if (re.test(base)) return { ok: false, rule };
  }
  return { ok: true };
}

export function refuseContent(text: string): GateResult {
  if (/type:\s*["']internal strategy document["']/i.test(text)) {
    return { ok: false, rule: "internal-strategy-document" };
  }
  if (/\bCONFIDENTIAL\b/.test(text)) return { ok: false, rule: "confidential-marker" };
  if (/Synonym 2026 Budget/.test(text)) return { ok: false, rule: "budget-marker" };
  return { ok: true };
}

export function evaluateGate(filePath: string, content: string | null, confidentiality?: string): GateResult {
  const byPath = refusePath(filePath, confidentiality);
  if (!byPath.ok) return byPath;
  if (content !== null) return refuseContent(content);
  return { ok: true };
}

export function logRefusal(filePath: string, rule: RefusalRule): void {
  log.info({ path: filePath, rule }, "knowledge ingest refused");
}
