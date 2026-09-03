import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import type { Config } from "./config.js";

export async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

export async function completeReply(cfg: Config, prompt: string): Promise<{ text: string; tokens: number | null }> {
  if (cfg.cannedReply !== undefined && cfg.cannedReply !== "") {
    return { text: cfg.cannedReply.slice(0, 2000), tokens: 0 };
  }
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
      prompt,
      abortSignal: ac.signal,
    });
    const tokens = out.usage?.totalTokens ?? null;
    return { text: out.text.slice(0, 2000), tokens: tokens ?? null };
  } finally {
    clearTimeout(t);
  }
}
