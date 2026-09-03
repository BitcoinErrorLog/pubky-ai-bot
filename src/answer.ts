import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool } from "ai";
import type pg from "pg";
import type { Config } from "./config.js";
import { composeReply, PUBKY_ONLY_ADDENDUM, SYSTEM_PROMPT } from "./compose.js";
import type { ChainPost } from "./context.js";
import { assemblePrompt } from "./context.js";
import { classifyIntent, DECLINE_REPLY, toolsForIntent, type Intent } from "./intent.js";
import { parseModes } from "./modes.js";
import type { Nexus } from "./nexus.js";
import type { VoiceViolation } from "./voice.js";
import { KNOWLEDGE_SYSTEM_ADDENDUM } from "./knowledge/prompt.js";
import { createSearchKnowledgeExecute } from "./knowledge/tool.js";
import { SCOUT_SYSTEM_ADDENDUM } from "./scout/evidence.js";

export const EVIDENCE_MAP_ADDENDUM = [
  "For evidence_map, structure the reply as: (1) the claim, (2) supporting sources with URLs/URIs,",
  "(3) disputing sources with URLs/URIs, (4) what the Pubky graph says (Scout, as claims not facts),",
  "(5) Jeb's assessment, marked as Jeb's. Never a bare verdict.",
].join(" ");

export const WEB_SEARCH_ADDENDUM =
  "Use search_web for current external events. Cite the returned URLs. If web search is unavailable, say so; do not invent sources.";
import { InjectionDetector } from "./injection-detector.js";
import { modelTemperature } from "./model.js";
import { screenToolResult, type ScreenFlag } from "./tool-screen.js";
import { createScoutTools, createSearchWebTool, nexusTools, searchKnowledgeParameters } from "./tools.js";

export interface PhaseMs {
  knowledge: number;
  tools: number;
  model: number;
  compose: number;
}

export interface AnswerResult {
  intent: Intent;
  content: string | null;
  sources: string[];
  toolTrace: unknown[];
  tokens: number | null;
  violations: VoiceViolation[];
  phaseMs: PhaseMs;
}

const ZERO_PHASE: PhaseMs = { knowledge: 0, tools: 0, model: 0, compose: 0 };

