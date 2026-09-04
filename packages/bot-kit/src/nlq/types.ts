import type { AllowedTool, Intent } from "./intent.js";

export type NlqTimeRange = { since?: number; until?: number };
export type NlqGraphScope = { pubky?: string; hops?: number };

export type NlqScope = {
  time_range?: NlqTimeRange;
  graph_scope?: NlqGraphScope;
};

export type NlqRequest = {
  question: string;
  asker?: string;
  scope?: NlqScope;
};

export type NlqOutcome =
  | "ok"
  | "schema_unavailable"
  | "schema_unsupported"
  | "budget_exhausted"
  | "circuit_open"
  | "guard_rejected"
  | "tool_error"
  | "declined"
  | "ignored"
  | "unsupported";

export type NlqPlannedCall = {
  tool: AllowedTool;
  args: Record<string, unknown>;
};

export type NlqResult = {
  outcome: NlqOutcome;
  reason: string;
  intent: Intent;
  planned: NlqPlannedCall[];
  results: unknown[];
  toolTrace: unknown[];
  sources: string[];
};

export function nlqResult(partial: Omit<NlqResult, "planned" | "results" | "toolTrace" | "sources"> & Partial<NlqResult>): NlqResult {
  return {
    planned: [],
    results: [],
    toolTrace: [],
    sources: [],
    ...partial,
  };
}
