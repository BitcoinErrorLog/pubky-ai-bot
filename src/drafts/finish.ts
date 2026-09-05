import { appBaseUrl, postAppUrl, profileAppUrl, rewritePubkyCitations } from "../links.js";
import { scanForSecrets } from "../secret-scrub.js";
import { lintVoice } from "../voice.js";
import { dropUnknownCitations, normalizeHref } from "./citations.js";
import { isAllowedEvidenceUri } from "./evidence-uri.js";
import {
  DRAFT_BODY_MAX,
  DRAFT_CITATION_CAP,
  DRAFT_LIST_FORMATS,
  DRAFT_MIN_BODY,
  DRAFT_PROSE_MIN_CHARS,
  type Draft,
  type DraftFormat,
} from "./types.js";

export class DraftRejectedError extends Error {
  constructor(format: DraftFormat, reason: string) {
    super(`${format}: generator rejected: ${reason}`);
    this.name = "DraftRejectedError";
  }
}

export function isToolError(out: unknown): boolean {
  return Boolean(out && typeof out === "object" && "error" in out);
}

const QUALITY_MD_LINK = /!?\[[^\]]*\]\([^)]*\)/g;
const QUALITY_BARE_URL = /https?:\/\/[^\s)]+/gi;
const SENTENCE_END = /[.!?]"?$/;
const BULLET = /^\s*[-*]\s+\S/;

export function endsAtBoundary(text: string): boolean {
  const t = text.trimEnd();
  if (!t) return false;
  if (SENTENCE_END.test(t) || /https?:\/\/\S+$/i.test(t)) return true;
  const last = (t.split(/\n/).filter((l) => l.trim()).pop() ?? "").trim();
  if (SENTENCE_END.test(last) || /https?:\/\/\S+$/i.test(last)) return true;
  return false;
}

export function dropIncompleteTail(text: string): string {
  const raw = text.replace(/\s+$/g, "");
  if (!raw) return "";
  if (endsAtBoundary(raw)) return raw.trim();
  const lines = raw.split("\n");
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  if (lines.length) lines.pop();
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines.join("\n").trim();
}

export function completeBulletCount(text: string): number {
  return text.split("\n").filter((l) => BULLET.test(l) && endsAtBoundary(l)).length;
}

/** True when the model returned only a markdown/bare link (or its neutralized leftover). */
export function isLinkOnlyBody(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^https?:\/\/\S+$/i.test(t)) return true;
  if (/^!?\[([^\]]*)\]\([^)]+\)\.?$/i.test(t)) return true;
  const stripped = t.replace(QUALITY_MD_LINK, " ").replace(QUALITY_BARE_URL, " ").replace(/\s+/g, " ").trim();
  if (!stripped) return true;
  const onlyLinkWrapper = /^!?\[/.test(t) && stripped.length < 48 && !SENTENCE_END.test(stripped);
  return onlyLinkWrapper;
}

export function assertDraftQuality(format: DraftFormat, body: string, opts?: { truncated?: boolean }): void {
  const text = body.trim();
  if (!text) throw new DraftRejectedError(format, "none: truncated output");
  if (isLinkOnlyBody(text)) throw new DraftRejectedError(format, "none: link-only body");
  const min = DRAFT_MIN_BODY[format];
  const list = (DRAFT_LIST_FORMATS as readonly string[]).includes(format);
  if (opts?.truncated) {
    if (list && completeBulletCount(text) < 2) {
      throw new DraftRejectedError(format, "none: truncated output");
    }
    if (!list && text.length < DRAFT_PROSE_MIN_CHARS) {
      throw new DraftRejectedError(format, "none: truncated output");
    }
  }
  if (text.length < min) throw new DraftRejectedError(format, "none: truncated output");
  if (list && completeBulletCount(text) < 2) {
    throw new DraftRejectedError(format, "none: truncated output");
  }
}

/** Same whitelist as Scout tag sanitizer in packages/bot-kit/src/scout/tools.ts (search_posts tags). */
export const DRAFT_LABEL_UNSAFE = /[^a-zA-Z0-9_-]/g;
export const DRAFT_LABEL_MAX = 20;

