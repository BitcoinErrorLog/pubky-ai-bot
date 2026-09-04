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

const DECLINE =
  /\b(private key|seed phrase|mnemonic|ssn|social security|child porn|how to make a bomb)\b/i;
const SUMMARIZE = /\bsummar(y|ise|ize)\b/i;
const EXPLAIN = /\bexplain\b.*\bpubky\b|\bwhat is pubky\b/i;
const RESEARCH_PUBKY =
  /\b(scout|graph|nexus|trending|emerging|popular|hot topics?|who tagged|follow(?:ers?|s|ing)?|recommend(?:ed)?(?:\s+follows?)?)\b/i;
const RESEARCH_PUBKY_PHRASE =
  /\bthis week\b|\bwhat'?s happening\b|\bwhat are people talking about\b|\bwho (?:should i |to )?follow\b/i;
const RESEARCH_WEB = /\b(search the web|look up online|http)\b/i;
const CURRENT_EVENTS =
  /\b(is it true that|did\b.+\bhappen\b|latest|news|price)\b|\b(20(2[5-9]|[3-9]\d))\b/i;
const EVIDENCE = /\b(evidence map|fact.?check|who (supports|disputes))\b/i;
const FIND = /\bfind (posts?|users?|tags?)\b/i;
const COMPARE = /\bcompar(e|ing)\b/i;
const TRANSLATE =
  /\b(translat(?:e|es|ed|ing|ion)|traduz(?:ir|a|o|iu)?|traduc(?:e|ir|ci[oó]n)?)\b|\bwhat does this say in\b|[uü]bersetz/i;

export function classifyIntent(opts: {
  text: string;
  authorIsBot: boolean;
  isSelf: boolean;
}): Intent {
  if (opts.isSelf || opts.authorIsBot) return "ignore";
  const t = opts.text.trim();
  if (!t) return "ignore";
  if (DECLINE.test(t)) return "decline";
  if (TRANSLATE.test(t)) return "translate";
  if (RESEARCH_PUBKY.test(t) || RESEARCH_PUBKY_PHRASE.test(t)) return "research_pubky";
  if (EVIDENCE.test(t)) return "evidence_map";
  if (FIND.test(t)) return "find";
  if (RESEARCH_WEB.test(t) || CURRENT_EVENTS.test(t)) return "research_web";
  if (SUMMARIZE.test(t)) return "summarize";
  if (EXPLAIN.test(t)) return "explain_pubky";
  if (COMPARE.test(t)) return "compare";
  return "answer";
}

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

export function toolsForIntent(intent: Intent): AllowedTool[] {
  if (intent === "ignore" || intent === "decline") return [];
  return [...FULL_TOOLS];
}

export function intentGuidance(intent: Intent): string {
  switch (intent) {
    case "summarize":
      return "If the target is a thread/post, use get_thread/get_post_replies; if the target is the network or a time window, use get_emerging_topics/get_tag_landscape/get_what_changed.";
    case "explain_pubky":
      return "Prefer get_user/get_post plus Scout identity and topic tools; use get_emerging_topics when the question is about network activity.";
    case "research_pubky":
      return "Prefer Scout graph tools: get_emerging_topics, get_tag_landscape, get_what_changed, query_graph, get_identity_summary, get_relationship, recommend_follows, follow_path, trust_view, top_posts, mentions_of, profile_card. Trending/most liked/popular posts → top_posts (no likes in the graph). How am I connected → follow_path. 'In my network' claim counts → trust_view. Who mentioned me → mentions_of. Account snapshot → profile_card.";
    case "research_web":
      return "Prefer search_web for current external events; still use Scout/Nexus when the question is about Pubky network activity.";
    case "evidence_map":
      return "";
    case "find":
      return "Prefer search_posts, search_posts_by_tag, search_users_by_name, and query_graph.";
    case "compare":
      return "Use get_relationship, get_debate_map, get_identity_summary, and get_post as needed; do not drop graph tools.";
    case "translate":
      return "Fetch the parent or quoted post with get_post or get_thread and translate that text. Do not drop tools from the catalog.";
    case "answer":
      return "Pick tools from the full catalog that match the ask; do not claim a capability is missing if the matching tool is listed.";
    default:
      return "";
  }
}

export const DECLINE_REPLY =
  "I can't help with that request. If you have a Pubky or public-thread question, ask again.";
