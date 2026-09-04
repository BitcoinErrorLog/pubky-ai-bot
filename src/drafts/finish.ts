import { rewritePubkyCitations } from "../links.js";
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

export function finishDraft(input: {
  format: DraftFormat;
  title?: string;
  body: string;
  uris: string[];
  tool_trace: unknown[];
  created_at?: Date;
}): Draft {
  const uris = [...new Set(input.uris.map((u) => u.trim()).filter(Boolean))];
  if (uris.length < 1) throw new DraftRejectedError(input.format, "no evidence URI");
  const linted = lintVoice(rewritePubkyCitations(input.body), { citationCap: 3 });
  const body = linted.text.slice(0, DRAFT_BODY_MAX).trim();
  if (!body) throw new DraftRejectedError(input.format, "empty body");
  const title = input.title?.trim() ? input.title.trim().slice(0, 200) : undefined;
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
