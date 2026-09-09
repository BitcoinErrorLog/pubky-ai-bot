import {
  parseQueryResultV1,
  type QueryResultV1,
  type TenantV1,
} from "../pubchi-schemas/index.js";
import { queryNlq, type NlqServiceOptions } from "../bot-kit/nlq/service.js";
import type { NlqRequest, NlqResult } from "../bot-kit/nlq/types.js";
import type { Nexus } from "../bot-kit/nexus/nexus.js";
import { scoutMentionKey } from "./env.js";
import type { ServiceErrorCode } from "./codes.js";
import { screenUntrusted } from "./screen.js";
import { log } from "../bot-kit/log.js";

export type QueryStage = "query" | "upstream";
export type QueryTiming = { nexus_ms?: number; nlq_ms?: number; brain_ms?: number };
export type QueryOk = { ok: true; result: QueryResultV1; timings?: QueryTiming };
export type QueryFail = { ok: false; code: ServiceErrorCode; stage: QueryStage; cause: string; timings?: QueryTiming };
export type QueryOutcome = QueryOk | QueryFail;

export type QueryNlqFn = (req: NlqRequest, opts: NlqServiceOptions) => Promise<NlqResult>;
export type QueryNexus = Pick<Nexus, "userTags"> & Partial<Pick<Nexus, "influencers">>;

