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
import { createScoutTools, nexusTools, searchKnowledgeParameters } from "./tools.js";

export interface AnswerResult {
  intent: Intent;
  content: string | null;
  sources: string[];
  toolTrace: unknown[];
  tokens: number | null;
  violations: VoiceViolation[];
}

export async function answerMention(
  cfg: Config,
  nexus: Nexus,
  botPk: string,
  mention: ChainPost,
  chain: ChainPost[],
  gate?: { blocked: () => Promise<boolean> },
  scout?: { pool: pg.Pool; mentionKey: string; author: string; storeSwitchOn: () => Promise<boolean> },
): Promise<AnswerResult> {
  const intent = classifyIntent({
    text: mention.content,
    authorIsBot: false,
    isSelf: mention.author === botPk,
  });
  if (intent === "ignore") return { intent, content: null, sources: [], toolTrace: [], tokens: 0, violations: [] };
  if (intent === "decline") {
    return { intent, content: DECLINE_REPLY, sources: [], toolTrace: [], tokens: 0, violations: [] };
  }
  const modes = parseModes(mention.content);
  const sources = chain.map((p) => p.uri);
  if (cfg.cannedReply !== undefined && cfg.cannedReply !== "") {
    const composed = composeReply(cfg.cannedReply, modes, sources);
    return { intent: "answer", content: composed.content, sources, toolTrace: [], tokens: 0, violations: composed.violations };
  }
  if (!cfg.modelApiKey) throw new Error("no model key");
  const openai = createOpenAI({ apiKey: cfg.modelApiKey, baseURL: cfg.modelBaseUrl });
  const allowed = new Set(toolsForIntent(intent));
  const catalog = nexusTools(nexus);
  const wrap = <A, R>(fn: (args: A) => Promise<R>) => async (args: A) => {
    if (gate && (await gate.blocked())) throw new Error("generation switch on");
    return fn(args);
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
          execute: wrap(scoutCatalog.search_posts.execute),
        }),
        scout_get_thread: tool({
          description: scoutCatalog.scout_get_thread.description,
          parameters: scoutCatalog.scout_get_thread.parameters,
          execute: wrap(scoutCatalog.scout_get_thread.execute),
        }),
        get_identity_summary: tool({
          description: scoutCatalog.get_identity_summary.description,
          parameters: scoutCatalog.get_identity_summary.parameters,
          execute: wrap(scoutCatalog.get_identity_summary.execute),
        }),
        get_topic_brief: tool({
          description: scoutCatalog.get_topic_brief.description,
          parameters: scoutCatalog.get_topic_brief.parameters,
          execute: wrap(scoutCatalog.get_topic_brief.execute),
        }),
        get_what_changed: tool({
          description: scoutCatalog.get_what_changed.description,
          parameters: scoutCatalog.get_what_changed.parameters,
          execute: wrap(scoutCatalog.get_what_changed.execute),
        }),
        get_related_posts: tool({
          description: scoutCatalog.get_related_posts.description,
          parameters: scoutCatalog.get_related_posts.parameters,
          execute: wrap(scoutCatalog.get_related_posts.execute),
        }),
        get_relationship: tool({
          description: scoutCatalog.get_relationship.description,
          parameters: scoutCatalog.get_relationship.parameters,
          execute: wrap(scoutCatalog.get_relationship.execute),
        }),
        get_tag_landscape: tool({
          description: scoutCatalog.get_tag_landscape.description,
          parameters: scoutCatalog.get_tag_landscape.parameters,
          execute: wrap(scoutCatalog.get_tag_landscape.execute),
        }),
        get_emerging_topics: tool({
          description: scoutCatalog.get_emerging_topics.description,
          parameters: scoutCatalog.get_emerging_topics.parameters,
          execute: wrap(scoutCatalog.get_emerging_topics.execute),
        }),
        get_debate_map: tool({
          description: scoutCatalog.get_debate_map.description,
          parameters: scoutCatalog.get_debate_map.parameters,
          execute: wrap(scoutCatalog.get_debate_map.execute),
        }),
        query_graph: tool({
          description: scoutCatalog.query_graph.description,
          parameters: scoutCatalog.query_graph.parameters,
          execute: wrap(scoutCatalog.query_graph.execute),
        }),
        search_users_by_name: tool({
          description: scoutCatalog.search_users_by_name.description,
          parameters: scoutCatalog.search_users_by_name.parameters,
          execute: wrap(scoutCatalog.search_users_by_name.execute),
        }),
      }
    : {};
  const tools = {
    get_post: tool({
      description: catalog.get_post.description,
      parameters: catalog.get_post.parameters,
      execute: wrap(catalog.get_post.execute),
    }),
    get_thread: tool({
      description: catalog.get_thread.description,
      parameters: catalog.get_thread.parameters,
      execute: wrap(catalog.get_thread.execute),
    }),
    get_user: tool({
      description: catalog.get_user.description,
      parameters: catalog.get_user.parameters,
      execute: wrap(catalog.get_user.execute),
    }),
    get_user_tags: tool({
      description: catalog.get_user_tags.description,
      parameters: catalog.get_user_tags.parameters,
      execute: wrap(catalog.get_user_tags.execute),
    }),
    search_posts_by_tag: tool({
      description: catalog.search_posts_by_tag.description,
      parameters: catalog.search_posts_by_tag.parameters,
      execute: wrap(catalog.search_posts_by_tag.execute),
    }),
    get_post_replies: tool({
      description: catalog.get_post_replies.description,
      parameters: catalog.get_post_replies.parameters,
      execute: wrap(catalog.get_post_replies.execute),
    }),
    search_knowledge: tool({
      description: "Search the versioned public Pubky/Synonym knowledge index and return citable URLs",
      parameters: searchKnowledgeParameters,
      execute: createSearchKnowledgeExecute(cfg.databaseUrl, mention.uri).execute,
    }),
    ...scoutTools,
  };
  const selected = Object.fromEntries(
    Object.entries(tools).filter(([n]) => allowed.has(n as never) || n === "search_knowledge"),
  );
  if (gate && (await gate.blocked())) throw new Error("generation switch on");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), cfg.modelTimeoutMs);
  const trace: unknown[] = [];
  try {
    const out = await generateText({
      model: openai(cfg.model),
      system: `${SYSTEM_PROMPT} ${modes.has("pubky_only") ? `${PUBKY_ONLY_ADDENDUM} ` : ""}${KNOWLEDGE_SYSTEM_ADDENDUM} ${SCOUT_SYSTEM_ADDENDUM}`,
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
      violations: composed.violations,
    };
  } finally {
    clearTimeout(t);
  }
}
