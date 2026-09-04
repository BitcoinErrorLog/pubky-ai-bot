import { SCOUT_TOOLS } from "./intent.js";
import type { Transport } from "./homeserver.js";
import {
  MAX_REPLY_TAGS,
  applyTags as kitApplyTags,
  artifactTagObject as kitArtifactTagObject,
  deleteArtifactTag as kitDeleteArtifactTag,
  isValidTagLabel,
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
 * Vocabulary stays Jeb-owned. Derivation and PUTs live in `@pubky/bot-kit`
 * (`suggestTags` / `applyTags`); this file injects the lists.
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

export type ReplyCategory = (typeof REPLY_TAG_VOCABULARY)[number];

/** One-line meaning for each reply category self-tag. Published in How I work. */
export const REPLY_TAG_MEANINGS: Record<ReplyCategory, string> = {
  answer: "a direct answer; omitted when a more specific base label applies",
  pubky: "the answer relied on Pubky product sources",
  bitkit: "the answer relied on Bitkit sources",
  paykit: "the answer relied on Paykit sources",
  graph: "a Scout graph tool was used",
  "evidence-map": "supporting and disputing sources were mapped for a claim",
  summary: "a thread or disagreement was summarized",
  declined: "the request was refused (secrets, private data, or policy)",
};

/** Operator-reviewed tags Jeb may apply to anyone's public post. */
export const ARTIFACT_TAG_VOCAB = ["sources-cited", "debate", "release-notes"] as const;

export type ArtifactTagLabel = (typeof ARTIFACT_TAG_VOCAB)[number];

/** One-line meaning for each artifact tag. Published in How I work. */
export const ARTIFACT_TAG_MEANINGS: Record<ArtifactTagLabel, string> = {
  "sources-cited": "the post cites public sources",
  debate: "the post sits in a disagreement cluster",
  "release-notes": "the post is release or changelog notes",
};

export function isArtifactTagLabel(label: string): label is ArtifactTagLabel {
  return (ARTIFACT_TAG_VOCAB as readonly string[]).includes(label);
}

export { MAX_REPLY_TAGS, isValidTagLabel, toolsUsedInTrace, suggestTags };

/** Tag PUT failures are retried on subsequent publisher ticks up to this cap. */
export const TAG_MAX_ATTEMPTS = 3;

export const PRODUCT_CATEGORIES = ["pubky", "bitkit", "paykit"] as const;

/** Maps a knowledge-source product id to its category label, if any. */
export function productCategory(product: string): ReplyCategory | null {
  const p = product.toLowerCase();
  if (p.includes("bitkit")) return "bitkit";
  if (p.includes("paykit")) return "paykit";
  if (p.startsWith("pubky") || p === "pkarr" || p.startsWith("nexus") || p === "slashtags") return "pubky";
  return null;
}

/**
 * Derives the category labels for a reply from the intent, the knowledge
 * products touched, and the tools actually used. Delegates to Kit
 * `suggestTags` with Jeb's vocabulary, product precedence, and Scout tools.
 */
export function deriveCategories(opts: {
  intent: string;
  toolTrace?: unknown[];
  products?: string[];
}): ReplyCategory[] {
  const products = (opts.products ?? [])
    .map((p) => productCategory(p))
    .filter((x): x is ReplyCategory => x !== null);
  return suggestTags({
    intent: opts.intent,
    toolTrace: opts.toolTrace ?? [],
    products,
    vocab: REPLY_TAG_VOCABULARY,
    precedence: PRODUCT_CATEGORIES,
    graphTools: SCOUT_TOOLS,
  }) as ReplyCategory[];
}

export async function putReplyTags(
  transport: Transport,
  replyUri: string,
  labels: string[],
  opts?: { stopping?: () => boolean },
): Promise<string[]> {
  return kitPutReplyTags(transport, replyUri, labels, { ...opts, vocab: REPLY_TAG_VOCABULARY });
}

export function artifactTagObject(
  botPk: string,
  postUri: string,
  label: string,
): { path: string; url: string; json: unknown } {
  return kitArtifactTagObject(botPk, postUri, label, ARTIFACT_TAG_VOCAB);
}

export async function putArtifactTag(transport: Transport, postUri: string, label: string): Promise<string> {
  return kitPutArtifactTag(transport, postUri, label, ARTIFACT_TAG_VOCAB);
}

export async function deleteArtifactTag(transport: Transport, postUri: string, label: string): Promise<string> {
  return kitDeleteArtifactTag(transport, postUri, label, ARTIFACT_TAG_VOCAB);
}

export async function applyTags(
  input: { targetUri: string; labels: string[]; mode: "self" | "artifact"; approvedBy?: string },
  deps: Omit<ApplyTagsDeps, "selfVocab" | "artifactVocab">,
): Promise<ApplyTagsResult> {
  return kitApplyTags(input, {
    ...deps,
    selfVocab: REPLY_TAG_VOCABULARY,
    artifactVocab: ARTIFACT_TAG_VOCAB,
  });
}
