import {
  parsePubchiAnswerV1,
  type PubchiAnswerV1,
  type PubchiEvidenceV1,
  type TenantV1,
} from "../pubchi-schemas/index.js";
import type { Brain } from "../bot-kit/brain/types.js";
import type { NlqRequest, NlqResult } from "../bot-kit/nlq/types.js";
import type { NlqServiceOptions } from "../bot-kit/nlq/service.js";
import type { Nexus } from "../bot-kit/nexus/nexus.js";
import { isPubchiOwnerTagsQuestion } from "../bot-kit/nlq/planner.js";
import { isPubkyId } from "../pubchi-schemas/pubky.js";
import { scoutMentionKey } from "./env.js";
import { screenAskUntrusted, screenUntrusted } from "./screen.js";
import { renderOwnerContext, type OwnerContext } from "./owner-context.js";
import { log } from "../bot-kit/log.js";
import type { ServiceErrorCode } from "./codes.js";

export type AskNlqFn = (req: NlqRequest, opts: NlqServiceOptions) => Promise<NlqResult>;
export type AskTiming = { nexus_ms?: number; nlq_ms?: number; brain_ms?: number };
export type AskOk = { ok: true; result: PubchiAnswerV1; timings?: AskTiming; settlementTokens?: number };
export type AskFail = {
  ok: false;
  code: ServiceErrorCode;
  stage: "query" | "upstream";
  cause: string;
  timings?: AskTiming;
  settlementTokens?: number;
};
export type AskOutcome = AskOk | AskFail;

const ASK_SYSTEM = [
  "Interpret only the supplied Pubky evidence and return exactly JSON: {\"summary\":string}.",
  "Name claimants and counts when present. Do not add facts, rankings, scores, trust, accuracy, or verdicts.",
  "This is an interpretation of evidence, never a verdict. Keep summary under 1200 characters. Return JSON only.",
].join(" ");

const BRAIN_EVIDENCE_MAX_CHARS = 8000;
const BRAIN_EVIDENCE_MAX_ITEMS = 12;
const SUMMARY_MAX_OUTPUT_TOKENS = 1200;
const BRAIN_PROVIDER_OPTIONS = { moonshot: { thinking: { type: "disabled" } } };

function reportedUsageTokens(usage: {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
} | undefined): number | undefined {
  if (!usage) return undefined;
  const fields = [usage.promptTokens, usage.completionTokens, usage.reasoningTokens].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (fields.length > 0) return fields.reduce((sum, value) => sum + value, 0);
  return typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) ? usage.totalTokens : undefined;
}

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
  "nexus_influencers",
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
  get_user_tags: "nexus_user_tags",
  nexus_user_tags: "nexus_user_tags",
  get_tag_landscape: "tag_landscape",
  get_identity_summary: "identity_summary",
  search_users_by_name: "search_users",
  recommend_follows: "recommend",
  get_emerging_topics: "emerging_topics",
  get_related_posts: "related_posts",
  get_what_changed: "what_changed",
  nexus_influencers: "nexus_influencer",
};

