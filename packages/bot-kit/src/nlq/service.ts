import type pg from "pg";
import { log } from "../log.js";
import { Nexus } from "../nexus/nexus.js";
import { nexusTools } from "../nexus/tools.js";
import { publicScoutErrorCode, ScoutClient, ScoutToolError } from "../scout/client.js";
import { checkNlqDailyBudget, scoutSwitchBlocked } from "../scout/budget.js";
import { scoutBreakerBlocked } from "../scout/circuit.js";
import { createScoutTools } from "../scout/tools.js";
import type { ScoutToolsConfig } from "../scout/scout-config.js";
import type { IntentRegexTables } from "./intent.js";
import { parseNlqDailyQueries } from "./env.js";
import { planNlq } from "./planner.js";
import { nlqResult, type NlqRequest, type NlqResult } from "./types.js";

export type NlqServiceOptions = {
  cfg: ScoutToolsConfig & { nexusUrl?: string };
  pool: pg.Pool;
  tables: IntentRegexTables;
  storeSwitchOn?: () => Promise<boolean>;
  client: ScoutClient;
  nexus?: Nexus;
  mentionKey?: string;
  nlqDailyQueries?: number;
};

type ToolWithSchema = {
  parameters: { safeParse: (args: unknown) => { success: boolean; data?: unknown } };
  execute: (args: never) => Promise<unknown>;
};

function isPublicToolError(value: unknown): value is { error: string; message: string } {
  return Boolean(value && typeof value === "object" && "error" in value && typeof (value as { error: unknown }).error === "string");
}

function collectSources(value: unknown): string[] {
  const uris: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    if (!s.startsWith("pubky://") || seen.has(s)) return;
    seen.add(s);
    uris.push(s);
  };
  const walk = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === "string") {
      if (v.startsWith("pubky://")) add(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if (typeof rec.uri === "string") add(rec.uri);
      for (const child of Object.values(rec)) walk(child);
    }
  };
  walk(value);
  return uris;
}

function reasonForCode(code: string): string {
  const publicCode = publicScoutErrorCode(code);
  if (
    publicCode === "BUDGET" ||
    publicCode === "SCOUT_BACKOFF" ||
    publicCode === "RATE_LIMITED" ||
    publicCode === "SWITCH" ||
    publicCode === "DISABLED"
  ) {
    return "graph lookup unavailable right now";
  }
  if (publicCode === "QUERY_REJECTED") return "query rejected";
  if (publicCode === "SCHEMA_ERROR") return "scout schema unavailable";
  if (publicCode === "QUERY_TIMEOUT") return "graph lookup timed out";
  if (publicCode === "SHAPE_ERROR") return "unexpected scout payload";
  return "internal error";
}

export function nlqPublicReason(err: unknown): string {
  if (err instanceof ScoutToolError) return reasonForCode(err.code);
  if (err && typeof err === "object" && "error" in err && typeof (err as { error: unknown }).error === "string") {
    return reasonForCode((err as { error: string }).error);
  }
  if (err && typeof err === "object") {
    const code = "code" in err ? String((err as { code: unknown }).code) : "";
    if (/^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|28P01|57P01|08006|EPIPE)$/.test(code)) {
      return "internal error";
    }
  }
  if (err instanceof Error) {
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|postgres|28P01|57P01|08006/i.test(err.message)) {
      return "internal error";
    }
    if (err.message.startsWith("invalid JEB_")) return "internal error";
  }
  return "internal error";
}

function mapToolError(err: { error: string; message: string }): Pick<NlqResult, "outcome" | "reason"> {
  const code = publicScoutErrorCode(err.error);
  if (code === "BUDGET") {
    return { outcome: "budget_exhausted", reason: reasonForCode(code) };
  }
  if (code === "SCOUT_BACKOFF" || code === "RATE_LIMITED") {
    return { outcome: "circuit_open", reason: reasonForCode(code) };
  }
  if (code === "SWITCH" || code === "DISABLED") {
    return { outcome: "switch_off", reason: reasonForCode(code) };
  }
  if (code === "QUERY_REJECTED") {
    return { outcome: "guard_rejected", reason: reasonForCode(code) };
  }
  if (code === "SCHEMA_ERROR") {
    return { outcome: "schema_unavailable", reason: reasonForCode(code) };
  }
  return { outcome: "tool_error", reason: reasonForCode(code) };
}

function publicToolError(err: { error: string; message: string }): { error: string; message: string } {
  const mapped = mapToolError(err);
  return { error: publicScoutErrorCode(err.error), message: mapped.reason };
}