const CONTROL_EXCEPT_NL_TAB = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const UNICODE_FORMAT = /\p{Cf}/gu;
const MD_IMAGE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const MD_LINK = /\[([^\]]*)\]\(([^)]*)\)/g;
const MD_AUTOLINK = /<https?:\/\/[^>\s]+>/gi;
const PUBKY_URI = /pubky:\/\/[a-z0-9]{52}(?:\/[^\s<>]*)?/gi;
const PUBKY_PCT = /pubky%3a(?:\/\/[^\s<>]*)?/gi;
const BARE_PK = /(?<![A-Za-z0-9/])[a-z0-9]{52}(?![A-Za-z0-9])/g;
const HTTP_SPLIT = /(https?:\/\/[^\s)]+)/gi;
const WWW_BARE = /\bwww\.[^\s<>"'`)\]}]+/gi;

export function sanitizeDraftLabel(raw: string): string {
  return raw.replace(DRAFT_LABEL_UNSAFE, "").slice(0, DRAFT_LABEL_MAX);
}

/**
 * Graph-sourced labels, titles, and previews: collapse whitespace (kills
 * newline list injection), drop markdown link/image/autolink URLs, and strip
 * pubky:// URIs plus bare 52-char pubkeys so rewritePubkyCitations cannot
 * promote attacker links.
 */
export function sanitizeUntrustedDraftText(raw: string): string {
  return dropBareHttp(
    stripPubkyAndBareKeys(dropMarkdownUrls(raw.replace(CONTROL_EXCEPT_NL_TAB, "").replace(UNICODE_FORMAT, ""))),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function dropMarkdownUrls(raw: string): string {
  return raw.replace(MD_IMAGE, "$1").replace(MD_LINK, "$1").replace(MD_AUTOLINK, "");
}

function stripPubkyAndBareKeys(raw: string): string {
  const parts = raw.split(HTTP_SPLIT);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(PUBKY_URI, "").replace(PUBKY_PCT, "").replace(BARE_PK, "");
    })
    .join("");
}

function dropBareHttp(raw: string): string {
  return raw.replace(HTTP_SPLIT, "").replace(WWW_BARE, "");
}

function neutralizeDraftBody(raw: string): string {
  return stripPubkyAndBareKeys(dropMarkdownUrls(raw.replace(CONTROL_EXCEPT_NL_TAB, "")));
}

export function evidenceHref(uri: string, appUrl = appBaseUrl()): string {
  const u = uri.trim();
  const post = /^pubky:\/\/([a-z0-9]{52})\/pub\/pubky\.app\/posts\/([A-Z0-9]{13})$/i.exec(u);
  if (post?.[1] && post[2]) return postAppUrl(post[1], post[2].toUpperCase(), appUrl);
  const profile = /^pubky:\/\/([a-z0-9]{52})$/i.exec(u);
  if (profile?.[1]) return profileAppUrl(profile[1], appUrl);
  if (isAllowedEvidenceUri(u, appUrl) && /^https:\/\//i.test(u)) return normalizeHref(u);
  return "";
}

export function allowedCitationHrefs(uris: string[], appUrl?: string): Set<string> {
  const out = new Set<string>();
  for (const uri of uris) {
    const href = evidenceHref(uri, appUrl);
    if (href) out.add(normalizeHref(href));
    const raw = uri.trim();
    if (isAllowedEvidenceUri(raw, appUrl) && /^https:\/\//i.test(raw)) out.add(normalizeHref(raw));
  }
  return out;
}

export function finishDraft(input: {
  format: DraftFormat;
  title?: string;
  body: string;
  uris: string[];
  tool_trace: unknown[];
  created_at?: Date;
  appUrl?: string;
  /** Sanitizer fixtures skip the composition quality floor. */
  skipQuality?: boolean;
}): Draft {
  const uris = [...new Set(input.uris.map((u) => u.trim()).filter(Boolean))];
  if (uris.length < 1) throw new DraftRejectedError(input.format, "no evidence URI");
  const allowed = allowedCitationHrefs(uris, input.appUrl);
  const titleRaw = input.title?.trim() ? sanitizeUntrustedDraftText(input.title).slice(0, 200) : "";
  const title = titleRaw || undefined;
  const rewritten = rewritePubkyCitations(neutralizeDraftBody(input.body), input.appUrl);
  const cited = dropUnknownCitations(rewritten, allowed);
  const linted = lintVoice(cited, { citationCap: DRAFT_CITATION_CAP });
  let body = linted.text.slice(0, DRAFT_BODY_MAX).trim();
  if (!input.skipQuality && body && !endsAtBoundary(body)) body = dropIncompleteTail(body);
  if (!body) throw new DraftRejectedError(input.format, "empty body");
  if (!input.skipQuality) assertDraftQuality(input.format, body);
  const scrub = scanForSecrets(body);
  if (!scrub.clean) {
    throw new DraftRejectedError(input.format, `secret scrubber refused: ${scrub.hits.map((h) => h.rule).join(",")}`);
  }
  return {
    format: input.format,
    title,
    body,
    evidence: {
      uris,
      tool_trace: input.tool_trace,
      voice_violations: linted.violations,
    },
    created_at: (input.created_at ?? new Date()).toISOString(),
  };
}
