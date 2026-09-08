import {
  parsePubchiAnswerV1,
  type PubchiAnswerV1,
  type PubchiEvidenceV1,
  type TenantV1,
} from "../pubchi-schemas/index.js";
import type { Brain } from "../bot-kit/brain/types.js";
import type { NlqRequest, NlqResult } from "../bot-kit/nlq/types.js";
import type { NlqServiceOptions } from "../bot-kit/nlq/service.js";
import { isPubkyId } from "../pubchi-schemas/pubky.js";
import { scoutMentionKey } from "./env.js";
import { screenAskUntrusted, screenUntrusted } from "./screen.js";
import { log } from "../bot-kit/log.js";
import type { ServiceErrorCode } from "./codes.js";

export type AskNlqFn = (req: NlqRequest, opts: NlqServiceOptions) => Promise<NlqResult>;
export type AskTiming = { nexus_ms?: number; nlq_ms?: number; brain_ms?: number };
export type AskOk = { ok: true; result: PubchiAnswerV1; timings?: AskTiming };
export type AskFail = { ok: false; code: ServiceErrorCode; stage: "query" | "upstream"; cause: string; timings?: AskTiming };
export type AskOutcome = AskOk | AskFail;

const ASK_SYSTEM = [
  "Interpret only the supplied Pubky evidence and return exactly JSON: {\"summary\":string}.",
  "Name claimants and counts when present. Do not add facts, rankings, scores, trust, accuracy, or verdicts.",
  "This is an interpretation of evidence, never a verdict. Keep summary under 1200 characters. Return JSON only.",
].join(" ");

const TOOL_NAMES = [
  "search_posts",
  "scout_get_thread",
  "get_identity_summary",
  "get_topic_brief",
  "get_what_changed",
  "get_related_posts",
  "get_relationship",
  "get_tag_landscape",
  "get_emerging_topics",
  "get_debate_map",
  "query_graph",
  "search_users_by_name",
  "rank_users",
  "recommend_follows",
  "stale_follows",
  "follow_path",
  "trust_view",
  "top_posts",
  "mentions_of",
  "profile_card",
] as const;

type Rec = Record<string, unknown>;

const TOOL_TRACE_IDS: Record<string, string> = {
  get_tag_landscape: "tag_landscape",
  get_identity_summary: "identity_summary",
  search_users_by_name: "search_users",
  recommend_follows: "recommend",
  get_emerging_topics: "emerging_topics",
  get_related_posts: "related_posts",
  get_what_changed: "what_changed",
};

function traceToolName(tool: string): string {
  return TOOL_TRACE_IDS[tool] ?? tool;
}

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function id(value: unknown): string | null {
  const valueString = str(value);
  return isPubkyId(valueString) ? valueString : null;
}

function userUri(value: unknown): string | null {
  const pubky = id(value);
  return pubky ? `pubky://${pubky}/pub/pubky.app/profile.json` : null;
}

function postUri(value: unknown): string | null {
  const uri = str(value);
  if (!uri.startsWith("pubky://")) return null;
  const match = /^pubky:\/\/([ybndrfg8ejkmcpqxot1uwisza345h769]{52})\/pub\/pubky\.app\/posts\/[^/?#]+$/.exec(uri);
  return match && isPubkyId(match[1]) ? uri : null;
}

function claimantIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(id).filter((v): v is string => Boolean(v)).slice(0, 10) : [];
}

function scopeValue(value: Rec): boolean | null {
  const meta = rec(value.meta);
  const scope = rec(meta?.scope ?? value.graph_scope);
  if (scope && typeof scope.pubky === "string") return true;
  if (typeof value.graph_count === "number") return value.graph_count > 0;
  return null;
}

