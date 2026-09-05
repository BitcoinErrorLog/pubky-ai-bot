import {
  parseQueryResultV1,
  type QueryResultV1,
  type TenantV1,
} from "../pubchi-schemas/index.js";
import { queryNlq, type NlqServiceOptions } from "../bot-kit/nlq/service.js";
import type { NlqRequest, NlqResult } from "../bot-kit/nlq/types.js";
import { scoutMentionKey } from "./env.js";
import type { ServiceErrorCode } from "./codes.js";
import { screenUntrusted } from "./screen.js";

export type QueryOk = { ok: true; result: QueryResultV1 };
export type QueryFail = { ok: false; code: ServiceErrorCode };
export type QueryOutcome = QueryOk | QueryFail;

export type QueryNlqFn = (req: NlqRequest, opts: NlqServiceOptions) => Promise<NlqResult>;

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

export async function runQuery(opts: {
  tenant: TenantV1;
  body: unknown;
  now: number;
  runId: string;
  nlq: QueryNlqFn;
  nlqOpts: NlqServiceOptions;
}): Promise<QueryOutcome> {
  const rec = asRecord(opts.body) as QueryBody | null;
  const question = typeof rec?.question === "string" && rec.question.trim() ? rec.question : "who tagged me?";
  // Body asker/scope are ignored. Verified owner is the only graph context.
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
  } catch {
    return { ok: false, code: "UPSTREAM_UNAVAILABLE" };
  }
  if (nlq.outcome !== "ok") return { ok: false, code: mapNlqFailure(nlq.outcome) };
  const assembled = assembleQueryResult({ tenant: opts.tenant, nlq, now: opts.now, runId: opts.runId });
  const parsed = parseQueryResultV1(assembled);
  if (!parsed.ok) return { ok: false, code: parsed.code };
  return { ok: true, result: parsed.value };
}

export { queryNlq };
