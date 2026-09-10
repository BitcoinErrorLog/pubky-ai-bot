import { Z32 } from "../types.js";
import { getActiveScoutSchema, getScoutSchemaSource } from "../scout/schema-cache.js";
import { graphIndex, type ScoutGraph } from "../scout/schema-model.js";
import type { ScoutClient } from "../scout/client.js";
import { classifyIntent, toolsForIntent, type Intent, type IntentRegexTables } from "./intent.js";
import { validateToolAgainstSchema } from "./tool-deps.js";
import type { AllowedTool } from "./intent.js";
import type { NlqPlannedCall, NlqRequest, NlqScope } from "./types.js";

const POST_URI = /pubky:\/\/[a-z0-9]{52}\/pub\/pubky\.app\/posts\/[A-Z0-9]{13}/i;
const APP_POST_URI = /https:\/\/(?:pubky\.app|bots\.pubky\.app)\/post\/([a-z0-9]{52})\/([A-Z0-9]{13})/i;
const REL_TOKEN = /\b([A-Z][A-Z0-9_]{2,})\b/g;
const REL_NOISE = new Set([
  "WHO",
  "WHAT",
  "THE",
  "FOR",
  "AND",
  "THIS",
  "THAT",
  "SHOW",
  "LIST",
  "ALL",
  "WITH",
  "FROM",
  "DOES",
  "USER",
  "POST",
  "FILE",
  "HOW",
  "ARE",
  "NOT",
  "CAN",
  "YOU",
  "HAS",
  "HAVE",
  "ANY",
  "WAS",
  "WERE",
  "DID",
  "GET",
]);

export type PlannerFailure =
  | { ok: false; kind: "schema_unavailable"; reason: string }
  | { ok: false; kind: "schema_unsupported"; reason: string }
  | { ok: false; kind: "guard_rejected"; reason: string }
  | { ok: false; kind: "declined"; reason: string; intent: Intent }
  | { ok: false; kind: "ignored"; reason: string; intent: Intent }
  | { ok: false; kind: "unsupported"; reason: string; intent: Intent };

export type PlannerSuccess = {
  ok: true;
  intent: Intent;
  schema: ScoutGraph;
  planned: NlqPlannedCall[];
};

export type PlanResult = PlannerSuccess | PlannerFailure;

export function loadPlannerSchema(_client?: Pick<ScoutClient, "schema">): ScoutGraph | null {
  if (getScoutSchemaSource() !== "live") return null;
  return getActiveScoutSchema();
}

export function namedRelTypesNotInSchema(question: string, schema: ScoutGraph): string[] {
  const idx = graphIndex(schema);
  const found: string[] = [];
  for (const m of question.matchAll(REL_TOKEN)) {
    const name = m[1];
    if (REL_NOISE.has(name)) continue;
    if (idx.labels.has(name)) continue;
    if (!idx.relTypes.has(name)) found.push(name);
  }
  return [...new Set(found)];
}

function extractPubkys(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\b[a-z0-9]{52}\b/g)) {
    if (!Z32.test(m[0]) || seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push(m[0]);
  }
  return out;
}

function extractPostUri(text: string): string | undefined {
  const direct = text.match(POST_URI)?.[0];
  if (direct) return direct;
  const app = text.match(APP_POST_URI);
  return app ? `pubky://${app[1]}/pub/pubky.app/posts/${app[2]}` : undefined;
}

function explicitSince(text: string, now: number): number {
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/)?.[0];
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : now - 24 * 60 * 60 * 1000;
}

function looksLikeCypher(text: string): boolean {
  const t = text.trim();
  return /^(MATCH|OPTIONAL\s+MATCH|WITH|UNWIND|RETURN)\b/i.test(t);
}

export function isPubchiOwnerTagsQuestion(text: string): boolean {
  const normalized = text.trim().replace(/[?!.,;:]+$/g, "").replace(/\s+/g, " ");
  return /^(?:who tagged me|has anyone tagged me|did anyone tag me|who has tagged me|who's tagged me|am i tagged|what am i tagged as|how am i tagged|what tags do i have|my tags|tags on me|any new tags on me|show me my tags|which tags have people given me)$/i.test(
    normalized,
  );
}