export async function answerMention(
  cfg: Config,
  nexus: Nexus,
  botPk: string,
  mention: ChainPost,
  chain: ChainPost[],
  gate?: { blocked: () => Promise<boolean> },
  scout?: {
    pool: pg.Pool;
    mentionKey: string;
    author: string;
    storeSwitchOn: () => Promise<boolean>;
    storeWebSwitchOn: () => Promise<boolean>;
  },
  budgetExceeded?: () => Promise<boolean>,
): Promise<AnswerResult> {
  const intent = classifyIntent({
    text: mention.content,
    authorIsBot: false,
    isSelf: mention.author === botPk,
  });
  if (intent === "ignore") {
    return { intent, content: null, sources: [], toolTrace: [], tokens: 0, violations: [], phaseMs: ZERO_PHASE };
  }
  if (intent === "decline") {
    return { intent, content: DECLINE_REPLY, sources: [], toolTrace: [], tokens: 0, violations: [], phaseMs: ZERO_PHASE };
  }
  const modes = parseModes(mention.content);
  const sources = chain.map((p) => p.uri);
  if (cfg.cannedReply !== undefined && cfg.cannedReply !== "") {
    const composeStarted = Date.now();
    const composed = composeReply(cfg.cannedReply, modes, sources);
    return {
      intent: "answer",
      content: composed.content,
      sources,
      toolTrace: [],
      tokens: 0,
      violations: composed.violations,
      phaseMs: { ...ZERO_PHASE, compose: Date.now() - composeStarted },
    };
  }
  if (!cfg.modelApiKey) throw new Error("no model key");
  const openai = createOpenAI({ apiKey: cfg.modelApiKey, baseURL: cfg.modelBaseUrl });
  const allowed = new Set(toolsForIntent(intent));
  const catalog = nexusTools(nexus);
  const detector = new InjectionDetector();
  const screenFlags: ScreenFlag[] = [];
  let knowledgeMs = 0;
  let toolsMs = 0;
  const wrap = <A, R>(name: string, fn: (args: A) => Promise<R>) => async (args: A): Promise<R> => {
    if (gate && (await gate.blocked())) throw new Error("generation switch on");
    // F-13: the tool loop may make several more model calls; re-check the
    // token budget before each tool-loop step, not just once up front.
    if (budgetExceeded && (await budgetExceeded())) throw new Error("token budget exceeded");
    const toolStarted = Date.now();
    const out = await fn(args);
    const toolMs = Date.now() - toolStarted;
    if (name === "search_knowledge") knowledgeMs += toolMs;
    else toolsMs += toolMs;
    // F-03: tool results are untrusted data. Screen every string field for
    // instruction patterns and cap length before the model ever sees it.
    const screened = screenToolResult(detector, out, { tool: name });
    if (screened.flags.length) screenFlags.push(...screened.flags);
    return screened.value as R;
  };
  const scoutCatalog = scout
    ? createScoutTools({
        cfg,
        pool: scout.pool,
        mentionKey: scout.mentionKey,
        author: scout.author,
        storeSwitchOn: scout.storeSwitchOn,
      })
    : null;
  const scoutTools = scoutCatalog
    ? {
        search_posts: tool({
          description: scoutCatalog.search_posts.description,
          parameters: scoutCatalog.search_posts.parameters,
          execute: wrap("search_posts", scoutCatalog.search_posts.execute),
        }),
        scout_get_thread: tool({
          description: scoutCatalog.scout_get_thread.description,
          parameters: scoutCatalog.scout_get_thread.parameters,
          execute: wrap("scout_get_thread", scoutCatalog.scout_get_thread.execute),
        }),
        get_identity_summary: tool({
          description: scoutCatalog.get_identity_summary.description,
          parameters: scoutCatalog.get_identity_summary.parameters,
          execute: wrap("get_identity_summary", scoutCatalog.get_identity_summary.execute),
        }),
        get_topic_brief: tool({
          description: scoutCatalog.get_topic_brief.description,
          parameters: scoutCatalog.get_topic_brief.parameters,
          execute: wrap("get_topic_brief", scoutCatalog.get_topic_brief.execute),
        }),
        get_what_changed: tool({
          description: scoutCatalog.get_what_changed.description,
          parameters: scoutCatalog.get_what_changed.parameters,
          execute: wrap("get_what_changed", scoutCatalog.get_what_changed.execute),
        }),
        get_related_posts: tool({
          description: scoutCatalog.get_related_posts.description,
          parameters: scoutCatalog.get_related_posts.parameters,
          execute: wrap("get_related_posts", scoutCatalog.get_related_posts.execute),
        }),
        get_relationship: tool({
          description: scoutCatalog.get_relationship.description,
          parameters: scoutCatalog.get_relationship.parameters,
          execute: wrap("get_relationship", scoutCatalog.get_relationship.execute),
        }),
        get_tag_landscape: tool({
          description: scoutCatalog.get_tag_landscape.description,
          parameters: scoutCatalog.get_tag_landscape.parameters,
          execute: wrap("get_tag_landscape", scoutCatalog.get_tag_landscape.execute),
        }),
        get_emerging_topics: tool({
          description: scoutCatalog.get_emerging_topics.description,
          parameters: scoutCatalog.get_emerging_topics.parameters,
          execute: wrap("get_emerging_topics", scoutCatalog.get_emerging_topics.execute),
        }),
        get_debate_map: tool({
          description: scoutCatalog.get_debate_map.description,
          parameters: scoutCatalog.get_debate_map.parameters,
          execute: wrap("get_debate_map", scoutCatalog.get_debate_map.execute),
        }),
        query_graph: tool({
          description: scoutCatalog.query_graph.description,
          parameters: scoutCatalog.query_graph.parameters,
          execute: wrap("query_graph", scoutCatalog.query_graph.execute),
        }),
        search_users_by_name: tool({
          description: scoutCatalog.search_users_by_name.description,
          parameters: scoutCatalog.search_users_by_name.parameters,
          execute: wrap("search_users_by_name", scoutCatalog.search_users_by_name.execute),
        }),
      }
    : {};
  const webTool = createSearchWebTool({
    cfg,
    pool: scout?.pool,
    mentionKey: scout?.mentionKey,
    storeSwitchOn: scout?.storeWebSwitchOn ?? (async () => false),
  });
  const tools = {
    get_post: tool({
      description: catalog.get_post.description,
      parameters: catalog.get_post.parameters,
      execute: wrap("get_post", catalog.get_post.execute),
    }),
    get_thread: tool({
      description: catalog.get_thread.description,
      parameters: catalog.get_thread.parameters,
      execute: wrap("get_thread", catalog.get_thread.execute),
    }),
    get_user: tool({
      description: catalog.get_user.description,
      parameters: catalog.get_user.parameters,
      execute: wrap("get_user", catalog.get_user.execute),
    }),
    get_user_tags: tool({
      description: catalog.get_user_tags.description,
      parameters: catalog.get_user_tags.parameters,
      execute: wrap("get_user_tags", catalog.get_user_tags.execute),
    }),
    search_posts_by_tag: tool({
      description: catalog.search_posts_by_tag.description,
      parameters: catalog.search_posts_by_tag.parameters,
      execute: wrap("search_posts_by_tag", catalog.search_posts_by_tag.execute),
    }),
    get_post_replies: tool({
      description: catalog.get_post_replies.description,
      parameters: catalog.get_post_replies.parameters,
      execute: wrap("get_post_replies", catalog.get_post_replies.execute),
    }),
    search_knowledge: tool({
      description: "Search the versioned public Pubky/Synonym knowledge index and return citable URLs",
      parameters: searchKnowledgeParameters,
      execute: wrap(
        "search_knowledge",
        createSearchKnowledgeExecute({
          pool: scout?.pool,
          databaseUrl: cfg.databaseUrl,
          mentionKey: mention.uri,
        }).execute,
      ),
    }),
    search_web: tool({
      description: webTool.description,
      parameters: webTool.parameters,
      execute: wrap("search_web", webTool.execute),
    }),
    ...scoutTools,
  };
  const selected = Object.fromEntries(
    Object.entries(tools).filter(([n]) => allowed.has(n as never) || n === "search_knowledge"),
  );
  if (gate && (await gate.blocked())) throw new Error("generation switch on");
  if (budgetExceeded && (await budgetExceeded())) throw new Error("token budget exceeded");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), cfg.modelTimeoutMs);
  const trace: unknown[] = [];
  try {
    const genStarted = Date.now();
    const out = await generateText({
      model: openai(cfg.model),
      system: `${SYSTEM_PROMPT} ${modes.has("pubky_only") ? `${PUBKY_ONLY_ADDENDUM} ` : ""}${KNOWLEDGE_SYSTEM_ADDENDUM} ${SCOUT_SYSTEM_ADDENDUM} ${WEB_SEARCH_ADDENDUM}${intent === "evidence_map" ? ` ${EVIDENCE_MAP_ADDENDUM}` : ""}`,
      prompt: assemblePrompt(botPk, mention, chain),
      tools: selected,
      maxSteps: cfg.toolMaxSteps,
      temperature: modelTemperature(cfg),
      abortSignal: ac.signal,
      onStepFinish: (step) => {
        trace.push({
          toolCalls: step.toolCalls?.map((c) => ({ name: c.toolName, args: c.args })),
        });
      },
    });
    const genMs = Date.now() - genStarted;
    if (screenFlags.length) trace.push({ screening_flags: screenFlags });
    const composeStarted = Date.now();
    const composed = composeReply(out.text, modes, sources);
    const composeMs = Date.now() - composeStarted;
    const modelMs = Math.max(0, genMs - knowledgeMs - toolsMs);
    return {
      intent,
      content: composed.content,
      sources,
      toolTrace: trace,
      tokens: out.usage?.totalTokens ?? null,
      violations: composed.violations,
      phaseMs: { knowledge: knowledgeMs, tools: toolsMs, model: modelMs, compose: composeMs },
    };
  } finally {
    clearTimeout(t);
  }
}
