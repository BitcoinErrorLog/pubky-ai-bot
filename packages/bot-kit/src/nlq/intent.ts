/**
 * Intent classification *mechanism*. Regex tables are injected by the caller
 * (Jeb keeps its copy). Routing order is fixed so Jeb + Kit stay byte-identical.
 */

export const INTENTS = [
  "answer",
  "summarize",
  "explain_pubky",
  "research_pubky",
  "research_web",
  "evidence_map",
  "find",
  "compare",
  "translate",
  "decline",
  "ignore",
] as const;

export type Intent = (typeof INTENTS)[number];

export type IntentRegexTables = {
  decline: RegExp;
  declineMnemonicAsk: RegExp;
  summarize: RegExp;
  explain: RegExp;
  researchPubky: RegExp;
  researchPubkyPhrase: RegExp;
  researchWeb: RegExp;
  currentEvents: RegExp;
  evidence: RegExp;
  find: RegExp;
  compare: RegExp;
  translate: RegExp;
};

export type AllowedTool =
  | "get_post"
  | "get_thread"
  | "get_user"
  | "get_user_tags"
  | "search_posts_by_tag"
  | "get_post_replies"
  | "search_posts"
  | "scout_get_thread"
  | "get_identity_summary"
  | "get_topic_brief"
  | "get_what_changed"
  | "get_related_posts"
  | "get_relationship"
  | "get_tag_landscape"
  | "get_emerging_topics"
  | "get_debate_map"
  | "query_graph"
  | "search_users_by_name"
  | "rank_users"
  | "recommend_follows"
  | "stale_follows"
  | "follow_path"
  | "trust_view"
  | "top_posts"
  | "mentions_of"
  | "profile_card"
  | "search_web";

export const SCOUT_TOOLS: AllowedTool[] = [
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
];

export const NEXUS_READ: AllowedTool[] = [
  "get_post",
  "get_thread",
  "get_user",
  "get_user_tags",
  "search_posts_by_tag",
  "get_post_replies",
];

/** Full read catalog. Intent never strips tools; it only shapes prompt guidance. */
export const FULL_TOOLS: AllowedTool[] = [...NEXUS_READ, ...SCOUT_TOOLS, "search_web"];

export function classifyIntent(
  opts: { text: string; authorIsBot: boolean; isSelf: boolean },
  tables: IntentRegexTables,
): Intent {
  if (opts.isSelf || opts.authorIsBot) return "ignore";
  const t = opts.text.trim();
  if (!t) return "ignore";
  if (tables.decline.test(t) || tables.declineMnemonicAsk.test(t)) return "decline";
  if (tables.translate.test(t)) return "translate";
  if (tables.researchPubky.test(t) || tables.researchPubkyPhrase.test(t)) return "research_pubky";
  if (tables.evidence.test(t)) return "evidence_map";
  if (tables.find.test(t)) return "find";
  if (tables.researchWeb.test(t) || tables.currentEvents.test(t)) return "research_web";
  if (tables.summarize.test(t)) return "summarize";
  if (tables.explain.test(t)) return "explain_pubky";
  if (tables.compare.test(t)) return "compare";
  return "answer";
}

export function toolsForIntent(intent: Intent): AllowedTool[] {
  if (intent === "ignore" || intent === "decline") return [];
  return [...FULL_TOOLS];
}
