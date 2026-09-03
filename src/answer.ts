import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import type { Config } from "./config.js";
import { composeReply, SYSTEM_PROMPT } from "./compose.js";
import type { ChainPost } from "./context.js";
import { assemblePrompt } from "./context.js";
import { classifyIntent, DECLINE_REPLY, toolsForIntent, type Intent } from "./intent.js";
import { parseModes } from "./modes.js";
import type { Nexus } from "./nexus.js";
import { nexusTools } from "./tools.js";

export interface AnswerResult {
  intent: Intent;
  content: string | null;
  sources: string[];
  toolTrace: unknown[];
  tokens: number | null;
}

export async function answerMention(
  cfg: Config,
  nexus: Nexus,
  botPk: string,
  mention: ChainPost,
  chain: ChainPost[],
): Promise<AnswerResult> {
  const intent = classifyIntent({
    text: mention.content,
    authorIsBot: false,
    isSelf: mention.author === botPk,
  });
  if (intent === "ignore") return { intent, content: null, sources: [], toolTrace: [], tokens: 0 };
  if (intent === "decline") {
    return { intent, content: DECLINE_REPLY, sources: [], toolTrace: [], tokens: 0 };
  }
  const modes = parseModes(mention.content);
  const sources = chain.map((p) => p.uri);
  if (cfg.cannedReply !== undefined && cfg.cannedReply !== "") {
    const composed = composeReply(cfg.cannedReply, modes, sources);
    return { intent: "answer", content: composed.content, sources, toolTrace: [], tokens: 0 };
  }
  if (!cfg.modelApiKey) throw new Error("no model key");
  const openai = createOpenAI({ apiKey: cfg.modelApiKey, baseURL: cfg.modelBaseUrl });
  const allowed = new Set(toolsForIntent(intent));
  const catalog = nexusTools(nexus);
  const tools = {
    get_post: tool({
      description: catalog.get_post.description,
      parameters: catalog.get_post.parameters,
      execute: catalog.get_post.execute,
    }),
    get_thread: tool({
      description: catalog.get_thread.description,
      parameters: catalog.get_thread.parameters,
      execute: catalog.get_thread.execute,
    }),
    get_user: tool({
      description: catalog.get_user.description,
      parameters: catalog.get_user.parameters,
      execute: catalog.get_user.execute,
    }),
    get_user_tags: tool({
      description: catalog.get_user_tags.description,
      parameters: catalog.get_user_tags.parameters,
      execute: catalog.get_user_tags.execute,
    }),
    search_posts_by_tag: tool({
      description: catalog.search_posts_by_tag.description,
      parameters: catalog.search_posts_by_tag.parameters,
      execute: catalog.search_posts_by_tag.execute,
    }),
    get_post_replies: tool({
      description: catalog.get_post_replies.description,
      parameters: catalog.get_post_replies.parameters,
      execute: catalog.get_post_replies.execute,
    }),
  };
  const selected = Object.fromEntries(Object.entries(tools).filter(([n]) => allowed.has(n as never)));
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), cfg.modelTimeoutMs);
  const trace: unknown[] = [];
  try {
    const out = await generateText({
      model: openai(cfg.model),
      system: SYSTEM_PROMPT,
      prompt: assemblePrompt(botPk, mention, chain),
      tools: selected,
      maxSteps: cfg.toolMaxSteps,
      abortSignal: ac.signal,
      onStepFinish: (step) => {
        trace.push({
          toolCalls: step.toolCalls?.map((c) => ({ name: c.toolName, args: c.args })),
        });
      },
    });
    const composed = composeReply(out.text, modes, sources);
    return {
      intent,
      content: composed.content,
      sources,
      toolTrace: trace,
      tokens: out.usage?.totalTokens ?? null,
    };
  } finally {
    clearTimeout(t);
  }
}