function evidence(
  kind: PubchiEvidenceV1["kind"],
  label: string,
  uri: string | null,
  claimants: unknown = [],
  count?: unknown,
  inYourGraph: boolean | null = null,
): PubchiEvidenceV1[] {
  if (!uri || uri.length > 512 || !label.trim()) {
    if (uri && uri.length > 512) log.warn({ event: "pubchi_ask_evidence_uri_dropped", uri_length: uri.length }, "pubchi ask evidence URI dropped");
    return [];
  }
  const ids = claimantIds(claimants);
  const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.min(10_000, Math.floor(count))) : ids.length;
  return [{ kind, label: label.trim().slice(0, 80), uri, claimants: ids, claimant_count: n, in_your_graph: inYourGraph }];
}

function claims(value: unknown, fallbackUri: string | null, graph: boolean | null): PubchiEvidenceV1[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((claim) => {
    const c = rec(claim);
    if (!c) return [];
    const uri = postUri(c.uri) ?? userUri(c.target_id) ?? fallbackUri;
    return evidence("claim", str(c.label) || "claim", uri, c.claimant_ids, c.count, graph);
  });
}

function rows(value: unknown, key: string): Rec[] {
  const result = rec(value)?.[key];
  return Array.isArray(result) ? result.map(rec).filter((v): v is Rec => Boolean(v)) : [];
}

function mapTool(tool: string, value: unknown): PubchiEvidenceV1[] {
  const result = rec(value);
  if (!result) return [];
  const graph = scopeValue(result);
  switch (tool) {
    case "search_posts":
    case "scout_get_thread":
    case "get_topic_brief":
    case "get_what_changed":
    case "get_related_posts":
    case "mentions_of":
      return rows(result, "posts").flatMap((p) => [
        ...evidence("post", str(p.author_name) || "post", postUri(p.uri), [], undefined, graph),
        ...claims(p.claims, postUri(p.uri), graph),
      ]);
    case "get_identity_summary":
      return [
        ...evidence("user", str(result.name) || "user", userUri(result.pubky), [], undefined, graph),
        ...claims(result.tag_claims, userUri(result.pubky), graph),
      ];
    case "get_relationship":
      return [
        ...evidence("user", "user", userUri(result.a_follows_b ? result.pubky_b : result.pubky_a), [], undefined, graph),
        ...claims(result.tag_claims, userUri(result.pubky_b), graph),
      ];
    case "get_tag_landscape":
      return [
        ...rows(result, "applications").flatMap((a) =>
          evidence("tag", str(result.claims && rec(result.claims)?.label) || "tag", postUri(a.uri) ?? userUri(a.target_id), [a.tagger_id], 1, graph),
        ),
        ...claims(result.claims, null, graph),
      ];
    case "get_emerging_topics":
      return rows(result, "topics").map((t) => evidence("tag", str(t.label) || "topic", userUri(result.pubky), [], t.distinct_taggers, graph)[0]).filter(Boolean);
    case "get_debate_map":
      return rows(result, "clusters").flatMap((c) =>
        evidence("claim", str(c.label) || "claim", postUri(Array.isArray(c.evidence_uris) ? c.evidence_uris[0] : null), c.claimant_ids, c.claim_count, graph),
      );
    case "query_graph":
      return rows(result, "results").flatMap((r) => evidence("claim", str(r.label) || "graph result", postUri(r.uri) ?? userUri(r.pubky), r.claimant_ids, r.count, graph));
    case "search_users_by_name":
    case "rank_users":
    case "recommend_follows":
    case "stale_follows":
      return rows(result, tool === "search_users_by_name" ? "users" : "users").flatMap((u) =>
        evidence("user", str(u.name) || "user", userUri(u.pubky), [], u.followers ?? u.mutual_followers_count, graph),
      );
    case "follow_path":
      return rows(result, "paths").flatMap((p) => (Array.isArray(p.hop_ids) ? p.hop_ids : []).flatMap((v) => evidence("user", "path user", userUri(v), [], undefined, graph)));
    case "trust_view":
      return rows(result, "claims").flatMap((c) =>
        evidence("claim", str(c.label) || "claim", userUri(c.target), c.claimant_ids, c.global_count, Number(c.graph_count) > 0),
      );
    case "top_posts":
      return rows(result, "posts").map((p) => evidence("post", str(p.metric) || "post", postUri(p.uri), [], undefined, graph)[0]).filter(Boolean);
    case "profile_card":
      return [
        ...evidence("user", str(result.name) || "user", userUri(result.pubky), [], undefined, graph),
        ...claims(result.tags_received, userUri(result.pubky), graph),
      ];
    default:
      return [];
  }
}

