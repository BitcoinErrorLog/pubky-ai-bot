import { NEXUS_READ, SCOUT_TOOLS } from "../intent.js";
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
const EXPLICIT_URL = /\b(?:https?:\/\/|www\.)\S+/i;
const HOSTNAME_SOURCE = "\\b[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+\\b";
const EXPLICIT_POST = /\b(?:posts?|threads?|repl(?:y|ies|ied))\b/i;
const EXPLICIT_TAGGER = /\b(?:taggers?|tagged|tagging|who tags)\b/i;
const EXPLICIT_NETWORK =
  /\b(?:trending|emerging|popular|hot topics?|followers?|following|recommend(?:ed)? follows?|what['’]s happening|what are people talking about|who (?:should i |to )?follow|in my network|who mentioned me|mentions of me|network activity|graph)\b/i;

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
 * Deterministic mention routing. Product, portal, site, what-is, what's-new,
 * and status-of questions require search_knowledge first. Graph and tag tools
 * remain only when the question, with product names masked, asks about posts,
 * taggers, or network activity.
 */
export function routeKnowledgeQuestion(
  text: string,
  names: readonly string[] = corpusProductNames(),
): KnowledgeRoute {
  const question = text.trim();
  const patterns = productPatterns(names);
  const namesProduct = patterns.some((pattern) => pattern.test(question));
  const requireKnowledge =
    namesProduct
    || mentionsHostname(question)
    || BOARD_OR_PORTAL.test(question)
    || WHAT_IS.test(question)
    || WHATS_NEW.test(question)
    || STATUS_OF.test(question);
  const residual = maskProducts(question, patterns);
  const allowGraphTools =
    EXPLICIT_POST.test(residual)
    || EXPLICIT_TAGGER.test(residual)
    || EXPLICIT_NETWORK.test(residual);
  return { requireKnowledge, allowGraphTools };
}
