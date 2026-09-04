import type pg from "pg";
import { Nexus } from "../nexus/nexus.js";
import { nexusTools } from "../nexus/tools.js";
import { ScoutClient } from "../scout/client.js";
import { scoutBreakerBlocked } from "../scout/circuit.js";
import { createScoutTools } from "../scout/tools.js";
import type { ScoutToolsConfig } from "../scout/scout-config.js";
import type { IntentRegexTables } from "./intent.js";
import { planNlq } from "./planner.js";
import { nlqResult, type NlqRequest, type NlqResult } from "./types.js";

export type NlqServiceOptions = {
  cfg: ScoutToolsConfig & { nexusUrl?: string };
  pool: pg.Pool;
  tables: IntentRegexTables;
  storeSwitchOn?: () => Promise<boolean>;
  client?: ScoutClient;
  nexus?: Nexus;
  mentionKey?: string;
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

function mapToolError(err: { error: string; message: string }): Pick<NlqResult, "outcome" | "reason"> {
  if (err.error === "BUDGET") {
    return { outcome: "budget_exhausted", reason: err.message };
  }
  if (err.error === "SCOUT_BACKOFF") {
    return { outcome: "circuit_open", reason: err.message };
  }
  if (err.error === "QUERY_REJECTED") {
    return { outcome: "guard_rejected", reason: err.message };
  }
  return { outcome: "tool_error", reason: err.message };
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

  const client = opts.client ?? new ScoutClient(opts.cfg, opts.pool);
  let plan;
  try {
    plan = await planNlq(
      { question, asker: req.asker, scope: req.scope },
      { tables: opts.tables, client, rawEnabled: opts.cfg.scoutRawEnabled },
    );
  } catch (e) {
    return nlqResult({
      outcome: "tool_error",
      reason: e instanceof Error ? e.message : "planner failed",
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

  if (scoutBreakerBlocked()) {
    return nlqResult({
      outcome: "circuit_open",
      reason: "graph lookup unavailable right now",
      intent: plan.intent,
      planned: plan.planned,
    });
  }

  const scout = createScoutTools({
    cfg: opts.cfg,
    pool: opts.pool,
    mentionKey: opts.mentionKey,
    author: req.asker,
    storeSwitchOn: opts.storeSwitchOn ?? (async () => false),
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
    const scoutTool = scout[call.tool as keyof typeof scout] as
      | { execute: (args: never) => Promise<unknown> }
      | undefined;
    const nexusTool = rest?.[call.tool as keyof NonNullable<typeof rest>] as
      | { execute: (args: never) => Promise<unknown> }
      | undefined;
    const tool = scoutTool ?? nexusTool;
    if (!tool) {
      return nlqResult({
        outcome: "unsupported",
        reason: `tool ${call.tool} is not registered on this service`,
        intent: plan.intent,
        planned: plan.planned,
      });
    }
    let out: unknown;
    try {
      out = await tool.execute(call.args as never);
    } catch (e) {
      return nlqResult({
        outcome: "tool_error",
        reason: e instanceof Error ? e.message : "tool failed",
        intent: plan.intent,
        planned: plan.planned,
        results,
        toolTrace,
        sources,
      });
    }
    toolTrace.push({ toolCalls: [{ name: call.tool, args: call.args }], result: out });
    if (isPublicToolError(out)) {
      const mapped = mapToolError(out);
      return nlqResult({
        ...mapped,
        intent: plan.intent,
        planned: plan.planned,
        results: [...results, out],
        toolTrace,
        sources,
      });
    }
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
