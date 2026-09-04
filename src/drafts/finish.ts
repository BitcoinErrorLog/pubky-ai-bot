import { appBaseUrl, postAppUrl, profileAppUrl, rewritePubkyCitations } from "../links.js";
import { lintVoice } from "../voice.js";
import { DRAFT_BODY_MAX, type Draft, type DraftFormat } from "./types.js";

export class DraftRejectedError extends Error {
  constructor(format: DraftFormat, reason: string) {
    super(`${format}: generator rejected: ${reason}`);
    this.name = "DraftRejectedError";
  }
}

export function isToolError(out: unknown): boolean {
  return Boolean(out && typeof out === "object" && "error" in out);
}

/** Same whitelist as Scout tag sanitizer in packages/bot-kit/src/scout/tools.ts (search_posts tags). */
export const DRAFT_LABEL_UNSAFE = /[^a-zA-Z0-9_-]/g;
export const DRAFT_LABEL_MAX = 20;

const CONTROL_EXCEPT_NL_TAB = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MD_IMAGE = /!\[([^\]]*)\]\(([^)]*)\)/g;
const MD_LINK = /\[([^\]]*)\]\(([^)]*)\)/g;
const MD_AUTOLINK = /<https?:\/\/[^>\s]+>/gi;
const PUBKY_URI = /pubky:\/\/[a-z0-9]{52}(?:\/[^\s<>]*)?/gi;
const BARE_PK = /(?<![A-Za-z0-9/])[a-z0-9]{52}(?![A-Za-z0-9])/g;
const HTTP_SPLIT = /(https?:\/\/[^\s)]+)/gi;

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
    stripPubkyAndBareKeys(dropMarkdownUrls(raw.replace(CONTROL_EXCEPT_NL_TAB, ""))),
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
      return part.replace(PUBKY_URI, "").replace(BARE_PK, "");
    })
    .join("");
}

function dropBareHttp(raw: string): string {
  return raw.replace(HTTP_SPLIT, "");
}

function neutralizeDraftBody(raw: string): string {
  return stripPubkyAndBareKeys(dropMarkdownUrls(raw.replace(CONTROL_EXCEPT_NL_TAB, "")));
}

export function evidenceHref(uri: string, appUrl = appBaseUrl()): string {
  const u = uri.trim();
  const post = /^pubky:\/\/([a-z0-9]{52})\/pub\/pubky\.app\/posts\/([A-Za-z0-9._~-]+)$/i.exec(u);
  if (post?.[1] && post[2]) return postAppUrl(post[1], post[2].toUpperCase(), appUrl);
  const profile = /^pubky:\/\/([a-z0-9]{52})$/i.exec(u);
  if (profile?.[1]) return profileAppUrl(profile[1], appUrl);
  return u;
}

export function finishDraft(input: {
  format: DraftFormat;
  title?: string;
  body: string;
  uris: string[];
  tool_trace: unknown[];
  created_at?: Date;
  appUrl?: string;
}): Draft {
  const uris = [...new Set(input.uris.map((u) => u.trim()).filter(Boolean))];
  if (uris.length < 1) throw new DraftRejectedError(input.format, "no evidence URI");
  const evidenceLinks = [...new Set(uris.map((u) => evidenceHref(u, input.appUrl)))].filter(Boolean).slice(0, 3);
  const titleRaw = input.title?.trim() ? sanitizeUntrustedDraftText(input.title).slice(0, 200) : "";
  const title = titleRaw || undefined;
  const sanitizedBody = neutralizeDraftBody(input.body);
  const assembled = evidenceLinks.length > 0 ? `${evidenceLinks.join("\n")}\n${sanitizedBody}` : sanitizedBody;
  const linted = lintVoice(rewritePubkyCitations(assembled, input.appUrl), { citationCap: 3 });
  const body = linted.text.slice(0, DRAFT_BODY_MAX).trim();
  if (!body) throw new DraftRejectedError(input.format, "empty body");
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
