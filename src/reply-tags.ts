import { PubkySpecsBuilder } from "pubky-app-specs";
import type { Transport } from "./homeserver.js";
import { SCOUT_TOOLS } from "./intent.js";
import { StoppingError } from "./shutdown.js";
import { parsePostUri } from "./types.js";

/**
 * Ticket 12c (plan §4.4b): category self-tags on Jeb's own replies.
 *
 * After a reply is published, the publisher writes one Pubky tag per category
 * label under Jeb's key, with `uri` = the reply's own URI. The vocabulary is
 * fixed and published (docs/voice.md, docs/intro-post.md); tags are machine
 * output attributable to Jeb's key (R3) and durable structure returned to the
 * graph (R11). Jeb never tags other people's posts.
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

export const MAX_REPLY_TAGS = 3;

/** Tag PUT failures are retried on subsequent publisher ticks up to this cap. */
export const TAG_MAX_ATTEMPTS = 3;

const SCOUT_TOOL_NAMES: ReadonlySet<string> = new Set(SCOUT_TOOLS);

const PRODUCT_CATEGORIES = ["pubky", "bitkit", "paykit"] as const;

/**
 * Spec limits (pubky-app-specs validationLimits): label 1–20 chars, no
 * commas, colons, or whitespace.
 */
export function isValidTagLabel(label: string): boolean {
  if (label.length < 1 || label.length > 20) return false;
  return !/[,\s:]/.test(label);
}

/** Maps a knowledge-source product id to its category label, if any. */
export function productCategory(product: string): ReplyCategory | null {
  const p = product.toLowerCase();
  if (p.includes("bitkit")) return "bitkit";
  if (p.includes("paykit")) return "paykit";
  if (p.startsWith("pubky") || p === "pkarr" || p.startsWith("nexus") || p === "slashtags") return "pubky";
  return null;
}

/** Tool names actually invoked, recovered from the answer tool trace. */
export function toolsUsedInTrace(toolTrace: unknown[]): string[] {
  const names: string[] = [];
  for (const entry of toolTrace) {
    if (!entry || typeof entry !== "object") continue;
    const calls = (entry as { toolCalls?: unknown }).toolCalls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const name = (call as { name?: unknown } | null)?.name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

/**
 * Derives the category labels for a reply from the intent, the knowledge
 * products touched, and the tools actually used. Rules (§4.4b):
 * - `answer` is always present unless `declined` / `summary` / `evidence-map`
 *   applies (those come from the `decline` / `summarize` / `evidence_map`
 *   intents).
 * - `pubky` / `bitkit` / `paykit` come from the products of the knowledge
 *   chunks the answer relied on.
 * - `graph` is added when any Scout tool was used.
 * - At most MAX_REPLY_TAGS labels, in vocabulary precedence order.
 */
export function deriveCategories(opts: {
  intent: string;
  toolTrace?: unknown[];
  products?: string[];
}): ReplyCategory[] {
  const out: ReplyCategory[] = [];
  if (opts.intent === "decline") out.push("declined");
  else if (opts.intent === "summarize") out.push("summary");
  else if (opts.intent === "evidence_map") out.push("evidence-map");
  else out.push("answer");
  const products = opts.products ?? [];
  for (const candidate of PRODUCT_CATEGORIES) {
    if (out.length >= MAX_REPLY_TAGS) break;
    if (products.some((p) => productCategory(p) === candidate)) out.push(candidate);
  }
  if (out.length < MAX_REPLY_TAGS) {
    const used = toolsUsedInTrace(opts.toolTrace ?? []);
    if (used.some((name) => SCOUT_TOOL_NAMES.has(name))) out.push("graph");
  }
  return out;
}

/**
 * Builds and PUTs one tag per label on `replyUri`, returning the tag URIs.
 *
 * Hard rule: only ever Jeb's own reply — the URI author must equal the
 * transport's bot key, checked before any PUT. Re-PUT is idempotent: the tag
 * id is a hash of uri+label, so a retry overwrites the same object.
 */
export async function putReplyTags(
  transport: Transport,
  replyUri: string,
  labels: string[],
  opts?: { stopping?: () => boolean },
): Promise<string[]> {
  const { author } = parsePostUri(replyUri);
  if (author.toLowerCase() !== transport.botPk.toLowerCase()) {
    throw new Error("refusing to tag a post not authored by the bot key");
  }
  const specs = new PubkySpecsBuilder(transport.botPk);
  const uris: string[] = [];
  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    if (opts?.stopping?.()) throw new StoppingError();
    if (!isValidTagLabel(label)) throw new Error(`invalid tag label: ${label}`);
    if (!(REPLY_TAG_VOCABULARY as readonly string[]).includes(label)) {
      throw new Error(`tag label not in vocabulary: ${label}`);
    }
    const { tag, meta } = specs.createTag(replyUri, label);
    if (opts?.stopping?.()) throw new StoppingError();
    await transport.putJson(meta.path, tag.toJson());
    uris.push(meta.url);
  }
  return uris;
}
