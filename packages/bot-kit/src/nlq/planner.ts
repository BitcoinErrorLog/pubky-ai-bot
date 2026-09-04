import { Z32 } from "../types.js";
import { getActiveScoutSchema, getScoutSchemaSource } from "../scout/schema-cache.js";
import { graphIndex, type ScoutGraph } from "../scout/schema-model.js";
import type { ScoutClient } from "../scout/client.js";
import { classifyIntent, toolsForIntent, type Intent, type IntentRegexTables } from "./intent.js";
import { validateToolAgainstSchema } from "./tool-deps.js";
import type { AllowedTool } from "./intent.js";
import type { NlqPlannedCall, NlqRequest, NlqScope } from "./types.js";

const POST_URI = /pubky:\/\/[a-z0-9]{52}\/pub\/pubky\.app\/posts\/[A-Z0-9]{13}/i;
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
  return text.match(POST_URI)?.[0];
}

function looksLikeCypher(text: string): boolean {
  const t = text.trim();
  return /^(MATCH|OPTIONAL\s+MATCH|WITH|UNWIND|RETURN)\b/i.test(t);
}

function topicFrom(text: string): string | undefined {
  const quoted = text.match(/["“]([^"”]{1,80})["”]/);
  if (quoted?.[1]) return quoted[1].trim();
  const tagged = text.match(/#([a-zA-Z0-9_-]{1,20})/);
  if (tagged?.[1]) return tagged[1];
  const about = text.match(/\b(?:about|on|topic)\s+([a-zA-Z0-9_-]{2,40})\b/i);
  if (about?.[1] && !/^(the|this|that|user|post|graph)$/i.test(about[1])) return about[1];
  return undefined;
}

function withScope(args: Record<string, unknown>, scope?: NlqScope): Record<string, unknown> {
  const next = { ...args };
  if (scope?.time_range) next.time_range = scope.time_range;
  if (scope?.graph_scope) next.graph_scope = scope.graph_scope;
  return next;
}

function pickTool(opts: {
  question: string;
  intent: Intent;
  allow: Set<AllowedTool>;
  asker?: string;
  scope?: NlqScope;
  rawEnabled: boolean;
}): NlqPlannedCall | { raw: string } | null {
  const q = opts.question;
  const pubkys = extractPubkys(q);
  const uri = extractPostUri(q);
  const topic = topicFrom(q);
  const allow = (t: AllowedTool) => opts.allow.has(t);

  if (looksLikeCypher(q)) {
    if (!opts.rawEnabled) return { raw: q };
    if (allow("query_graph")) return { tool: "query_graph", args: { cypher: q.trim() } };
    return { raw: q };
  }

  if (/\bfollow(?:s|ed|ing)?\s+path\b|\bhow am i connected\b|\bwithin\s+\d\s*hop/i.test(q) && pubkys.length >= 2 && allow("follow_path")) {
    return { tool: "follow_path", args: { a: pubkys[0], b: pubkys[1] } };
  }
  if (/\brecommend(?:ed)?(?:\s+follows?)?\b/i.test(q) && pubkys[0] && allow("recommend_follows")) {
    return { tool: "recommend_follows", args: { pubky: pubkys[0] } };
  }
  if (/\bstale\s+follows?\b/i.test(q) && pubkys[0] && allow("stale_follows")) {
    return { tool: "stale_follows", args: { pubky: pubkys[0] } };
  }
  if (/\btrust_view\b|\bin my (?:network|graph)\b|\bwho (?:supports|disputes)\b|\bevidence map\b/i.test(q) && allow("trust_view")) {
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
  if (/\b(trending|most liked|popular posts|top posts)\b/i.test(q) && allow("top_posts")) {
    return { tool: "top_posts", args: withScope({ metric: "replies", ...(topic ? { topic } : {}) }, opts.scope) };
  }
  if (/\b(emerging|hot topics?)\b/i.test(q) && allow("get_emerging_topics")) {
    return { tool: "get_emerging_topics", args: withScope({}, opts.scope) };
  }
  if (/\bwho tagged\b|\btag landscape\b/i.test(q) && (topic || pubkys[0]) && allow("get_tag_landscape")) {
    return { tool: "get_tag_landscape", args: withScope({ tag: topic ?? "pubky" }, opts.scope) };
  }
  if (/\bdebate\b/i.test(q) && allow("get_debate_map")) {
    return { tool: "get_debate_map", args: withScope({ topic: topic ?? "pubky" }, opts.scope) };
  }
  if (/\bwhat(?:'s| is)? changed\b|\bwhat changed\b/i.test(q) && allow("get_what_changed")) {
    const since = opts.scope?.time_range?.since ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
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
    return { tool: "search_posts", args: withScope({ query }, opts.scope) };
  }
  if (uri && allow("scout_get_thread") && /\bthread\b/i.test(q)) {
    return { tool: "scout_get_thread", args: { uri } };
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
    return { tool: "get_topic_brief", args: withScope({ topic }, opts.scope) };
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
