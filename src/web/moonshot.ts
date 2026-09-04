import type { Config } from "../config.js";
import { postJson } from "../http.js";
import { modelTemperature } from "../model.js";
import { WebToolError } from "./error.js";
import { collectHttpUrls, titlesByUrl } from "./urls.js";

const WEB_SEARCH_TOOL = {
  type: "builtin_function",
  function: { name: "$web_search" },
} as const;

export interface MoonshotSearchResult {
  summary: string;
  sources: Array<{ url: string; title?: string; source_domain?: string }>;
  provider: "moonshot";
}

export function assertPinnedHost(url: URL, allowedHost: string): void {
  if (url.host !== allowedHost) throw new Error("ssrf: host not allowed");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("ssrf: bad protocol");
}

function completionsUrl(baseUrl: string): URL {
  const origin = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("chat/completions", origin);
}

interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface AssistantMessage {
  role?: string;
  content?: string | null;
  reasoning_content?: unknown;
  tool_calls?: ToolCall[];
  annotations?: unknown;
  citations?: unknown;
}

function asMessage(raw: unknown): AssistantMessage | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as AssistantMessage;
}

function choice(body: unknown): { finish_reason?: string; message?: AssistantMessage } | null {
  if (!body || typeof body !== "object") return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return null;
  const c = choices[0] as { finish_reason?: string; message?: unknown };
  return { finish_reason: c.finish_reason, message: asMessage(c.message) ?? undefined };
}

function userPrompt(query: string, recency?: string, limit?: number): string {
  const bits = [`Search the web for: ${query}`];
  if (recency) bits.push(`Prefer results from the last ${recency}.`);
  if (limit) bits.push(`Return at most ${limit} sources.`);
  bits.push("Cite http(s) URLs for every claim.");
  return bits.join(" ");
}

export async function moonshotWebSearch(
  cfg: Pick<Config, "model" | "modelBaseUrl" | "modelApiKey" | "webTimeoutMs" | "modelTemperature">,
  args: { query: string; recency?: string; limit?: number },
): Promise<MoonshotSearchResult> {
  if (!cfg.modelApiKey || !cfg.modelBaseUrl) {
    throw new WebToolError("UNAVAILABLE");
  }
  const configuredHost = new URL(cfg.modelBaseUrl).host;
  const url = completionsUrl(cfg.modelBaseUrl);
  assertPinnedHost(url, configuredHost);
  const headers = { authorization: `Bearer ${cfg.modelApiKey}` };
  const timeout = cfg.webTimeoutMs;
  const temperature = modelTemperature(cfg);
  const tools = [WEB_SEARCH_TOOL];
  const messages: unknown[] = [{ role: "user", content: userPrompt(args.query, args.recency, args.limit) }];

  const turn1 = await postJson(
    url,
    timeout,
    { model: cfg.model, temperature, messages, tools },
    headers,
  );
  if (turn1.status < 200 || turn1.status >= 300) throw new WebToolError("HTTP");
  const c1 = choice(turn1.body);
  const msg1 = c1?.message;
  if (!c1 || c1.finish_reason !== "tool_calls" || !msg1?.tool_calls?.length) {
    throw new WebToolError("NO_TOOL_CALLS");
  }
  for (const tc of msg1.tool_calls) {
    if (tc.function?.name !== "$web_search") throw new WebToolError("NO_TOOL_CALLS");
  }

  const assistant: Record<string, unknown> = { ...msg1, role: "assistant" };
  if ("reasoning_content" in msg1) assistant.reasoning_content = msg1.reasoning_content;
  messages.push(assistant);
  for (const tc of msg1.tool_calls) {
    const id = tc.id;
    if (!id) throw new WebToolError("PARSE");
    messages.push({
      role: "tool",
      tool_call_id: id,
      name: "$web_search",
      content: tc.function?.arguments ?? "",
    });
  }

  const turn2 = await postJson(
    url,
    timeout,
    { model: cfg.model, temperature, messages, tools },
    headers,
  );
  if (turn2.status < 200 || turn2.status >= 300) throw new WebToolError("HTTP");
  const c2 = choice(turn2.body);
  const msg2 = c2?.message;
  const summary = typeof msg2?.content === "string" ? msg2.content : "";
  if (!msg2 || typeof msg2.content !== "string") throw new WebToolError("PARSE");

  const urls = collectHttpUrls(msg2);
  const titles = titlesByUrl(msg2);
  const sources = [...urls].map((u) => {
    const title = titles.get(u);
    try {
      return { url: u, ...(title ? { title } : {}), source_domain: new URL(u).hostname };
    } catch {
      return { url: u, ...(title ? { title } : {}) };
    }
  });
  return { summary, sources, provider: "moonshot" };
}