function topicFrom(text: string, pubchiMode = false): string | undefined {
  const quoted = text.match(/["“]([^"”]{1,80})["”]/);
  if (quoted?.[1]) return quoted[1].trim();
  const tagged = text.match(/#([a-zA-Z0-9_-]{1,20})/);
  if (tagged?.[1]) return tagged[1];
  const taggedWord = pubchiMode ? text.match(/\btagged?\s+([a-zA-Z0-9_-]{2,40})\b/i) : null;
  if (taggedWord?.[1] && !/^(me|as|this|that|people)$/i.test(taggedWord[1])) return taggedWord[1];
  const topicStopWords = /^(their|my|your|his|her|its|our|this|that|these|those|the|a|an|people|users|accounts|posts?|profiles?|graph)$/i;
  const about = text.match(/\b(?:about|topic)\s+([a-zA-Z0-9_-]{2,40})\b/i);
  if (about?.[1] && !topicStopWords.test(about[1])) return about[1];
  const on = text.match(/\bon\s+([a-zA-Z0-9_-]{2,40})\b(?!\s+(?:posts?|profile|feed|network)\b)/i);
  if (on?.[1] && !topicStopWords.test(on[1])) return on[1];
  return undefined;
}

function withScope(args: Record<string, unknown>, scope?: NlqScope): Record<string, unknown> {
  const next = { ...args };
  if (scope?.time_range) next.time_range = scope.time_range;
  if (scope?.graph_scope) next.graph_scope = scope.graph_scope;
  return next;
}

const PUBLIC_TOPIC_TOOLS = new Set<AllowedTool>([
  "get_topic_brief",
  "get_emerging_topics",
  "top_posts",
  "get_tag_landscape",
  "get_debate_map",
  "search_posts",
]);

function asksForFollowedGraph(question: string): boolean {
  return /\b(?:from|among|by)\s+(?:people|users|accounts)\s+i\s+follow\b|\bpeople\s+i\s+follow\b|\bmy\s+following\b/i.test(
    question,
  );
}

export function scopeForTool(tool: AllowedTool, question: string, scope?: NlqScope): NlqScope | undefined {
  if (!scope) return undefined;
  if (PUBLIC_TOPIC_TOOLS.has(tool) && !asksForFollowedGraph(question)) {
    return scope.time_range ? { time_range: scope.time_range } : undefined;
  }
  return scope;
}

function withTopicScope(
  args: Record<string, unknown>,
  question: string,
  scope?: NlqScope,
): Record<string, unknown> {
  return withScope(args, scopeForTool("get_topic_brief", question, scope));
}

function pickTool(opts: {
  question: string;
  intent: Intent;
  allow: Set<AllowedTool>;
  asker?: string;
  scope?: NlqScope;
  rawEnabled: boolean;
  pubchiMode?: boolean;
  nowMs?: number;
}): NlqPlannedCall | { raw: string } | null {
  const q = opts.question;
  const pubkys = extractPubkys(q);
  const uri = extractPostUri(q);
  const pubchiMode = opts.pubchiMode === true;
  const topic = topicFrom(q, pubchiMode);
  const allow = (t: AllowedTool) => opts.allow.has(t);
  const rankScope = opts.scope?.time_range
    ? opts.scope
    : {
        ...(opts.scope ?? {}),
        time_range: {
          since: (opts.nowMs ?? Date.now()) - 30 * 24 * 60 * 60 * 1000,
          until: opts.nowMs ?? Date.now(),
        },
      };

  if (opts.intent === "summarize_thread" && !uri) return null;
  if (uri && allow("scout_get_thread") && (/\bthread\b/i.test(q) || opts.intent === "summarize_thread")) {
    return { tool: "scout_get_thread", args: { uri } };
  }

  if (pubchiMode && opts.intent === "what_did_i_miss" && allow("get_what_did_i_miss") && opts.asker) {
    return {
      tool: "get_what_did_i_miss",
      args: { owner: opts.asker, since: explicitSince(q, opts.nowMs ?? Date.now()), until: opts.nowMs ?? Date.now(), limit: 35 },
    };
  }

  if (looksLikeCypher(q)) {
    if (!opts.rawEnabled) return { raw: q };
    if (allow("query_graph")) return { tool: "query_graph", args: { cypher: q.trim() } };
    return { raw: q };
  }

  if (/\bfollow(?:s|ed|ing)?\s+path\b|\bhow am i connected\b|\bwithin\s+\d\s*hop/i.test(q) && pubkys.length >= 2 && allow("follow_path")) {
    return { tool: "follow_path", args: { a: pubkys[0], b: pubkys[1] } };
  }
  if (pubchiMode && /\brecommend(?:ed)?(?:\s+follows?)?\b|\bwho should i follow\b/i.test(q) && allow("recommend_follows")) {
    const pubky = pubkys[0] ?? opts.asker;
    if (pubky) return { tool: "recommend_follows", args: { pubky } };
  }
  if (pubchiMode && /\bstale\s+follows?\b|\b(?:gone|going)\s+quiet\b/i.test(q) && allow("stale_follows")) {
    const pubky = pubkys[0] ?? opts.asker;
    if (pubky) return { tool: "stale_follows", args: { pubky } };
  }
  if (pubchiMode && /\bmost followed\b|\btop followers\b|\bhighest follower\b/i.test(q) && allow("rank_users")) {
    return { tool: "rank_users", args: withScope({ metric: "followers", order: "desc" }, opts.scope) };
  }
  if (
    pubchiMode &&
    /\bmost tagged\b|\bmost tags\b|\bgets tagged the most\b|\breceived the most tags\b/i.test(q) &&
    allow("rank_users")
  ) {
    return {
      tool: "rank_users",
      args: withScope(
        { metric: "tags_received", order: "desc", limit: 10 },
        rankScope,
      ),
    };
  }
  if (
    pubchiMode &&
    /\bwho tags the most\b|\bmost active taggers\b|\btop taggers\b/i.test(q) &&
    (!topic || !/\b(?:saying|posts?|threads?)\b/i.test(q)) &&
    allow("rank_users")
  ) {
    return {
      tool: "rank_users",
      args: withScope(
        { metric: "tags_applied", order: "desc", limit: 10 },
        rankScope,
      ),
    };
  }
  if (pubchiMode && isPubchiOwnerTagsQuestion(q) && opts.asker && allow("get_user_tags")) {
    return { tool: "get_user_tags", args: { pubky: opts.asker } };
  }
  if (/\btrust_view\b|\bin my (?:network|graph)\b|\bwho (?:supports|disputes)\b|\bevidence map\b/i.test(q) ||
      (pubchiMode && /\bwithin\s+\d\s*hops?\b/i.test(q))) {
    if (!allow("trust_view")) return null;
    const asker = opts.asker ?? pubkys[0];
    const target = pubkys.find((p) => p !== asker) ?? pubkys[0];
    if (asker && (target || topic)) {
      return {
        tool: "trust_view",
        args: target && !topic ? { asker, target } : { asker, topic: topic ?? "pubky" },
      };
    }
  }
  if (/\bmentions?\s+of\b|\bwho mentioned\b/i.test(q) && pubkys[0] && allow("mentions_of")) {
    return { tool: "mentions_of", args: withScope({ pubky: pubkys[0] }, opts.scope) };
  }
  if (/\bprofile(?:\s+card)?\b|\baccount snapshot\b/i.test(q) && pubkys[0] && allow("profile_card")) {
    return { tool: "profile_card", args: { pubky: pubkys[0], ...(opts.asker ? { asker: opts.asker } : {}) } };
  }
  if (pubchiMode && topic && /\b(top taggers?|saying|posts?|threads?)\b/i.test(q) && allow("get_topic_brief")) {
    return { tool: "get_topic_brief", args: withTopicScope({ topic }, q, opts.scope) };
  }
  if (pubchiMode && /\b(?:emerging|hot topics?|trending tags?|tags?\s+(?:are\s+)?trending)\b/i.test(q) && allow("get_emerging_topics")) {
    return { tool: "get_emerging_topics", args: withScope({}, scopeForTool("get_emerging_topics", q, opts.scope)) };
  }
  if (/\b(trending|most liked|popular posts|top posts)\b/i.test(q) || (pubchiMode && /\bmost active threads?\b/i.test(q))) {
    if (!allow("top_posts")) return null;
    return { tool: "top_posts", args: withScope({ metric: "replies", ...(topic ? { topic } : {}) }, scopeForTool("top_posts", q, opts.scope)) };
  }
  if (/\bwho tagged\b|\btag landscape\b/i.test(q) && (topic || pubkys[0] || pubchiMode) && allow("get_tag_landscape")) {
    return { tool: "get_tag_landscape", args: withScope({ tag: topic ?? "pubky" }, scopeForTool("get_tag_landscape", q, opts.scope)) };
  }
  if (/\bdebate\b/i.test(q) && allow("get_debate_map")) {
    return { tool: "get_debate_map", args: withScope({ topic: topic ?? "pubky" }, scopeForTool("get_debate_map", q, opts.scope)) };
  }
  if (/\bwhat(?:'s| is)? changed\b|\bwhat changed\b/i.test(q) && allow("get_what_changed")) {
    const since = opts.scope?.time_range?.since ?? (opts.nowMs ?? Date.now()) - 7 * 24 * 60 * 60 * 1000;
    return { tool: "get_what_changed", args: { topic: topic ?? "pubky", since } };
  }
  if (/\bfollow(?:ers?|s|ing)?\b/i.test(q) && pubkys[0] && allow("get_identity_summary")) {
    return { tool: "get_identity_summary", args: withScope({ pubky: pubkys[0] }, opts.scope) };
  }
  if (opts.intent === "compare" && pubkys.length >= 2 && allow("get_relationship")) {
    return { tool: "get_relationship", args: { pubky_a: pubkys[0], pubky_b: pubkys[1] } };
  }
  if (/\bfind users?\b|\bsearch users?\b/i.test(q) && allow("search_users_by_name")) {
    const name = q.replace(/\bfind users?\b|\bsearch users?\b/gi, "").replace(/[^\w\s-]/g, " ").trim().slice(0, 80);
    if (name) return { tool: "search_users_by_name", args: { name } };
  }
  if (/\bfind posts?\b|\bsearch posts?\b/i.test(q) && allow("search_posts")) {
    const query = topic ?? (q.replace(/\bfind posts?\b|\bsearch posts?\b/gi, "").trim().slice(0, 200) || "pubky");
    return { tool: "search_posts", args: withScope({ query }, scopeForTool("search_posts", q, opts.scope)) };
  }
  if (uri && allow("get_post")) {
    return { tool: "get_post", args: { uri } };
  }
  if (pubkys[0] && allow("get_identity_summary") && (opts.intent === "research_pubky" || opts.intent === "find" || opts.intent === "answer")) {
    return { tool: "get_identity_summary", args: withScope({ pubky: pubkys[0] }, opts.scope) };
  }
  if (opts.intent === "research_pubky" && allow("get_emerging_topics") && !pubkys[0]) {
    return { tool: "get_emerging_topics", args: withScope({}, opts.scope) };
  }
  if (topic && allow("get_topic_brief")) {
    return { tool: "get_topic_brief", args: withTopicScope({ topic }, q, opts.scope) };
  }
  return null;
}

export async function planNlq(
  req: NlqRequest,
  opts: {
    tables: IntentRegexTables;
    client: Pick<ScoutClient, "schema">;
    rawEnabled: boolean;
    authorIsBot?: boolean;
    isSelf?: boolean;
    nowMs?: number;
  },
): Promise<PlanResult> {
  const intent = classifyIntent(
    { text: req.question, authorIsBot: opts.authorIsBot === true, isSelf: opts.isSelf === true },
    opts.tables,
  );
  if (intent === "ignore") {
    return { ok: false, kind: "ignored", reason: "mention is ignored", intent };
  }
  if (intent === "decline") {
    return { ok: false, kind: "declined", reason: "request is declined by policy", intent };
  }

  const schema = loadPlannerSchema();
  if (!schema || getScoutSchemaSource() !== "live") {
    return {
      ok: false,
      kind: "schema_unavailable",
      reason: "Scout schema is unavailable; the planner will not guess from a golden fallback",
    };
  }

  if (!looksLikeCypher(req.question)) {
    const unknownRels = namedRelTypesNotInSchema(req.question, schema);
    if (unknownRels.length > 0) {
      return {
        ok: false,
        kind: "schema_unsupported",
        reason: `question names relationship type(s) not in the active schema: ${unknownRels.join(", ")}`,
      };
    }
  }

  const allow = new Set(toolsForIntent(intent));
  const picked = pickTool({
    question: req.question,
    intent,
    allow,
    asker: req.asker,
    scope: req.scope,
    rawEnabled: opts.rawEnabled,
    pubchiMode: req.pubchiMode,
    nowMs: opts.nowMs ?? req.now_ms,
  });

  if (picked && "raw" in picked) {
    return {
      ok: false,
      kind: "guard_rejected",
      reason: "raw cypher disabled",
    };
  }
  if (!picked) {
    return {
      ok: false,
      kind: "unsupported",
      reason: "no allowlisted typed tool matches this question",
      intent,
    };
  }

  const check = validateToolAgainstSchema(picked.tool, schema);
  if (!check.ok) {
    const bits = [
      ...check.missing.labels.map((l) => `label:${l}`),
      ...check.missing.relTypes.map((r) => `rel:${r}`),
      ...check.missing.properties.map((p) => `prop:${p}`),
    ];
    return {
      ok: false,
      kind: "schema_unsupported",
      reason: `planned tool ${picked.tool} depends on schema elements that are missing: ${bits.join(", ")}`,
    };
  }

  return { ok: true, intent, schema, planned: [picked] };
}
