export const INTENTS = [
  "answer",
  "summarize",
  "explain_pubky",
  "research_pubky",
  "research_web",
  "evidence_map",
  "find",
  "compare",
  "decline",
  "ignore",
] as const;

export type Intent = (typeof INTENTS)[number];

const DECLINE =
  /\b(private key|seed phrase|mnemonic|ssn|social security|child porn|how to make a bomb)\b/i;
const SUMMARIZE = /\bsummar(y|ise|ize)\b/i;
const EXPLAIN = /\bexplain\b.*\bpubky\b|\bwhat is pubky\b/i;
const RESEARCH_PUBKY = /\b(scout|graph|who tagged|followers of)\b/i;
const RESEARCH_WEB = /\b(search the web|look up online|http)\b/i;
const EVIDENCE = /\b(evidence map|fact.?check|who (supports|disputes))\b/i;
const FIND = /\bfind (posts?|users?|tags?)\b/i;
const COMPARE = /\bcompar(e|ing)\b/i;

export function classifyIntent(opts: {
  text: string;
  authorIsBot: boolean;
  isSelf: boolean;
}): Intent {
  if (opts.isSelf || opts.authorIsBot) return "ignore";
  const t = opts.text.trim();
  if (!t) return "ignore";
  if (DECLINE.test(t)) return "decline";
  if (SUMMARIZE.test(t)) return "summarize";
  if (EXPLAIN.test(t)) return "explain_pubky";
  if (EVIDENCE.test(t)) return "evidence_map";
  if (FIND.test(t)) return "find";
  if (COMPARE.test(t)) return "compare";
  if (RESEARCH_PUBKY.test(t)) return "research_pubky";
  if (RESEARCH_WEB.test(t)) return "research_web";
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
  | "search_users_by_name";

const SCOUT_TOOLS: AllowedTool[] = [
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
];

const NEXUS_READ: AllowedTool[] = [
  "get_post",
  "get_thread",
  "get_user",
  "get_user_tags",
  "search_posts_by_tag",
  "get_post_replies",
];

export function toolsForIntent(intent: Intent): AllowedTool[] {
  if (intent === "ignore" || intent === "decline") return [];
  if (intent === "summarize") return ["get_post", "get_thread", "get_post_replies"];
  if (intent === "explain_pubky") return ["get_post", "get_user"];
  if (intent === "research_web") return NEXUS_READ;
  if (
    intent === "research_pubky" ||
    intent === "find" ||
    intent === "compare" ||
    intent === "evidence_map" ||
    intent === "answer"
  ) {
    return [...NEXUS_READ, ...SCOUT_TOOLS];
  }
  return NEXUS_READ;
}

export const DECLINE_REPLY =
  "I can't help with that request. If you have a Pubky or public-thread question, ask again.";
