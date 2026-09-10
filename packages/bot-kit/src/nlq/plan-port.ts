import type { ConversationalPlan } from "./conversational-plan.js";
import type { ScoutCallMeter } from "../scout/budget.js";

/**
 * Design §3: one scope shape on every execution result. The service renders
 * the visible scope line from this; the model never supplies it.
 */
export type ExecutionScope = {
  time: { since_ms: number; until_ms: number; label: string; source: "explicit" | "default" | "tool" } | null;
  graph: { kind: "whole_graph" | "owner_network" | "none"; hops?: 1 | 2 | 3 };
  filters: string[];
  complete: boolean;
};

export type PlanExecutorTool = {
  parameters: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  execute(value: never): Promise<unknown>;
};

export type PlanExecutionRequest = {
  plan: ConversationalPlan;
  owner: string;
  tools: Record<string, PlanExecutorTool>;
  meter: ScoutCallMeter;
  nowMs: number;
  untrustedTexts?: string[];
};

export type PlanExecution = {
  kind: "template" | "cypher" | "chain" | "answer" | "feed";
  results: unknown[];
  tools: string[];
  scope: ExecutionScope;
  complete: boolean;
  failedStep?: string;
  /** Public failure code of the step that stopped the execution. */
  failureCode?: string;
  answer?: string;
  message?: string;
  feed?: unknown;
  executed?: Array<{ tool: string; args: Record<string, unknown> }>;
};

/**
 * Injected by the Pubchi service so `queryNlq` can dispatch cypher, chain and
 * feed plans without bot-kit depending on the Pubchi package.
 */
export type PlanExecutorPort = (request: PlanExecutionRequest) => Promise<PlanExecution>;
