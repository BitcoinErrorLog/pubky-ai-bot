import type { GateRules, RefusalRule } from "../bot-kit/knowledge/gate.js";

export type JebRefusalRule =
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

export const JEB_GATE_RULES: GateRules = {
  pathPatterns: [
    { re: /\/annual reports\//i, rule: "annual-reports" satisfies RefusalRule },
    { re: /\/annual-reports\//i, rule: "annual-reports" },
    { re: /\/\.cursor\/plans(?:\/|$)/, rule: "cursor-plans" },
    { re: /blog-draft/i, rule: "blog-draft", basename: true },
    { re: /master-plan/i, rule: "filename-master-plan", basename: true },
    { re: /claim-chart/i, rule: "filename-claim-chart", basename: true },
    { re: /review-packet/i, rule: "filename-review-packet", basename: true },
    { re: /source-notes/i, rule: "filename-source-notes", basename: true },
    { re: /prior-art/i, rule: "filename-prior-art", basename: true },
    { re: /plan/i, rule: "filename-plan", basename: true },
  ],
  contentPatterns: [
    { re: /type:\s*["']internal strategy document["']/i, rule: "internal-strategy-document" },
    { re: /\bCONFIDENTIAL\b/i, rule: "confidential-marker" },
    { re: /Synonym 2026 Budget/i, rule: "budget-marker" },
  ],
};
