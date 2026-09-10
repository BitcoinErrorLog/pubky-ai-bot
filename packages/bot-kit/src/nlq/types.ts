import type { AllowedTool, Intent } from "./intent.js";
import type { ExecutionScope } from "./plan-port.js";

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
  pubchiMode?: boolean;
  now_ms?: number;
  ownerContext?: string;
  conversationWindow?: string;
};

export type NlqOutcome =
  | "ok"
  | "schema_unavailable"
  | "schema_unsupported"
  | "budget_exhausted"
  | "circuit_open"
  | "switch_off"
  | "guard_rejected"
  | "tool_error"
  | "declined"
  | "ignored"
    | "unsupported"
    | "unauthorized";

export type NlqPlannedCall = {
  tool: AllowedTool;
  args: Record<string, unknown>;
};

export type NlqPlanKind = "template" | "cypher" | "chain" | "answer" | "feed" | "invalid" | "none";

export type NlqResult = {
  outcome: NlqOutcome;
  reason: string;
  intent: Intent;
  planned: NlqPlannedCall[];
  results: unknown[];
  toolTrace: unknown[];
  sources: string[];
  answer?: string;
  brainTokens?: number;
  /** Conversational plan kind actually dispatched, when the planner ran. */
  planKind?: NlqPlanKind;
  /** Scope derived from executed tool parameters, not from the model's plan. */
  scope?: ExecutionScope;
  /** Service copy that must replace the generated summary verbatim. */
  message?: string;
  /** Feed draft returned by the conversational feed-plan executor. */
  feed?: unknown;
  /** Chain step that failed, when the execution is partial. */
  failedStep?: string;
  /** Per-attempt planner diagnostics without question or plan text. */
  plannerOutcomes?: Array<{
    attempt: number;
    parse: "ok" | "fenced" | "no_json";
    validation_code: string | null;
    tool_names_seen: string[];
    tool_names_dropped: number;
    tokens: number;
    ms: number;
  }>;
  plannerFailureCode?: string;
  /** Scout calls and Scout milliseconds actually spent on this request. */
  meter?: { calls: number; scoutMs: number };
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