export async function queryNlq(req: NlqRequest, opts: NlqServiceOptions): Promise<NlqResult> {
  const question = typeof req.question === "string" ? req.question : "";
  if (!question.trim()) {
    return nlqResult({
      outcome: "unsupported",
      reason: "question is required",
      intent: "ignore",
    });
  }

  if (!opts.client) {
    return nlqResult({
      outcome: "tool_error",
      reason: "internal error",
      intent: "answer",
    });
  }

  if (scoutBreakerBlocked()) {
    return nlqResult({
      outcome: "circuit_open",
      reason: "graph lookup unavailable right now",
      intent: "answer",
    });
  }

  const storeSwitchOn = opts.storeSwitchOn ?? (async () => false);
  if (await scoutSwitchBlocked(storeSwitchOn)) {
    return nlqResult({
      outcome: "switch_off",
      reason: "graph lookup unavailable right now",
      intent: "answer",
    });
  }

  const client = opts.client;
  let plan;
  try {
    plan = await planNlq(
      { question, asker: req.asker, scope: req.scope },
      { tables: opts.tables, client, rawEnabled: opts.cfg.scoutRawEnabled },
    );
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "nlq planner failed");
    return nlqResult({
      outcome: "tool_error",
      reason: nlqPublicReason(e),
      intent: "answer",
    });
  }

  if (!plan.ok) {
    const intent = "intent" in plan ? plan.intent : "answer";
    return nlqResult({
      outcome: plan.kind,
      reason: plan.reason,
      intent,
    });
  }

  const ceiling = opts.nlqDailyQueries ?? parseNlqDailyQueries(process.env.JEB_NLQ_DAILY_QUERIES);
  const nlqGate = await checkNlqDailyBudget(opts.pool, ceiling, opts.mentionKey);
  if (nlqGate.blocked) {
    return nlqResult({
      outcome: "budget_exhausted",
      reason: "graph lookup unavailable right now",
      intent: plan.intent,
      planned: plan.planned,
    });
  }

  const scout = createScoutTools({
    cfg: opts.cfg,
    pool: opts.pool,
    mentionKey: opts.mentionKey,
    storeSwitchOn,
    client,
  });
  const nexus =
    opts.nexus ??
    (opts.cfg.nexusUrl
      ? new Nexus(opts.cfg.nexusUrl)
      : undefined);
  const rest = nexus ? nexusTools(nexus) : undefined;

  const results: unknown[] = [];
  const toolTrace: unknown[] = [];
  const sources: string[] = [];

  for (const call of plan.planned) {
    const scoutTool = scout[call.tool as keyof typeof scout] as ToolWithSchema | undefined;
    const nexusTool = rest?.[call.tool as keyof NonNullable<typeof rest>] as ToolWithSchema | undefined;
    const tool = scoutTool ?? nexusTool;
    if (!tool) {
      return nlqResult({
        outcome: "unsupported",
        reason: `tool ${call.tool} is not registered on this service`,
        intent: plan.intent,
        planned: plan.planned,
      });
    }
    const parsed = tool.parameters.safeParse(call.args);
    if (!parsed.success) {
      return nlqResult({
        outcome: "unsupported",
        reason: "tool arguments are invalid",
        intent: plan.intent,
        planned: plan.planned,
      });
    }
    let out: unknown;
    try {
      out = await tool.execute(parsed.data as never);
    } catch (e) {
      log.warn({ err: e instanceof Error ? e.message : String(e), tool: call.tool }, "nlq tool failed");
      return nlqResult({
        outcome: "tool_error",
        reason: nlqPublicReason(e),
        intent: plan.intent,
        planned: plan.planned,
        results,
        toolTrace,
        sources,
      });
    }
    if (isPublicToolError(out)) {
      const mapped = mapToolError(out);
      const publicErr = publicToolError(out);
      toolTrace.push({ toolCalls: [{ name: call.tool, args: call.args }], result: publicErr });
      return nlqResult({
        ...mapped,
        intent: plan.intent,
        planned: plan.planned,
        results: [...results, publicErr],
        toolTrace,
        sources,
      });
    }
    toolTrace.push({ toolCalls: [{ name: call.tool, args: call.args }], result: out });
    results.push(out);
    sources.push(...collectSources(out));
  }

  return {
    outcome: "ok",
    reason: "ok",
    intent: plan.intent,
    planned: plan.planned,
    results,
    toolTrace,
    sources: [...new Set(sources)],
  };
}