function traceToolName(tool: string, metric?: string): string {
  if (tool === "rank_users" && metric === "tags_received") return "rank_tags_recv";
  if (tool === "rank_users" && metric === "tags_applied") return "rank_tags_apply";
  return TOOL_TRACE_IDS[tool] ?? tool;
}

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function isPubchiEvidence(value: unknown): value is PubchiEvidenceV1 {
  const item = rec(value);
  return Boolean(
    item &&
      (item.kind === "user" || item.kind === "post" || item.kind === "tag" || item.kind === "claim") &&
      typeof item.label === "string" &&
      typeof item.uri === "string" &&
      Array.isArray(item.claimants) &&
      item.claimants.every((claimant) => typeof claimant === "string") &&
      typeof item.claimant_count === "number" &&
      Number.isInteger(item.claimant_count) &&
      item.claimant_count >= 0 &&
      (typeof item.in_your_graph === "boolean" || item.in_your_graph === null),
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function codePointSlice(value: string, length: number): string {
  const points = Array.from(value).slice(0, length);
  while (points.join("").length > length) points.pop();
  return points.join("");
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function screenedPostExcerpt(value: unknown): string {
  const raw = str(value);
  if (!raw) return "";
  const screened = String(screenUntrusted(raw)).replace(/\s+/g, " ").trim();
  if (codePointLength(screened) <= 140) return screened;
  return `${codePointSlice(screened, 139)}…`;
}

function postLabel(author: unknown, content: unknown, labels: string[] = []): string {
  const name = str(author).trim() || "post";
  const excerpt = screenedPostExcerpt(content);
  if (!excerpt) return codePointSlice(name, 80);
  const separator = " — ";
  const available = 80 - codePointLength(name) - codePointLength(separator);
  if (available <= 0) return codePointSlice(name, 80);
  const excerptWasCut = codePointLength(excerpt) > available;
  const boundedExcerpt = excerptWasCut
    ? `${codePointSlice(excerpt, Math.max(0, available - 1))}…`
    : excerpt;
  const base = `${name}${separator}${boundedExcerpt}`;
  if (!labels.length) return base;
  const suffix = ` [${labels.join(", ")}]`;
  return codePointLength(base) + codePointLength(suffix) <= 80 ? `${base}${suffix}` : base;
}

function postClaimants(post: Rec): { claimants: string[]; count: number } {
  const claimants = [
    ...claimantIds(post.taggers),
    ...(Array.isArray(post.claims) ? post.claims.flatMap((claim) => {
      const item = rec(claim);
      return item ? claimantIds(item.tagger) : [];
    }) : []),
  ];
  const unique = [...new Set(claimants)].slice(0, 10);
  return { claimants: unique, count: unique.length };
}

function postEvidence(post: Rec, graph: boolean | null, count?: unknown): PubchiEvidenceV1[] {
  const claimants = postClaimants(post);
  const labels = [
    ...(Array.isArray(post.labels) ? post.labels : []),
    ...(Array.isArray(post.claims) ? post.claims.flatMap((claim) => {
      const item = rec(claim);
      return item && typeof item.label === "string" ? [item.label] : [];
    }) : []),
  ].filter((label): label is string => typeof label === "string" && Boolean(label.trim())).slice(0, 3);
  return evidence(
    "post",
    postLabel(post.author_name, post.content ?? post.content_preview, labels),
    postUri(post.uri),
    claimants.claimants,
    count ?? claimants.count,
    graph,
  );
}

function boundBrainEvidence(evidence: PubchiEvidenceV1[]): { serialized: string; truncated: boolean } {
  const posts = evidence.filter((item) => item.kind === "post");
  const postsWithContent = posts.filter((item) => item.label.includes(" — "));
  const prioritized = [
    ...postsWithContent,
    ...posts.filter((item) => !postsWithContent.includes(item)),
    ...evidence.filter((item) => item.kind === "user"),
    ...evidence.filter((item) => item.kind !== "post" && item.kind !== "user"),
  ].slice(0, BRAIN_EVIDENCE_MAX_ITEMS);
  const serialized = JSON.stringify(prioritized);
  if (serialized.length <= BRAIN_EVIDENCE_MAX_CHARS) return { serialized, truncated: false };
  const bounded: PubchiEvidenceV1[] = [];
  for (const item of prioritized) {
    const candidate = JSON.stringify([...bounded, item]);
    if (candidate.length > BRAIN_EVIDENCE_MAX_CHARS) break;
    bounded.push(item);
  }
  return { serialized: JSON.stringify(bounded), truncated: true };
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
  return [{ kind, label: codePointSlice(label.trim(), 80), uri, claimants: ids, claimant_count: n, in_your_graph: inYourGraph }];
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

function mapTool(tool: string, value: unknown, metric?: string): PubchiEvidenceV1[] {
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
      return rows(result, "posts").flatMap((p) => postEvidence(p, graph));
    case "get_identity_summary":
      return [
        ...evidence("user", str(result.name) || "user", userUri(result.pubky), [], undefined, graph),
        ...claims(result.tag_claims, userUri(result.pubky), graph),
      ];
    case "get_user_tags":
    case "nexus_user_tags":
      return rows(result, "tags").flatMap((tag) =>
        evidence("tag", str(tag.label) || "tag", userUri(result.pubky), tag.taggers, tag.taggers_count, graph),
      );
    case "get_relationship":
      return [
        ...evidence("user", "user", userUri(result.a_follows_b ? result.pubky_b : result.pubky_a), [], undefined, graph),
        ...claims(result.tag_claims, userUri(result.pubky_b), graph),
      ];
    case "get_tag_landscape":
      {
        const firstClaim = Array.isArray(result.claims) ? rec(result.claims[0]) : null;
      return [
        ...rows(result, "applications").flatMap((a) =>
          evidence("tag", str(firstClaim?.label) || "tag", postUri(a.uri) ?? userUri(a.target_id), [a.tagger_id], 1, graph),
        ),
        ...claims(result.claims, null, graph),
      ];
      }
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
        evidence(
          "user",
          str(u.name) || "user",
          userUri(u.pubky),
          [],
          metric === "tags_received" ? u.tags_received : metric === "tags_applied" ? u.tags_applied : u.followers ?? u.mutual_followers_count,
          graph,
        ),
      );
    case "nexus_influencers":
      return rows(result, "users").flatMap((u) => {
        const details = rec(u.details);
        const counts = rec(u.counts);
        return evidence("user", str(details?.name) || "user", userUri(details?.id), [], counts?.followers, null);
      });
    case "follow_path":
      return rows(result, "paths").flatMap((p) => (Array.isArray(p.hop_ids) ? p.hop_ids : []).flatMap((v) => evidence("user", "path user", userUri(v), [], undefined, graph)));
    case "trust_view":
      return rows(result, "claims").flatMap((c) =>
        evidence("claim", str(c.label) || "claim", userUri(c.target), c.claimant_ids, c.global_count, Number(c.graph_count) > 0),
      );
    case "top_posts":
      return rows(result, "posts").map((p) =>
        postEvidence(p, graph, p.score)[0],
      ).filter(Boolean);
    case "profile_card":
      return [
        ...evidence("user", str(result.name) || "user", userUri(result.pubky), [], undefined, graph),
        ...claims(result.tags_received, userUri(result.pubky), graph),
      ];
    default:
      return [];
  }
}

export function fallback(evidenceItems: PubchiEvidenceV1[], tools: string[] = []): string {
  if (!evidenceItems.length) {
    if (!tools.length) {
      return "I couldn't map that question to a graph lookup. I can answer: who tagged me, who the most followed accounts are, the most active threads, trending tags, who to follow, and I can build a feed.";
    }
    const lookedAt = tools.length ? tools.join(", ") : "the requested graph lookup";
    return `I looked at ${lookedAt} and found no usable evidence for this question. Try “who has the most followers among people I follow” or “who are the top taggers this week”.`;
  }
  const users = evidenceItems.filter((item) => item.kind === "user");
  if (users.length) {
    const ranked = users
      .map((item, index) => ({ item, index }))
      .sort((a, b) => b.item.claimant_count - a.item.claimant_count || a.index - b.index)
      .slice(0, 3)
      .map(({ item }) => namedCount(item))
      .join(", ");
    return `The most followed accounts in this result are ${ranked}.`;
  }
  const userCount = users.length;
  const posts = evidenceItems.filter((item) => item.kind === "post").length;
  const claimsCount = evidenceItems.filter((item) => item.kind === "claim" || item.kind === "tag").length;
  return `The result includes ${userCount} users, ${posts} posts, and ${claimsCount} tag or claim items.`;
}

function safeFallback(evidenceItems: PubchiEvidenceV1[]): string {
  const users = evidenceItems.filter((item) => item.kind === "user").length;
  const posts = evidenceItems.filter((item) => item.kind === "post").length;
  const claimsCount = evidenceItems.filter((item) => item.kind === "claim" || item.kind === "tag").length;
  return `The result includes ${users} users, ${posts} posts, and ${claimsCount} tag or claim items.`;
}

const DETERMINISTIC_TOOLS = new Set([
  "get_user_tags",
  "nexus_user_tags",
  "nexus_influencers",
  "rank_users",
  "recommend_follows",
  "stale_follows",
  "top_posts",
  "get_tag_landscape",
]);

function namedCount(item: PubchiEvidenceV1): string {
  return `${codePointSlice(item.label, 80)} (${item.claimant_count >= 10_000 ? "10000+" : item.claimant_count})`;
}

export function deterministicSummary(
  tool: string,
  evidenceItems: PubchiEvidenceV1[],
  truncated: boolean,
  metric?: string,
): string | null {
  if (!DETERMINISTIC_TOOLS.has(tool) || !evidenceItems.length) return null;
  const suffix = truncated ? " The result was truncated." : "";
  const names = evidenceItems.slice(0, 5).map(namedCount);
  if (tool === "get_tag_landscape") {
    const label = evidenceItems.find((item) => item.kind === "tag" || item.kind === "claim")?.label ?? "the requested tag";
    const claimants = evidenceItems.filter((item) => item.kind === "tag" || item.kind === "claim");
    const count = claimants.reduce((total, item) => total + item.claimant_count, 0);
    return `The ${label} tag appears in ${count} claimant record${count === 1 ? "" : "s"} in this result.${suffix}`;
  }
  if (tool === "get_user_tags" || tool === "nexus_user_tags") {
    const tags = evidenceItems.filter((item) => item.kind === "tag");
    return `People have tagged you as ${tags.map(namedCount).join(", ")}.${suffix}`;
  }
  if (tool === "top_posts") {
    const posts = evidenceItems.slice(0, 5).map(namedCount);
    return posts.length ? `The most active threads in this result are: ${posts.join("; ")}.${suffix}` : null;
  }
  if (tool === "recommend_follows") {
    return `The recommended follow candidates in this result are ${names.join(", ")}.${suffix}`;
  }
  if (tool === "stale_follows") {
    const users = evidenceItems.slice(0, 5).map((item) =>
      `${codePointSlice(item.label, 80)} (${item.claimant_count >= 10_000 ? "10000+" : item.claimant_count} followers)`,
    ).join(", ");
    return `Accounts that have gone quiet in this result include ${users}.${suffix}`;
  }
  if (tool === "rank_users" && (metric === "tags_received" || metric === "tags_applied")) {
    const verb = metric === "tags_received" ? "received" : "applied";
    const tagCounts = evidenceItems.slice(0, 5).map((item) =>
      `${codePointSlice(item.label, 80)} (${verb} ${item.claimant_count >= 10_000 ? "10000+" : item.claimant_count} tags)`,
    );
    return `The users in this result are ${tagCounts.join(", ")}.${suffix}`;
  }
  const label = tool === "nexus_influencers" ? "accounts" : "users";
  return `The ${label} in this result are ${names.join(", ")}.${suffix}`;
}

function brainErrorDetails(
  error: unknown,
  ownerContextRendered: boolean,
): { brain_error_name: string; brain_error_status?: number; brain_error_message: string } {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const response = value.response && typeof value.response === "object" ? value.response as Record<string, unknown> : {};
  const status = [value.status, value.statusCode, response.status]
    .find((candidate): candidate is number => typeof candidate === "number" && Number.isInteger(candidate));
  const responseBody = typeof value.responseBody === "string" ? value.responseBody : undefined;
  const message = responseBody ?? (ownerContextRendered ? "" : error instanceof Error ? error.message : typeof value.message === "string" ? value.message : String(error));
  return {
    brain_error_name: typeof value.name === "string" ? value.name : typeof error,
    ...(status === undefined ? {} : { brain_error_status: status }),
    brain_error_message: String(screenUntrusted(message)).replace(/\s+/g, " ").slice(0, 300),
  };
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

function hasSingleSentenceRule(instructions: string | undefined): boolean {
  return typeof instructions === "string" && /\b(?:one|a single)\s+sentence\b/i.test(instructions);
}

function summarySentenceCount(summary: string): number {
  const matches = summary.match(/[^.!?…]+[.!?…]+(?=\s|$)/g);
  return Math.max(1, matches?.length ?? 1);
}

export async function runAsk(opts: {
  tenant: TenantV1;
  body: unknown;
  now: number;
  runId: string;
  nlq: AskNlqFn;
  nlqOpts: NlqServiceOptions;
  nexus?: { influencers?: Nexus["influencers"]; userTags?: Nexus["userTags"] };
  brain: Brain;
  ownerContext?: OwnerContext;
  budgetReserved?: number;
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
  const ownerTagsIntent = isPubchiOwnerTagsQuestion(question);
  const influencerIntent = /\bmost followed\b|\btop followers\b|\b(?:most|top)\s+influential users?\b/i.test(question);
  const nlqStarted = performance.now();
  let consumedTokens = 0;
  if (ownerTagsIntent && opts.nexus?.userTags) {
    try {
      const tags = await Promise.race([
        opts.nexus.userTags(opts.tenant.owner),
        new Promise<never>((_, reject) => setTimeout(() => reject(timedOut), remaining())),
      ]);
      nlq = {
        outcome: "ok",
        reason: "ok",
        intent: "research_pubky",
        planned: [{ tool: "get_user_tags", args: { pubky: opts.tenant.owner } }],
        results: [{ pubky: opts.tenant.owner, tags }],
        toolTrace: [],
        sources: [],
      };
    } catch {
      return { ok: false, code: "UPSTREAM_UNAVAILABLE", stage: "upstream", cause: "nexus_user_tags" };
    }
  } else if (influencerIntent && opts.nexus?.influencers) {
    try {
      const users = await Promise.race([
        opts.nexus.influencers(10, "all_time"),
        new Promise<never>((_, reject) => setTimeout(() => reject(timedOut), remaining())),
      ]);
      nlq = {
        outcome: "ok",
        reason: "ok",
        intent: "research_pubky",
        planned: [{ tool: "nexus_influencers", args: { limit: 10, timeframe: "all_time" } }],
        results: [{ users }],
        toolTrace: [],
        sources: [],
      };
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : typeof error;
      log.warn({ event: "pubchi_nexus_influencers_failed", tool: "nexus_influencers", error_class: errorClass }, "pubchi Nexus influencers failed");
      return { ok: false, code: "UPSTREAM_UNAVAILABLE", stage: "upstream", cause: "nexus_influencers" };
    }
  } else {
    try {
      nlq = await Promise.race([
        opts.nlq(
          { question, asker: opts.tenant.owner, scope: { graph_scope: { pubky: opts.tenant.owner } }, pubchiMode: true },
          {
            ...opts.nlqOpts,
            mentionKey,
            brain: opts.brain,
            screenQuestion: (value) => String(screenUntrusted(value)),
            plannerAbortSignal: AbortSignal.timeout(Math.max(1, Math.floor(remaining()))),
          },
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(timedOut), remaining())),
      ]);
    } catch {
      return { ok: false, code: "UPSTREAM_UNAVAILABLE", stage: "upstream", cause: "nlq_timeout_or_throw" };
    }
  }
  const nlqMs = Math.round(performance.now() - nlqStarted);
  if (nlq.outcome !== "ok") {
    if (nlq.outcome === "unsupported" || nlq.outcome === "ignored" || nlq.outcome === "declined") {
      nlq = { ...nlq, results: [], planned: [] };
    } else {
      const code: ServiceErrorCode = nlq.outcome === "budget_exhausted" ? "BUDGET_EXCEEDED" : "UPSTREAM_UNAVAILABLE";
      return { ok: false, code, stage: code === "BUDGET_EXCEEDED" ? "query" : "upstream", cause: nlq.outcome, settlementTokens: nlq.brainTokens };
    }
  }
  consumedTokens += nlq.brainTokens ?? 0;
  const items = nlq.results.flatMap((result, i) => {
    const planned = nlq.planned[i];
    const metric = planned?.tool === "rank_users" && typeof planned.args.metric === "string" ? planned.args.metric : undefined;
    return mapTool(planned?.tool ?? "", result, metric);
  });
  const evidenceItems = items.slice(0, 50);
  const screenedValues = evidenceItems.map((item) => screenAskUntrusted(item));
  const screenedEvidence = screenedValues.flatMap((item): PubchiEvidenceV1[] => {
    if (isPubchiEvidence(item)) {
      return [item];
    }
      log.warn({ event: "pubchi_ask_evidence_dropped", reason: "evidence_dropped" }, "pubchi ask evidence dropped");
      return [];
  });
  let summary = fallback(screenedEvidence, nlq.planned.map((call) => call.tool));
  let summarySource: "brain" | "deterministic" | "deterministic_rejected" | "fallback_invalid_json" | "fallback_empty" | "fallback_brain_error" | "fallback_timeout" | "skipped_no_evidence" | "no_route" =
    screenedEvidence.length === 0 && nlq.planned.length === 0 ? "no_route" : screenedEvidence.length === 0 ? "skipped_no_evidence" : "fallback_empty";
  let brainError: ReturnType<typeof brainErrorDetails> | undefined;
  let brainGeneration:
    | {
        text: string;
        finishReason?: string;
        usage?: { totalTokens?: number; promptTokens?: number; completionTokens?: number; reasoningTokens?: number };
      }
    | undefined;
  let summaryForm: "multi_sentence" | undefined;
  let brainEvidenceTruncated = false;
  const brainStarted = performance.now();
  const plannedTools = [...new Set(nlq.planned.map((call) => call.tool))];
  const deterministicTool = plannedTools.length === 1 ? plannedTools[0] : undefined;
  const deterministicMetric =
    deterministicTool === "rank_users" && typeof nlq.planned[0]?.args.metric === "string" ? nlq.planned[0].args.metric : undefined;
  const deterministic = deterministicTool
    ? deterministicSummary(
        deterministicTool,
        screenedEvidence,
        nlq.results.some((value) => rec(value)?.truncated === true),
        deterministicMetric,
      )
    : null;
  if (deterministic) {
    if (summaryUsesOnlyEvidence(deterministic, screenedEvidence)) {
      summary = deterministic;
      summarySource = "deterministic";
    } else {
      summary = safeFallback(screenedEvidence);
      summarySource = "deterministic_rejected";
    }
  } else if (screenedEvidence.length > 0) {
    const prompt = boundBrainEvidence(screenedEvidence);
    const ownerContext = renderOwnerContext(opts.ownerContext);
    brainEvidenceTruncated = prompt.truncated || screenedEvidence.length > BRAIN_EVIDENCE_MAX_ITEMS;
    const generateSummary = async (evidencePrompt: string, formInstruction?: string) => {
      try {
        const generated = await opts.brain.generate({
        messages: [
          { role: "system", content: ASK_SYSTEM },
          {
            role: "user",
            content: JSON.stringify({
              question,
              evidence: evidencePrompt,
              ...(ownerContext ? { owner_context: ownerContext } : {}),
              ...(formInstruction ? { form_instruction: formInstruction } : {}),
            }),
          },
        ],
        temperature: opts.brain.temperature,
        abortSignal: AbortSignal.timeout(Math.max(1, Math.floor(remaining()))),
        maxOutputTokens: Math.min(SUMMARY_MAX_OUTPUT_TOKENS, opts.tenant.budgets.per_request_output_tokens),
        providerOptions: BRAIN_PROVIDER_OPTIONS,
      });
        consumedTokens += reportedUsageTokens(generated.usage) ?? Math.ceil(question.length / 4);
        return generated;
      } catch (error) {
        consumedTokens += Math.ceil(question.length / 4);
        throw error;
      }
    };
    try {
      brainGeneration = await generateSummary(prompt.serialized);
      if (!brainGeneration.text.trim()) {
        const retryEvidence = boundBrainEvidence(screenedEvidence.slice(0, Math.ceil(screenedEvidence.length / 2)));
        brainGeneration = await generateSummary(retryEvidence.serialized);
      }
      const candidate = generatedSummary(String(screenUntrusted(brainGeneration.text)));
      if (candidate && summaryUsesOnlyEvidence(candidate, screenedEvidence)) {
        summary = candidate;
        summarySource = "brain";
        if (hasSingleSentenceRule(opts.ownerContext?.instructions) && summarySentenceCount(candidate) > 1) {
          const firstCandidate = candidate;
          try {
            const retry = await generateSummary(prompt.serialized, "Return exactly one sentence.");
            const retryCandidate = generatedSummary(String(screenUntrusted(retry.text)));
            if (retryCandidate && summaryUsesOnlyEvidence(retryCandidate, screenedEvidence) && summarySentenceCount(retryCandidate) <= 1) {
              summary = retryCandidate;
              brainGeneration = retry;
            } else {
              summary = firstCandidate;
              summaryForm = "multi_sentence";
            }
          } catch {
            summary = firstCandidate;
            summaryForm = "multi_sentence";
          }
        }
      } else {
        summarySource = brainGeneration.text.trim() ? "fallback_invalid_json" : "fallback_empty";
      }
    } catch (error) {
      const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
      summarySource = name === "TimeoutError" || name === "AbortError" ? "fallback_timeout" : "fallback_brain_error";
      brainError = brainErrorDetails(error, Boolean(ownerContext));
    }
  }
  const brainMs = Math.round(performance.now() - brainStarted);
  summary = codePointSlice(String(screenUntrusted(summary)), 1200);
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
      tools: [...new Set(nlq.planned.map((call) => traceToolName(
        call.tool,
        call.tool === "rank_users" && typeof call.args.metric === "string" ? call.args.metric : undefined,
      )))].slice(0, 16),
      call_count: nlq.planned.length,
      truncated: nlq.results.some((value) => rec(value)?.truncated === true),
    },
    policy_version: 1 as const,
  };
  const parsed = parsePubchiAnswerV1(result);
  log.info(
    {
      event: "pubchi_ask",
      nlq_ms: nlqMs,
      brain_ms: brainMs,
      total_ms: Math.round(performance.now() - started),
      tools: result.tool_trace_summary.tools,
      evidence_count: evidenceItems.length,
      brain_evidence_truncated: brainEvidenceTruncated,
      summary_source: summarySource,
      brain_finish_reason: brainGeneration?.finishReason ?? null,
      brain_prompt_tokens: brainGeneration?.usage?.promptTokens ?? null,
      brain_completion_tokens: brainGeneration?.usage?.completionTokens ?? null,
      brain_reasoning_tokens: brainGeneration?.usage?.reasoningTokens ?? null,
      ...(summaryForm ? { summary_form: summaryForm } : {}),
      ...(summarySource === "fallback_brain_error" && brainError ? brainError : {}),
      budget_reserved: opts.budgetReserved ?? null,
      budget_settled: Math.max(1, consumedTokens),
    },
    "pubchi ask",
  );
  if (!parsed.ok) {
    return {
      ok: false,
      code: "SCHEMA_INVALID",
      stage: "query",
      cause: parsed.code,
      timings: { nlq_ms: nlqMs, brain_ms: brainMs },
      settlementTokens: consumedTokens,
    };
  }
  return {
    ok: true,
    result: parsed.value,
    timings: { nlq_ms: nlqMs, brain_ms: brainMs },
    settlementTokens:
      summarySource === "deterministic" || summarySource === "deterministic_rejected" || screenedEvidence.length === 0
        ? Math.max(1, consumedTokens)
        : Math.max(1, consumedTokens),
  };
}

export { TOOL_NAMES };
