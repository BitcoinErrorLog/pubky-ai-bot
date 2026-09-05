import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { Config } from "../config.js";
import { systemPrompt } from "../compose.js";
import { modelTemperature } from "../model.js";
import {
  assertDraftQuality,
  DraftRejectedError,
  dropIncompleteTail,
  endsAtBoundary,
  isLinkOnlyBody,
} from "./finish.js";
import { DRAFT_MODEL_MAX_TOKENS, type DraftFormat } from "./types.js";

export interface DraftCompletion {
  text: string;
  finishReason?: string;
}

export type DraftCompleteFn = (prompt: string) => Promise<string | DraftCompletion>;

export function isNoneOutput(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const first = t.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return /^none\b/i.test(first);
}

export function noneReason(text: string, fallback: string): string {
  const t = text.trim();
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) return lines.slice(1).join(" ").slice(0, 240);
  const rest = t.replace(/^none\b[:.\s-]*/i, "").trim();
  return rest || fallback;
}

export function asCompletion(out: string | DraftCompletion): DraftCompletion {
  return typeof out === "string" ? { text: out.trim() } : { text: out.text.trim(), finishReason: out.finishReason };
}

export async function completeDraft(opts: {
  cfg?: Pick<Config, "modelApiKey" | "modelBaseUrl" | "model" | "modelTimeoutMs" | "modelTemperature" | "cannedReply">;
  prompt: string;
  complete?: DraftCompleteFn;
  maxTokens?: number;
}): Promise<DraftCompletion> {
  if (opts.complete) return asCompletion(await opts.complete(opts.prompt));
  const cfg = opts.cfg;
  if (!cfg) throw new Error("completeDraft requires cfg or complete");
  if (cfg.cannedReply !== undefined && cfg.cannedReply !== "") return { text: cfg.cannedReply };
  if (!cfg.modelApiKey) throw new Error("no model key");
  const openai = createOpenAI({
    apiKey: cfg.modelApiKey,
    baseURL: cfg.modelBaseUrl,
  });
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), cfg.modelTimeoutMs);
  try {
    const out = await generateText({
      model: openai(cfg.model),
      prompt: opts.prompt,
      temperature: modelTemperature(cfg),
      maxTokens: opts.maxTokens ?? DRAFT_MODEL_MAX_TOKENS,
      abortSignal: ac.signal,
    });
    return { text: out.text.trim(), finishReason: out.finishReason };
  } finally {
    clearTimeout(t);
  }
}

function draftPrompt(instruction: string, evidenceNotes: string, extra = ""): string {
  return [
    systemPrompt(),
    "",
    "You are composing a standalone proactive draft, not a reply. Write in Jeb's voice.",
    "Cite only URLs listed under Evidence. Never invent a URL. Never emit pubky:// URIs.",
    "Write plain text with bare https URLs. Do not wrap the draft in a markdown link.",
    "If the evidence is too thin, trivial, off-topic, or not a real instance of this format, reply with exactly:",
    "none",
    "then one short reason on the next line.",
    extra,
    "",
    instruction,
    "",
    "Evidence (the only URLs you may cite):",
    evidenceNotes,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export async function composeDraftProse(opts: {
  format: DraftFormat;
  instruction: string;
  evidenceNotes: string;
  cfg?: Pick<Config, "modelApiKey" | "modelBaseUrl" | "model" | "modelTimeoutMs" | "modelTemperature" | "cannedReply">;
  complete?: DraftCompleteFn;
  noneFallback: string;
}): Promise<string> {
  const run = async (extra: string): Promise<DraftCompletion> => {
    try {
      return await completeDraft({
        cfg: opts.cfg,
        prompt: draftPrompt(opts.instruction, opts.evidenceNotes, extra),
        complete: opts.complete,
      });
    } catch (e) {
      if (e instanceof DraftRejectedError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new DraftRejectedError(opts.format, `model unavailable: ${msg}`);
    }
  };

  let completion = await run("");
  if (isNoneOutput(completion.text)) {
    throw new DraftRejectedError(opts.format, `none: ${noneReason(completion.text, opts.noneFallback)}`);
  }
  if (isLinkOnlyBody(completion.text)) {
    completion = await run(
      "Retry: do not wrap the draft in a markdown link. Do not return only a URL. Write sentences.",
    );
    if (isNoneOutput(completion.text)) {
      throw new DraftRejectedError(opts.format, `none: ${noneReason(completion.text, opts.noneFallback)}`);
    }
    if (isLinkOnlyBody(completion.text)) {
      throw new DraftRejectedError(opts.format, "none: link-only body");
    }
  }

  const lengthStop = completion.finishReason === "length";
  const needsTrim = lengthStop || !endsAtBoundary(completion.text);
  const text = needsTrim ? dropIncompleteTail(completion.text) : completion.text;
  const droppedTail = needsTrim && text !== completion.text.trim();
  assertDraftQuality(opts.format, text, { truncated: lengthStop || droppedTail });
  return text;
}