export type QueryBody = {
  question?: unknown;
  asker?: unknown;
  scope?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function publicUri(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("pubky://") ? value : null;
}

function itemsFromLandscape(result: Record<string, unknown>, owner: string): QueryResultV1["items"] {
  const applications = Array.isArray(result.applications) ? result.applications : [];
  const claims = Array.isArray(result.claims) ? result.claims : [];
  const firstClaim = asRecord(claims[0]);
  const filters = asRecord(result.filters);
  const labelRaw = (firstClaim?.label ?? filters?.tag ?? "tag") as unknown;
  const label = typeof labelRaw === "string" && labelRaw.length > 0 ? labelRaw.slice(0, 40) : "tag";
  const claimantCount =
    typeof firstClaim?.count === "number" && Number.isFinite(firstClaim.count)
      ? Math.max(0, Math.min(10_000, Math.floor(firstClaim.count)))
      : applications.length;
  const items: QueryResultV1["items"] = [];
  for (const row of applications) {
    const app = asRecord(row);
    if (!app) continue;
    const subject = publicUri(app.uri);
    const tagger = typeof app.tagger_id === "string" ? app.tagger_id : null;
    if (!subject || !subject.startsWith(`pubky://${owner}/pub/pubky.app/`)) continue;
    if (!tagger) continue;
    items.push({
      label,
      source_uri: `pubky://${tagger}/pub/pubky.app/profile.json`,
      subject_uri: subject,
      claimant_count: claimantCount,
    });
    if (items.length >= 100) break;
  }
  return items;
}

function itemsFromShaped(result: Record<string, unknown>): QueryResultV1["items"] {
  if (!Array.isArray(result.items)) return [];
  const items: QueryResultV1["items"] = [];
  for (const row of result.items) {
    const rec = asRecord(row);
    if (!rec) continue;
    if (typeof rec.label !== "string" || typeof rec.source_uri !== "string") continue;
    if (typeof rec.subject_uri !== "string" || typeof rec.claimant_count !== "number") continue;
    items.push({
      label: rec.label.slice(0, 40),
      source_uri: rec.source_uri,
      subject_uri: rec.subject_uri,
      claimant_count: Math.max(0, Math.min(10_000, Math.floor(rec.claimant_count))),
    });
  }
  return items;
}

export function assembleQueryResult(opts: {
  tenant: TenantV1;
  nlq: NlqResult;
  now: number;
  runId: string;
}): QueryResultV1 {
  const items: QueryResultV1["items"] = [];
  const tools: string[] = [];
  for (const planned of opts.nlq.planned) {
    if (planned.tool && !tools.includes(planned.tool)) tools.push(planned.tool);
  }
  for (const raw of opts.nlq.results) {
    const screened = asRecord(screenUntrusted(raw));
    if (!screened) continue;
    const shaped = itemsFromShaped(screened);
    if (shaped.length) items.push(...shaped);
    else items.push(...itemsFromLandscape(screened, opts.tenant.owner));
  }
  return {
    schema: "pubchi-query-result",
    version: 1,
    bot: opts.tenant.bot,
    owner: opts.tenant.owner,
    generated_at: opts.now,
    run_id: opts.runId,
    purpose: "who-tagged-me",
    scope_owner: opts.tenant.owner,
    items: items.slice(0, 100),
    tool_trace_summary: {
      tools: tools.slice(0, 16),
      call_count: opts.nlq.planned.length,
      truncated: opts.nlq.results.some((r) => asRecord(r)?.truncated === true),
    },
    policy_version: 1,
  };
}

function mapNlqFailure(outcome: NlqResult["outcome"]): ServiceErrorCode {
  if (outcome === "budget_exhausted") return "BUDGET_EXCEEDED";
  return "UPSTREAM_UNAVAILABLE";
}

function emptyQueryResult(opts: { tenant: TenantV1; now: number; runId: string; tools: string[]; callCount: number }): QueryResultV1 {
  return {
    schema: "pubchi-query-result",
    version: 1,
    bot: opts.tenant.bot,
    owner: opts.tenant.owner,
    generated_at: opts.now,
    run_id: opts.runId,
    purpose: "who-tagged-me",
    scope_owner: opts.tenant.owner,
    items: [],
    tool_trace_summary: {
      tools: opts.tools.slice(0, 16),
      call_count: opts.callCount,
      truncated: false,
    },
    policy_version: 1,
  };
}

function itemsFromUserTags(
  tags: Awaited<ReturnType<QueryNexus["userTags"]>>,
  owner: string,
): QueryResultV1["items"] {
  if (!tags) return [];
  const rows: QueryResultV1["items"] = [];
  for (const tag of tags) {
    const label = tag.label.slice(0, 40);
    const claimantCount = Math.max(0, Math.min(10_000, Math.floor(tag.taggers_count)));
    for (const tagger of tag.taggers) {
      rows.push({
        label,
        source_uri: `pubky://${tagger}/pub/pubky.app/profile.json`,
        subject_uri: `pubky://${owner}/pub/pubky.app/profile.json`,
        claimant_count: claimantCount,
      });
    }
  }
  return rows
    .sort((a, b) => a.label.localeCompare(b.label) || a.source_uri.localeCompare(b.source_uri))
    .slice(0, 100);
}

async function runWhoTaggedMe(opts: {
  tenant: TenantV1;
  nexus: QueryNexus;
  now: number;
  runId: string;
}): Promise<QueryOutcome> {
  const started = performance.now();
  try {
    const tags = await opts.nexus.userTags(opts.tenant.owner);
    const nexusMs = Math.round(performance.now() - started);
    const assembled = {
      ...emptyQueryResult({
        tenant: opts.tenant,
        now: opts.now,
        runId: opts.runId,
        tools: ["nexus_user_tags"],
        callCount: 1,
      }),
      items: itemsFromUserTags(tags, opts.tenant.owner),
    };
    const parsed = parseQueryResultV1(assembled);
    if (!parsed.ok) return { ok: false, code: parsed.code, stage: "query", cause: parsed.code, timings: { nexus_ms: nexusMs } };
    return { ok: true, result: parsed.value, timings: { nexus_ms: nexusMs } };
  } catch (e) {
    const nexusMs = Math.round(performance.now() - started);
    const status = e && typeof e === "object" && "status" in e ? (e as { status?: unknown }).status : undefined;
    const statusText = typeof status === "number" ? String(status) : "unknown";
    const zodIssueCount = e && typeof e === "object" && "zodIssueCount" in e ? (e as { zodIssueCount?: unknown }).zodIssueCount : undefined;
    log.warn({ event: "pubchi_nexus_user_tags_failed", status, zod_issue_count: zodIssueCount }, "pubchi Nexus user tags failed");
    return { ok: false, code: "UPSTREAM_UNAVAILABLE", stage: "upstream", cause: `nexus_user_tags ${statusText}`, timings: { nexus_ms: nexusMs } };
  }
}

function isHonestEmptyOutcome(outcome: NlqResult["outcome"]): boolean {
  return outcome === "unsupported" || outcome === "ignored" || outcome === "declined";
}

export async function runNlqQuery(opts: {
  tenant: TenantV1;
  body: unknown;
  now: number;
  runId: string;
  nlq: QueryNlqFn;
  nlqOpts: NlqServiceOptions;
}): Promise<QueryOutcome> {
  const rec = asRecord(opts.body) as QueryBody | null;
  const question = typeof rec?.question === "string" && rec.question.trim() ? rec.question : "who tagged me?";
  const mentionKey = scoutMentionKey(opts.tenant.bot, opts.tenant.owner);
  let nlq: NlqResult;
  try {
    nlq = await opts.nlq(
      {
        question,
        asker: opts.tenant.owner,
        scope: { graph_scope: { pubky: opts.tenant.owner } },
      },
      { ...opts.nlqOpts, mentionKey },
    );
  } catch (e) {
    const name = e instanceof Error ? e.name : "nlq_throw";
    const message = e instanceof Error ? e.message : String(e);
    const pgCode =
      e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string"
        ? (e as { code: string }).code
        : undefined;
    log.warn({ event: "pubchi_nlq_throw", name, message, pgCode }, "pubchi nlq throw");
    return { ok: false, code: "UPSTREAM_UNAVAILABLE", stage: "upstream", cause: name };
  }
  if (nlq.outcome !== "ok") {
    if (isHonestEmptyOutcome(nlq.outcome)) {
      const assembled = emptyQueryResult({
        tenant: opts.tenant,
        now: opts.now,
        runId: opts.runId,
        tools: [],
        callCount: 0,
      });
      const parsed = parseQueryResultV1(assembled);
      if (!parsed.ok) return { ok: false, code: parsed.code, stage: "query", cause: parsed.code };
      return { ok: true, result: parsed.value };
    }
    const code = mapNlqFailure(nlq.outcome);
    const stage: QueryStage =
      nlq.outcome === "schema_unavailable" ||
      nlq.outcome === "tool_error" ||
      nlq.outcome === "circuit_open" ||
      nlq.outcome === "switch_off"
        ? "upstream"
        : "query";
    const host = (() => {
      try {
        return new URL(opts.nlqOpts.cfg.scoutUrl).host;
      } catch {
        return "scout";
      }
    })();
    return { ok: false, code, stage, cause: `${nlq.outcome} ${host}` };
  }
  const assembled = assembleQueryResult({ tenant: opts.tenant, nlq, now: opts.now, runId: opts.runId });
  const parsed = parseQueryResultV1(assembled);
  if (!parsed.ok) return { ok: false, code: parsed.code, stage: "query", cause: parsed.code };
  return { ok: true, result: parsed.value };
}

export { queryNlq };

export async function runQuery(opts: {
  tenant: TenantV1;
  body: unknown;
  now: number;
  runId: string;
  nlq: QueryNlqFn;
  nlqOpts: NlqServiceOptions;
  nexus: QueryNexus;
}): Promise<QueryOutcome> {
  return runWhoTaggedMe({
    tenant: opts.tenant,
    nexus: opts.nexus,
    now: opts.now,
    runId: opts.runId,
  });
}
