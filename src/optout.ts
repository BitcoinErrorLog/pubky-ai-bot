import type { Store } from "./db.js";
import { log } from "./log.js";
import { lintVoice } from "./voice.js";

export const OPTOUT_CONFIRM_KIND = "optout_confirm";

export const OPTOUT_CONFIRM_TEXT =
  "Understood — I won't reply to you again. Mention me with 'you can reply to me again' to undo.";

export const OPTIN_CONFIRM_TEXT = "Understood — I'll reply to you again when you mention me.";

export type OptoutRequest = "opt_out" | "opt_in";

const MAX_BARE_WORDS = 8;
const REPLY_TO_ME = /\brepl(?:y|ying|ies)\s+to\s+me\b/i;

function stripMentionNoise(text: string): string {
  return text
    .replace(/pubky:\/\/[a-z0-9]{52}[^\s]*/gi, " ")
    .replace(/\bpubky[a-z0-9]{52}\b/gi, " ")
    .replace(/@[a-z0-9_]{2,}/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(t: string): number {
  return t.split(/\s+/).filter(Boolean).length;
}

/** "?" plus how/can/does/what/why/is, and no explicit "reply to me". */
function isInterrogativeQuestion(t: string): boolean {
  if (!t.includes("?")) return false;
  if (REPLY_TO_ME.test(t)) return false;
  return /\b(how|can|does|what|why|is)\b/i.test(t);
}

/** Questions about the mechanism, other people, or the definition — not a request. */
function isMetaQuestion(t: string): boolean {
  if (/\bhow (do|does|can|to)\b.{0,80}\b(others?|people|them|someone|users?)\b/i.test(t)) return true;
  if (/\b(what (is|does)|explain|tell me about)\b.{0,40}(opt[\s-]?out|unsubscri|mute)/i.test(t)) return true;
  if (/\bcan (users?|people|someone|others?)\b.{0,40}(opt[\s-]?out|unsubscri)/i.test(t)) return true;
  if (/\b(how do i stop .{0,40}repl(y|ying) to others)\b/i.test(t)) return true;
  if (/\bshould i (opt[\s-]?out|unsubscri)/i.test(t)) return true;
  return false;
}

const STRONG_OPT_OUT: RegExp[] = [
  /\b(stop|quit)\s+(?:(?:please\s+)?(?:from\s+)?)?(?:you\s+)?repl(?:y|ying)\s+to\s+me\b/i,
  /\b(don'?t|do\s+not|never)\s+repl(?:y|ying)\s+to\s+me\b/i,
  /\bleave\s+me\s+alone\b/i,
  /\bno\s+more\s+replies?\s+(?:to\s+me|please)\b/i,
  /\bstop\s+(?:messaging|contacting|pinging)\s+me\b/i,
  // Bare "please stop replying/answering" only with nothing after it, or a
  // first-person "to me". Third-person targets ("to them/him/her/@name/key"
  // — mention noise is stripped before classification, leaving a dangling
  // "to") are not the author asking to be left alone (audit F-A).
  /\bplease\s+stop\s+(?:replying|answering)\b(?!\s+(?:to\b(?!\s+me\b)|them\b|him\b|her\b|others?\b|people\b))/i,
];

const BARE_UNSUBSCRIBE = /\bunsubscribe\b/i;
const BARE_OPTOUT = /\bopt[\s-]?out\b/i;
/** "mute me" but not "mute me-too" / "mute me-too posts". */
const BARE_MUTE_ME = /\bmute\s+me(?!-)\b/i;

function hasBareKeyword(t: string): boolean {
  return BARE_UNSUBSCRIBE.test(t) || BARE_OPTOUT.test(t) || BARE_MUTE_ME.test(t);
}

/** Bare keyword aimed at Jeb, not at a product/feed/index. */
function isSelfDirectedAtJeb(t: string): boolean {
  if (/\bopt\s+me\s+out\b/i.test(t)) return true;
  if (/\bopt[\s-]?out\b.{0,48}\b(your|you|jeb)\b/i.test(t)) return true;
  if (/\bunsubscribe\b.{0,48}\b(from\s+)?(you|jeb|your)\b/i.test(t)) return true;
  if (BARE_MUTE_ME.test(t) && /\b(your|you|jeb|replies)\b/i.test(t)) return true;
  return false;
}

const OPT_IN_PATTERNS: RegExp[] = [
  /\byou\s+can\s+repl(?:y|ies)\s+to\s+me\s+again\b/i,
  /\bopt[\s-]?in\b/i,
  /\bunmute\s+me\b/i,
  /\bstart\s+repl(?:y|ying)\s+to\s+me\s+again\b/i,
  /\bplease\s+repl(?:y|y)\s+to\s+me\s+again\b/i,
];

export function classifyOptoutRequest(text: string): OptoutRequest | null {
  const t = stripMentionNoise(text);
  if (!t) return null;
  if (isInterrogativeQuestion(t)) return null;
  if (isMetaQuestion(t)) return null;
  for (const rx of OPT_IN_PATTERNS) {
    if (rx.test(t) && !BARE_OPTOUT.test(t)) return "opt_in";
  }
  for (const rx of STRONG_OPT_OUT) {
    if (rx.test(t)) return "opt_out";
  }
  if (hasBareKeyword(t) && (wordCount(t) <= MAX_BARE_WORDS || isSelfDirectedAtJeb(t))) {
    return "opt_out";
  }
  return null;
}

export function optoutConfirmText(kind: OptoutRequest): string {
  const raw = kind === "opt_out" ? OPTOUT_CONFIRM_TEXT : OPTIN_CONFIRM_TEXT;
  const linted = lintVoice(raw);
  if (linted.violations.length) {
    throw new Error(`optout confirm ${kind} failed voice lint: ${linted.violations.map((v) => v.rule).join(",")}`);
  }
  return linted.text;
}

/**
 * One confirmation on a real state change, via the publish path (no model).
 * Deliberately takes no `replacePostId`: a confirmation must never
 * overwrite a previously published answer — symmetric with skip notices
 * (2026-09-04 audit F-5, decision 2026-09-04b audit F-E).
 */
export async function queueOptoutConfirm(opts: {
  store: Store;
  mentionKey: string;
  parentUri: string;
  kind: OptoutRequest;
  rootUri: string;
}): Promise<void> {
  const content = optoutConfirmText(opts.kind);
  const evidenceId = await opts.store.insertEvidence({
    mentionKey: opts.mentionKey,
    intent: "answer",
    toolTrace: [{ kind: OPTOUT_CONFIRM_KIND, request: opts.kind }],
    sources: [],
    model: null,
    tokens: 0,
    latencyMs: 0,
    categories: ["answer"],
    kind: OPTOUT_CONFIRM_KIND,
  });
  await opts.store.insertPublishRequest({
    mentionKey: opts.mentionKey,
    parentUri: opts.parentUri,
    content,
    evidenceId,
    categories: ["answer"],
  });
  await opts.store.mark(opts.mentionKey, "processing", { rootUri: opts.rootUri });
  log.info({ mention_key: opts.mentionKey, kind: OPTOUT_CONFIRM_KIND, request: opts.kind }, "optout confirm queued");
}
