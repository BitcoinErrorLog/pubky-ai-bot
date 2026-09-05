import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { Config } from "../config.js";
import { systemPrompt } from "../compose.js";
import { modelTemperature } from "../model.js";
import { DraftRejectedError } from "./finish.js";
import { DRAFT_MODEL_MAX_TOKENS, type DraftFormat } from "./types.js";

export type DraftCompleteFn = (prompt: string) => Promise<string>;

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

export async function completeDraft(opts: {
  cfg?: Pick<Config, "modelApiKey" | "modelBaseUrl" | "model" | "modelTimeoutMs" | "modelTemperature" | "cannedReply">;
  prompt: string;
  complete?: DraftCompleteFn;
  maxTokens?: number;
}): Promise<string> {
  if (opts.complete) return opts.complete(opts.prompt);
  const cfg = opts.cfg;
  if (!cfg) throw new Error("completeDraft requires cfg or complete");
  if (cfg.cannedReply !== undefined && cfg.cannedReply !== "") return cfg.cannedReply;
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
    return out.text.trim();
  } finally {
    clearTimeout(t);
  }
}

export async function composeDraftProse(opts: {
  format: DraftFormat;
  instruction: string;
  evidenceNotes: string;
  cfg?: Pick<Config, "modelApiKey" | "modelBaseUrl" | "model" | "modelTimeoutMs" | "modelTemperature" | "cannedReply">;
  complete?: DraftCompleteFn;
  noneFallback: string;
}): Promise<string> {
  const prompt = [
    systemPrompt(),
    "",
    "You are composing a standalone proactive draft, not a reply. Write in Jeb's voice.",
    "Cite only URLs listed under Evidence. Never invent a URL. Never emit pubky:// URIs.",
    "If the evidence is too thin, trivial, off-topic, or not a real instance of this format, reply with exactly:",
    "none",
    "then one short reason on the next line.",
    "",
    opts.instruction,
    "",
    "Evidence (the only URLs you may cite):",
    opts.evidenceNotes,
  ].join("\n");
  let text: string;
  try {
    text = await completeDraft({ cfg: opts.cfg, prompt, complete: opts.complete });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new DraftRejectedError(opts.format, `model unavailable: ${msg}`);
  }
  if (isNoneOutput(text)) {
    throw new DraftRejectedError(opts.format, `none: ${noneReason(text, opts.noneFallback)}`);
  }
  return text;
}
