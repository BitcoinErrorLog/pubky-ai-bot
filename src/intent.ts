import {
  classifyIntent as classifyIntentWithTables,
  toolsForIntent,
  FULL_TOOLS,
  NEXUS_READ,
  SCOUT_TOOLS,
  INTENTS,
  type AllowedTool,
  type Intent,
  type IntentRegexTables,
} from "./bot-kit/nlq/intent.js";

export {
  toolsForIntent,
  FULL_TOOLS,
  NEXUS_READ,
  SCOUT_TOOLS,
  INTENTS,
  type AllowedTool,
  type Intent,
  type IntentRegexTables,
};

export const DECLINE =
  /\b(private key|seed phrase|ssn|social security|child porn|how to make a bomb)\b/i;
export const DECLINE_MNEMONIC_ASK =
  /\b(?:(?:your|my|the)\s+mnemonic|send\s+me\s+(?:a\s+|the\s+|your\s+)?mnemonic|dump\s+(?:the\s+|your\s+)?mnemonic|reveal\s+(?:the\s+|your\s+)?mnemonic|print\s+(?:the\s+|your\s+)?mnemonic)\b/i;
export const SUMMARIZE = /\bsummar(y|ise|ize)\b/i;
export const EXPLAIN = /\bexplain\b.*\bpubky\b|\bwhat is pubky\b/i;
export const RESEARCH_PUBKY =
  /\b(scout|graph|nexus|trending|emerging|popular|hot topics?|who tagged|follow(?:ers?|s|ing)?|recommend(?:ed)?(?:\s+follows?)?)\b/i;
export const RESEARCH_PUBKY_PHRASE =
  /\bthis week\b|\bwhat'?s happening\b|\bwhat are people talking about\b|\bwho (?:should i |to )?follow\b/i;
export const RESEARCH_WEB = /\b(search the web|look up online|http)\b/i;
export const CURRENT_EVENTS =
  /\b(is it true that|did\b.+\bhappen\b|latest|news|price)\b|\b(20(2[5-9]|[3-9]\d))\b/i;
export const EVIDENCE = /\b(evidence map|fact.?check|who (supports|disputes))\b/i;
export const FIND = /\bfind (posts?|users?|tags?)\b/i;
export const COMPARE = /\bcompar(e|ing)\b/i;
export const TRANSLATE =
  /\b(translat(?:e|es|ed|ing|ion)|traduz(?:ir|a|o|iu)?|traduc(?:e|ir|ci[oó]n)?)\b|\bwhat does this say in\b|[uü]bersetz/i;

/** Jeb regex copy injected into the Kit classifier. */
export const INTENT_REGEX_TABLES: IntentRegexTables = {
  decline: DECLINE,
  declineMnemonicAsk: DECLINE_MNEMONIC_ASK,
  summarize: SUMMARIZE,
  explain: EXPLAIN,
  researchPubky: RESEARCH_PUBKY,
  researchPubkyPhrase: RESEARCH_PUBKY_PHRASE,
  researchWeb: RESEARCH_WEB,
  currentEvents: CURRENT_EVENTS,
  evidence: EVIDENCE,
  find: FIND,
  compare: COMPARE,
  translate: TRANSLATE,
};

export function classifyIntent(opts: {
  text: string;
  authorIsBot: boolean;
  isSelf: boolean;
}): Intent {
  return classifyIntentWithTables(opts, INTENT_REGEX_TABLES);
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
      return "Call trust_view with asker set to the mention author for the claim's subject or topic. Report global and asker-graph claim counts with both labels; never a single verdict. If the asker's graph_count series is all zeros, say the follow graph is empty.";
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