function fallback(evidenceItems: PubchiEvidenceV1[], tools: string[] = []): string {
  if (!evidenceItems.length) {
    const lookedAt = tools.length ? tools.join(", ") : "the requested graph lookup";
    return `I looked at ${lookedAt} and found no usable evidence for this question. Try “who has the most followers among people I follow” or “who are the top taggers this week”.`;
  }
  const users = evidenceItems.filter((item) => item.kind === "user").length;
  const posts = evidenceItems.filter((item) => item.kind === "post").length;
  const claimsCount = evidenceItems.filter((item) => item.kind === "claim" || item.kind === "tag").length;
  return `Here is what the graph shows: ${users} users, ${posts} posts, and ${claimsCount} tag or claim items.`;
}

function firstJsonObject(text: string): string | null {
  const source = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

function generatedSummary(text: string): string | null {
  const raw = firstJsonObject(text);
  if (!raw) return null;
  try {
    const summary = rec(JSON.parse(raw))?.summary;
    return typeof summary === "string" && summary.trim() ? summary.trim().slice(0, 1200) : null;
  } catch {
    return null;
  }
}

function summaryUsesOnlyEvidence(summary: string, evidenceItems: PubchiEvidenceV1[]): boolean {
  const allowed = new Set(
    evidenceItems.flatMap((item) => [
      ...item.claimants,
      item.uri.match(/^pubky:\/\/([a-z0-9]{52})\//i)?.[1] ?? "",
    ]),
  );
  for (const match of summary.matchAll(/\b([a-z0-9]{52})\b/gi)) {
    if (!allowed.has(match[1])) return false;
  }
  return true;
}

export async function runAsk(opts: {
  tenant: TenantV1;
  body: unknown;
  now: number;
  runId: string;
  nlq: AskNlqFn;
  nlqOpts: NlqServiceOptions;
  brain: Brain;
}): Promise<AskOutcome> {
  const body = rec(opts.body);
  const rawQuestion = typeof body?.question === "string" ? body.question.trim() : "";
  if (rawQuestion.length > 500) return { ok: false, code: "SCHEMA_INVALID", stage: "query", cause: "question_length" };
  const question = rawQuestion;
  if (!question) return { ok: false, code: "SCHEMA_INVALID", stage: "query", cause: "empty_question" };
  const started = performance.now();
  const deadline = started + opts.tenant.budgets.per_request_wall_clock_ms;
  const remaining = () => Math.max(0, deadline - performance.now());
  const timedOut = Symbol("ask_timeout");
  const mentionKey = scoutMentionKey(opts.tenant.bot, opts.tenant.owner);
  let nlq: NlqResult;
  try {
    nlq = await Promise.race([
      opts.nlq(
        { question, asker: opts.tenant.owner, scope: { graph_scope: { pubky: opts.tenant.owner } }, pubchiMode: true },
        { ...opts.nlqOpts, mentionKey },
      ),
      new Promise<never>((_, reject) => setTimeout(() => reject(timedOut), remaining())),
    ]);
  } catch {
    return { ok: false, code: "UPSTREAM_UNAVAILABLE", stage: "upstream", cause: "nlq_timeout_or_throw" };
  }
  const nlqMs = Math.round(performance.now() - started);
  if (nlq.outcome !== "ok") {
    if (nlq.outcome === "unsupported" || nlq.outcome === "ignored" || nlq.outcome === "declined") {
      nlq = { ...nlq, results: [], planned: [] };
    } else {
      const code: ServiceErrorCode = nlq.outcome === "budget_exhausted" ? "BUDGET_EXCEEDED" : "UPSTREAM_UNAVAILABLE";
      return { ok: false, code, stage: code === "BUDGET_EXCEEDED" ? "query" : "upstream", cause: nlq.outcome };
    }
  }
  const items = nlq.results.flatMap((result, i) => mapTool(nlq.planned[i]?.tool ?? "", result));
  const evidenceItems = items.slice(0, 50);
  const screenedEvidence = screenAskUntrusted(evidenceItems);
  const promptEvidence = JSON.stringify(screenedEvidence);
  let summary = fallback(evidenceItems, nlq.planned.map((call) => call.tool));
  let summarySource: "brain" | "fallback_invalid_json" | "fallback_empty" | "fallback_brain_error" | "fallback_timeout" | "skipped_no_evidence" =
    evidenceItems.length === 0 ? "skipped_no_evidence" : "fallback_empty";
  const brainStarted = performance.now();
  if (evidenceItems.length > 0) {
    try {
      const generated = await opts.brain.generate({
        messages: [
          { role: "system", content: ASK_SYSTEM },
          { role: "user", content: JSON.stringify({ question, evidence: promptEvidence }) },
        ],
        temperature: Math.min(opts.brain.temperature, 0.2),
        abortSignal: AbortSignal.timeout(Math.max(1, Math.floor(remaining()))),
        maxOutputTokens: Math.min(300, opts.tenant.budgets.per_request_output_tokens),
      });
      const candidate = generatedSummary(String(screenUntrusted(generated.text)));
      if (candidate && summaryUsesOnlyEvidence(candidate, evidenceItems)) {
        summary = candidate;
        summarySource = "brain";
      } else {
        summarySource = generated.text.trim() ? "fallback_invalid_json" : "fallback_empty";
      }
    } catch (error) {
      const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
      summarySource = name === "TimeoutError" || name === "AbortError" ? "fallback_timeout" : "fallback_brain_error";
    }
  }
  const brainMs = Math.round(performance.now() - brainStarted);
  summary = String(screenUntrusted(summary)).slice(0, 1200);
  const result = {
    schema: "pubchi-answer" as const,
    version: 1 as const,
    bot: opts.tenant.bot,
    owner: opts.tenant.owner,
    generated_at: opts.now,
    run_id: opts.runId,
    purpose: "ask" as const,
    question,
    summary,
    evidence: evidenceItems,
    sources: nlq.sources.filter((source) => {
      if (source.startsWith("pubky://")) return true;
      try {
        const allowed = new URL(opts.nlqOpts.cfg?.nexusUrl ?? "https://nexus.pubky.app").origin;
        const candidate = new URL(source);
        return candidate.protocol === "https:" && candidate.origin === allowed;
      } catch {
        return false;
      }
    }).slice(0, 50),
    tool_trace_summary: {
      tools: [...new Set(nlq.planned.map((call) => traceToolName(call.tool)))].slice(0, 16),
      call_count: nlq.planned.length,
      truncated: nlq.results.some((value) => rec(value)?.truncated === true),
    },
    policy_version: 1 as const,
  };
  const parsed = parsePubchiAnswerV1(result);
  log.info(
    { event: "pubchi_ask", nlq_ms: nlqMs, brain_ms: brainMs, total_ms: Math.round(performance.now() - started), tools: result.tool_trace_summary.tools, evidence_count: evidenceItems.length, summary_source: summarySource, budget_outcome: "reserved" },
    "pubchi ask",
  );
  if (!parsed.ok) return { ok: false, code: "SCHEMA_INVALID", stage: "query", cause: parsed.code, timings: { nlq_ms: nlqMs, brain_ms: brainMs } };
  return { ok: true, result: parsed.value, timings: { nlq_ms: nlqMs, brain_ms: brainMs } };
}

export { TOOL_NAMES };
