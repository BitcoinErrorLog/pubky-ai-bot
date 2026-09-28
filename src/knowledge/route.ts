import { NEXUS_READ, SCOUT_TOOLS, type Intent } from "../intent.js";
import { ancestorsNewestFirst, clipContent, type ChainPost } from "../context.js";
import { corpusProductNames } from "./corpus-products.js";

/** Nexus read tools and Scout graph/tag tools. search_knowledge and search_web stay outside this set. */
export const GRAPH_TAG_TOOLS: readonly string[] = [...NEXUS_READ, ...SCOUT_TOOLS];

export type KnowledgeRoute = {
  /** Call search_knowledge before any other tool and before a final answer. */
  requireKnowledge: boolean;
  /** Graph and tag tools stay available after the knowledge requirement. */
  allowGraphTools: boolean;
};

const WHAT_IS = /\bwhat is\b/i;
const WHATS_NEW = /\bwhat['’]s new\b/i;
const STATUS_OF = /\bstatus of\b/i;
const BOARD_OR_PORTAL = /\b(?:boards?|portals?)\b/i;
const SMALL_TALK = /^(?:@jeb[\s,]*)?(?:(?:hi|hello|hey)(?:\s+(?:jeb|there))?|thanks|thank you|ok(?:ay)?|got it|good (?:morning|evening))[!.?\s]*$/i;
const EXPLICIT_URL = /\b(?:https?:\/\/|www\.)\S+/i;
const HOSTNAME_SOURCE = "\\b[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+\\b";
const EXPLICIT_POST =
  /\b(?:(?:find|search|show|list|compare|summarize|analyse|analyze|rank)\b.{0,50}\b(?:posts?|threads?|repl(?:y|ies))|(?:posts?|threads?|repl(?:y|ies))\s+(?:about|by|from|tagged|mentioning|on)\b)\b/i;
const EXPLICIT_TAGGER = /\b(?:taggers?|tagged|tagging|who tags)\b/i;
const EXPLICIT_PEOPLE = /\b(?:who\b|which (?:people|users?)\b)/i;
const EXPLICIT_NETWORK =
  /\b(?:scout|nexus|trending|emerging|popular|hot topics?|followers?|following|recommend(?:ed)? follows?|what['’]s happening|what are people talking about|who (?:should i |to )?follow|in my network|who mentioned me|mentions of me|network activity|graph)\b/i;
const NEGATED_GRAPH_REQUEST =
  /\b(?:no one|nobody|not|didn['’]t|doesn['’]t|don['’]t)\b.{0,50}\b(?:graph|posts?|people|tags?|network activity)\b/gi;
const CONTEXTUAL_POST_REFERENCE = /\b(?:parent|original)(?:\s+user)?\s+(?:post|request|question)\b/gi;
const PARENT_CONTEXT_REQUEST =
  /\b(?:help|support|explain|answer|respond|reread|re-read)\b[\s\S]{0,180}\b(?:parent|original|post|request|user|he|she|they|him|her|them|this|that)\b|\b(?:parent|original)\b[\s\S]{0,180}\b(?:post|request|user|question)\b/i;
const JEB_MENTION = /(?:^|\s)@jeb\b/i;

function isHostname(token: string): boolean {
  const stripped = token.replace(/[.,:;!?)]+$/g, "");
  if (!/[a-z]/i.test(stripped)) return false;
  const labels = stripped.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i.test(label))) return false;
  const tld = labels[labels.length - 1] ?? "";
  return /^[a-z]{2,}$/i.test(tld);
}

function mentionsHostname(text: string): boolean {
  if (EXPLICIT_URL.test(text)) return true;
  for (const match of text.matchAll(new RegExp(HOSTNAME_SOURCE, "gi"))) {
    if (isHostname(match[0])) return true;
  }
  return false;
}

function namePattern(name: string): RegExp | null {
  const parts = name.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length >= 2);
  if (parts.join(" ").length < 3) return null;
  const body = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^a-z0-9]+");
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, "i");
}

function productPatterns(names: readonly string[]): RegExp[] {
  const unique = new Map<string, RegExp>();
  for (const name of names) {
    const key = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(" ");
    if (unique.has(key)) continue;
    const pattern = namePattern(key);
    if (pattern) unique.set(key, pattern);
  }
  return [...unique.entries()]
    .sort((a, b) => b[0].length - a[0].length)
    .map((entry) => entry[1]);
}

function maskProducts(text: string, patterns: readonly RegExp[]): string {
  let masked = text;
  for (const pattern of patterns) {
    masked = masked.replace(new RegExp(pattern.source, "gi"), " ");
  }
  return masked;
}

/**
 * Deterministic mention routing. The classified intent supplies the broad
 * knowledge-first default; this layer only identifies explicit graph asks and
 * narrow small-talk/translation exclusions. Product and source signals remain
 * for callers that do not yet provide an intent.
 */
export function routeKnowledgeQuestion(
  text: string,
  names: readonly string[] = corpusProductNames(),
  intent?: Intent,
): KnowledgeRoute {
  const question = text.trim();
  const patterns = productPatterns(names);
  const namesProduct = patterns.some((pattern) => pattern.test(question));
  const residual = maskProducts(question, patterns);
  const graphRequest = residual
    .replace(NEGATED_GRAPH_REQUEST, " ")
    .replace(CONTEXTUAL_POST_REFERENCE, "context");
  const allowGraphTools =
    EXPLICIT_POST.test(graphRequest)
    || EXPLICIT_TAGGER.test(graphRequest)
    || EXPLICIT_PEOPLE.test(graphRequest)
    || EXPLICIT_NETWORK.test(graphRequest)
    || intent === "evidence_map"
    || intent === "find";
  const intentRequiresKnowledge =
    intent === "answer"
    || intent === "explain_pubky"
    || intent === "research_pubky"
    || intent === "compare";
  const requireKnowledge = intent !== "translate" && !SMALL_TALK.test(question) && !allowGraphTools && (
    intentRequiresKnowledge
    || namesProduct
    || mentionsHostname(question)
    || BOARD_OR_PORTAL.test(question)
    || WHAT_IS.test(question)
    || WHATS_NEW.test(question)
    || STATUS_OF.test(question)
  );
  return { requireKnowledge, allowGraphTools };
}

/**
 * Adds at most one bounded parent subject when a delegation explicitly points
 * back to it. Other Jeb-directed mentions are skipped so follow-ups reach the
 * original user's question rather than recursively searching prior commands.
 */
export function contextualKnowledgeQuery(
  mention: ChainPost,
  chain: readonly ChainPost[],
  botPk: string,
): string {
  const current = mention.content.trim();
  if (!PARENT_CONTEXT_REQUEST.test(current)) return current;
  const parent = ancestorsNewestFirst([...chain]).find((post) =>
    post.uri !== mention.uri
    && post.author !== botPk
    && !JEB_MENTION.test(post.content));
  if (!parent) return current;
  return `${current}\n\nParent post context:\n${clipContent(parent.content.trim())}`;
}
