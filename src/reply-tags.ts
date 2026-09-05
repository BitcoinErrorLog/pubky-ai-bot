import { SCOUT_TOOLS } from "./intent.js";
import type { Transport } from "./homeserver.js";
import {
  MAX_REPLY_TAGS,
  applyTags as kitApplyTags,
  artifactTagObject as kitArtifactTagObject,
  deleteArtifactTag as kitDeleteArtifactTag,
  isValidOpenTagLabel,
  isValidTagLabel,
  proposeOpenTags,
  putArtifactTag as kitPutArtifactTag,
  putReplyTags as kitPutReplyTags,
  suggestTags,
  toolsUsedInTrace,
  type ApplyTagsDeps,
  type ApplyTagsResult,
} from "./bot-kit/tags/index.js";

/**
 * Ticket 12c (plan §4.4b): category self-tags on Jeb's own replies.
 *
 * Open vocabulary: style + denylist + secret-scrubber. Historical labels
 * remain valid open tags and are still used as deterministic fallbacks.
 */
export const REPLY_TAG_VOCABULARY = [
  "answer",
  "pubky",
  "bitkit",
  "paykit",
  "graph",
  "evidence-map",
  "summary",
  "declined",
] as const;

export type ReplyCategory = string;

/** One-line meaning for well-known reply tags. Published in How I work. */
export const REPLY_TAG_MEANINGS: Record<string, string> = {
  answer: "a direct answer; omitted when a more specific base label applies",
  pubky: "the answer relied on Pubky product sources",
  bitkit: "the answer relied on Bitkit sources",
  paykit: "the answer relied on Paykit sources",
  graph: "a Scout graph tool was used",
  "evidence-map": "supporting and disputing sources were mapped for a claim",
  summary: "a thread or disagreement was summarized",
  declined: "the request was refused (secrets, private data, or policy)",
};

/** Well-known artifact labels. Open vocabulary also allows any policy-valid tag. */
export const ARTIFACT_TAG_VOCAB = ["sources-cited", "debate", "release-notes"] as const;

export type ArtifactTagLabel = string;

export const ARTIFACT_TAG_MEANINGS: Record<string, string> = {
  "sources-cited": "the post cites public sources",
  debate: "the post sits in a disagreement cluster",
  "release-notes": "the post is release or changelog notes",
};

export function isArtifactTagLabel(label: string): boolean {
  return isValidOpenTagLabel(label);
}

export { MAX_REPLY_TAGS, isValidTagLabel, toolsUsedInTrace, suggestTags, proposeOpenTags, isValidOpenTagLabel };

/** Tag PUT failures are retried on subsequent publisher ticks up to this cap. */
export const TAG_MAX_ATTEMPTS = 3;

export const PRODUCT_CATEGORIES = ["pubky", "bitkit", "paykit"] as const;

/** Maps a knowledge-source product id to its category label, if any. */
export function productCategory(product: string): string | null {
  const p = product.toLowerCase();
  if (p.includes("bitkit")) return "bitkit";
  if (p.includes("paykit")) return "paykit";
  if (p.startsWith("pubky") || p === "pkarr" || p.startsWith("nexus") || p === "slashtags") return "pubky";
  return null;
}

/**
 * Deterministic fallback labels (intent + products + graph). Open-vocab
 * callers should prefer `proposeOpenTags` with model + Nexus candidates.
 */
export function deriveCategories(opts: {
  intent: string;
  toolTrace?: unknown[];
  products?: string[];
  proposed?: string[];
  nexusTags?: string[];
  personTokens?: string[];
}): string[] {
  const products = (opts.products ?? [])
    .map((p) => productCategory(p))
    .filter((x): x is string => x !== null);
  if (opts.proposed?.length || opts.nexusTags?.length) {
    return proposeOpenTags({
      intent: opts.intent,
      toolTrace: opts.toolTrace ?? [],
      products,
      proposed: opts.proposed,
      nexusTags: opts.nexusTags,
      personTokens: opts.personTokens,
      graphTools: SCOUT_TOOLS,
    });
  }
  return suggestTags({
    intent: opts.intent,
    toolTrace: opts.toolTrace ?? [],
    products,
    vocab: REPLY_TAG_VOCABULARY,
    precedence: PRODUCT_CATEGORIES,
    graphTools: SCOUT_TOOLS,
  });
}

export async function putReplyTags(
  transport: Transport,
  replyUri: string,
  labels: string[],
  opts?: { stopping?: () => boolean },
): Promise<string[]> {
  return kitPutReplyTags(transport, replyUri, labels, opts);
}

export function artifactTagObject(
  botPk: string,
  postUri: string,
  label: string,
): { path: string; url: string; json: unknown } {
  return kitArtifactTagObject(botPk, postUri, label);
}

export async function putArtifactTag(transport: Transport, postUri: string, label: string): Promise<string> {
  return kitPutArtifactTag(transport, postUri, label);
}

export async function deleteArtifactTag(transport: Transport, postUri: string, label: string): Promise<string> {
  return kitDeleteArtifactTag(transport, postUri, label);
}

export async function applyTags(
  input: { targetUri: string; labels: string[]; mode: "self" | "artifact"; approvedBy?: string; personTokens?: string[] },
  deps: Omit<ApplyTagsDeps, "selfVocab" | "artifactVocab">,
): Promise<ApplyTagsResult> {
  return kitApplyTags(input, deps);
}
