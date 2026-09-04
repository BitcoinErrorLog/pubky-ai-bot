import { createOpenAI } from "@ai-sdk/openai";
import { generateText, tool, type CoreMessage } from "ai";
import type pg from "pg";
import type { Config } from "./config.js";
import { composeReply, PUBKY_ONLY_ADDENDUM, systemPrompt } from "./compose.js";
import type { ChainPost } from "./context.js";
import { ancestorsNewestFirst, assemblePrompt } from "./context.js";
import { isAbortError } from "./fallback.js";
import { classifyIntent, DECLINE_REPLY, intentGuidance, toolsForIntent, type Intent } from "./intent.js";
import { log } from "./log.js";
import { parseModes } from "./modes.js";
import type { Nexus } from "./nexus.js";
import type { VoiceViolation } from "./voice.js";
import { KNOWLEDGE_SYSTEM_ADDENDUM } from "./knowledge/prompt.js";
import { createSearchKnowledgeExecute } from "./knowledge/tool.js";
import { SCOUT_SYSTEM_ADDENDUM } from "./scout/evidence.js";

export const EVIDENCE_LABEL_EVERYONE = "everyone:";
export const EVIDENCE_LABEL_WITHIN_TWO = "within 2 follows of you:";

export function evidenceMapAddendum(askerPubky: string): string {
  return [
    "For evidence_map, structure the reply as: (1) the claim, (2) supporting sources with URLs/URIs,",
    "(3) disputing sources with URLs/URIs, (4) what the Pubky graph says (Scout, as claims not facts),",
    "(5) Jeb's assessment, marked as Jeb's. Never a bare verdict.",
    `The mention author (asker) pubky is ${askerPubky}. Call trust_view with asker set to that pubky (hops=2)`,
    "for the claim's subject (target) or topic. For each label, report BOTH series, never a single verdict,",
    `using these labels: "${EVIDENCE_LABEL_EVERYONE} 14 taggers; ${EVIDENCE_LABEL_WITHIN_TWO} 3"`,
    "(substitute the real counts). If every graph_count is 0, say explicitly that the asker's 1–2 hop",
    "follow graph is empty for this claim (typical for a new user with no neighbourhood claimants).",
  ].join(" ");
}

export const EVIDENCE_MAP_ADDENDUM = evidenceMapAddendum("<asker-pubky>");

export const WEB_SEARCH_ADDENDUM =
  "When a search_web tool is present in this call, use it for current external events and cite the returned URLs. If search_web is not among the tools in this call, say so; do not invent sources. Do not claim web search is unavailable when the tool is present.";

export const CAPABILITY_ADDENDUM = [
  "You have Nexus Scout tools for emerging topics (get_emerging_topics), tag landscape (get_tag_landscape),",
  "what-changed (get_what_changed), debate maps (get_debate_map), identity summaries (get_identity_summary),",
  "relationship (get_relationship), follow recommendations (recommend_follows), follow_path, trust_view, top_posts,",
  "mentions_of, and profile_card, plus Nexus post/thread/user reads.",
  "Trending/most liked/popular posts → top_posts (the graph has no likes). How am I connected / 2-hop trust graph → follow_path.",
  "'In my network' claim counts → trust_view (report both global and your-graph numbers). Who mentioned me → mentions_of.",
  "Account snapshot → profile_card. Do not claim you lack a global feed, trending-metrics view, graph access, or Pubky Nexus when those tools are listed.",
].join(" ");

export const TRANSLATE_ADDENDUM = [
  "This mention asks for a translation. Fetch the parent or quoted post (get_post) or thread (get_thread).",
  "Translate that source faithfully. Do not add commentary unless the user asked for it.",
  "Lead with a line of the form Translation (src→dst) of <app link>: using the post's https://pubky.app/post/... URL.",
  "Parse the target language from the request; if none is named, use the language of the request itself.",
].join(" ");
import { InjectionDetector } from "./injection-detector.js";
import { extractionGuardChainAware, SECRET_DECLINE_REPLY, SECURITY_PROMPT_ADDENDUM } from "./extraction-guard.js";
import { metrics } from "./metrics.js";
import { modelTemperature } from "./model.js";
import { screenToolResult, type ScreenFlag } from "./tool-screen.js";
import { createScoutTools, createSearchWebTool, shouldRegisterSearchWeb, nexusTools, searchKnowledgeParameters } from "./tools.js";

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
  abortSignal?: AbortSignal,
  quotaPrefix?: string,
): Promise<AnswerResult> {
  // Extraction guard: deterministic pre-checks BEFORE any model call.
  // Secret/prompt/infra extraction attempts get a fixed decline (no token
  // spend, no leakage path); two safe meta questions get fixed answers.
  // When the mention is a bare follow-up ("yes", "answer it"), the newest
  // ancestor post is guarded too — the attack then lives one post up.
  const newestAncestor = ancestorsNewestFirst(chain).find((p) => p.uri !== mention.uri);
  const guard = extractionGuardChainAware(mention.content, newestAncestor?.content ?? null, { model: cfg.model });
  if (guard.action === "decline") {
    metrics.incrementSecurityEvent(guard.rule);
    log.warn({ event: "security_event", rule: guard.rule, mention_key: mention.uri }, "extraction attempt declined");
    return {
      intent: "decline",
      content: SECRET_DECLINE_REPLY,
      sources: [],
      toolTrace: [],
      tokens: 0,
      violations: [],
      phaseMs: ZERO_PHASE,
    };
  }
  if (guard.action === "fixed") {
    return { intent: "answer", content: guard.reply, sources: [], toolTrace: [], tokens: 0, violations: [], phaseMs: ZERO_PHASE };
  }
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
    const composed = composeReply(cfg.cannedReply, modes, sources, { quotaPrefix });
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
    const recordMs = () => {
      const toolMs = Date.now() - toolStarted;
      if (name === "search_knowledge") knowledgeMs += toolMs;
      else toolsMs += toolMs;
    };
    try {
      const out = await fn(args);
      recordMs();
      // F-03: tool results are untrusted data. Screen every string field for
      // instruction patterns and cap length before the model ever sees it.
      const screened = screenToolResult(detector, out, { tool: name });
      if (screened.flags.length) screenFlags.push(...screened.flags);
      return screened.value as R;
    } catch (e) {
      recordMs();
      if (isAbortError(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "generation switch on" || msg === "token budget exceeded") throw e;
      // Tool failures (bad URI, Nexus 400, network) are data the model can
      // recover from. R12 fallback is only if the whole loop still throws.
      const screened = screenToolResult(detector, { error: msg }, { tool: name });
      if (screened.flags.length) screenFlags.push(...screened.flags);
      return screened.value as R;
    }
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
        rank_users: tool({
          description: scoutCatalog.rank_users.description,
          parameters: scoutCatalog.rank_users.parameters,
          execute: wrap("rank_users", scoutCatalog.rank_users.execute),
        }),
        recommend_follows: tool({
          description: scoutCatalog.recommend_follows.description,
          parameters: scoutCatalog.recommend_follows.parameters,
          execute: wrap("recommend_follows", scoutCatalog.recommend_follows.execute),
        }),
        stale_follows: tool({
          description: scoutCatalog.stale_follows.description,
          parameters: scoutCatalog.stale_follows.parameters,
          execute: wrap("stale_follows", scoutCatalog.stale_follows.execute),
        }),
        follow_path: tool({
          description: scoutCatalog.follow_path.description,
          parameters: scoutCatalog.follow_path.parameters,
          execute: wrap("follow_path", scoutCatalog.follow_path.execute),
        }),
        trust_view: tool({
          description: scoutCatalog.trust_view.description,
          parameters: scoutCatalog.trust_view.parameters,
          execute: wrap("trust_view", scoutCatalog.trust_view.execute),
        }),
        top_posts: tool({
          description: scoutCatalog.top_posts.description,
          parameters: scoutCatalog.top_posts.parameters,
          execute: wrap("top_posts", scoutCatalog.top_posts.execute),
        }),
        mentions_of: tool({
          description: scoutCatalog.mentions_of.description,
          parameters: scoutCatalog.mentions_of.parameters,
          execute: wrap("mentions_of", scoutCatalog.mentions_of.execute),
        }),
        profile_card: tool({
          description: scoutCatalog.profile_card.description,
          parameters: scoutCatalog.profile_card.parameters,
          execute: wrap("profile_card", scoutCatalog.profile_card.execute),
        }),
      }
    : {};
  const webPool = scout?.pool;
  const webTool = shouldRegisterSearchWeb(cfg, webPool)
    ? createSearchWebTool({
        cfg,
        pool: webPool,
        mentionKey: scout?.mentionKey,
        storeSwitchOn: scout?.storeWebSwitchOn ?? (async () => false),
      })
    : null;
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
    ...(webTool
      ? {
          search_web: tool({
            description: webTool.description,
            parameters: webTool.parameters,
            execute: wrap("search_web", webTool.execute),
          }),
        }
      : {}),
    ...scoutTools,
  };
  const selected = Object.fromEntries(
    Object.entries(tools).filter(([n]) => allowed.has(n as never) || n === "search_knowledge"),
  );
  if (gate && (await gate.blocked())) throw new Error("generation switch on");
  if (budgetExceeded && (await budgetExceeded())) throw new Error("token budget exceeded");
  if (abortSignal?.aborted) throw abortError();
  const guidance = intentGuidance(intent);
  const evidenceMap = intent === "evidence_map" ? ` ${evidenceMapAddendum(mention.author)}` : "";
  const system = `${systemPrompt()} ${SECURITY_PROMPT_ADDENDUM} ${modes.has("pubky_only") ? `${PUBKY_ONLY_ADDENDUM} ` : ""}${KNOWLEDGE_SYSTEM_ADDENDUM} ${SCOUT_SYSTEM_ADDENDUM} ${CAPABILITY_ADDENDUM} ${WEB_SEARCH_ADDENDUM}${guidance ? ` ${guidance}` : ""}${evidenceMap}${intent === "translate" ? ` ${TRANSLATE_ADDENDUM}` : ""}`;
  const prompt = assemblePrompt(botPk, mention, chain);
  const trace: unknown[] = [];
  const genStarted = Date.now();
  const loop = await runAnswerLoop({
    cfg,
    openai,
    system,
    prompt,
    tools: selected,
    abortSignal,
    onStep: (step) => {
      trace.push({
        toolCalls: step.toolCalls?.map((c) => ({ name: c.toolName, args: c.args })),
      });
    },
  });
  const genMs = Date.now() - genStarted;
  if (loop.budgetExhausted) {
    trace.push({ budget_exhausted: true });
    log.warn({ budget_exhausted: true }, "answer budget exhausted; composing from evidence");
  }
  if (screenFlags.length) trace.push({ screening_flags: screenFlags });
  if (!loop.text && !loop.hasEvidence) throw new Error("no evidence and no text");
  const composeStarted = Date.now();
  const composed = composeReply(loop.text, modes, sources, { quotaPrefix });
  const composeMs = Date.now() - composeStarted;
  const modelMs = Math.max(0, genMs - knowledgeMs - toolsMs);
  return {
    intent,
    content: composed.content,
    sources,
    toolTrace: trace,
    tokens: loop.tokens,
    violations: composed.violations,
    phaseMs: { knowledge: knowledgeMs, tools: toolsMs, model: modelMs, compose: composeMs },
  };
}

const COMPOSE_FROM_EVIDENCE =
  "Compose from the evidence gathered so far; say what you could not check.";
const DETERMINISTIC_COMPOSE =
  "I gathered some graph evidence but could not finish composing from it. Ask a narrower cut and I'll try that slice.";

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function composeReserveMs(cfg: Config): number {
  const budget = cfg.answerBudgetMs ?? 180_000;
  return Math.min(cfg.modelTimeoutMs, Math.max(500, Math.floor(budget * 0.2)));
}

function stepHasEvidence(out: { text: string; toolCalls?: unknown[]; toolResults?: unknown[] }): boolean {
  if (out.text.trim()) return true;
  if (out.toolCalls && out.toolCalls.length > 0) return true;
  if (out.toolResults && out.toolResults.length > 0) return true;
  return false;
}

async function runWithStepTimeout<T>(
  ms: number,
  parent: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent?.aborted) throw abortError();
  const ac = new AbortController();
  const onParent = () => ac.abort();
  parent?.addEventListener("abort", onParent);
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(t);
    parent?.removeEventListener("abort", onParent);
  }
}

async function runAnswerLoop(opts: {
  cfg: Config;
  openai: ReturnType<typeof createOpenAI>;
  system: string;
  prompt: string;
  tools: Record<string, unknown>;
  abortSignal?: AbortSignal;
  onStep: (step: { toolCalls?: Array<{ toolName: string; args: unknown }> }) => void;
}): Promise<{ text: string; tokens: number | null; hasEvidence: boolean; budgetExhausted: boolean }> {
  const deadline = Date.now() + (opts.cfg.answerBudgetMs ?? 180_000);
  const reserve = composeReserveMs(opts.cfg);
  let messages: CoreMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.prompt },
  ];
  let text = "";
  let tokens = 0;
  let hasEvidence = false;
  let budgetExhausted = false;
  const remaining = () => deadline - Date.now();

  const generate = async (
    stepMessages: CoreMessage[],
    tools: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    toolCalls?: Array<{ toolName: string; args: unknown }>;
    toolResults?: unknown[];
    usage?: { totalTokens?: number };
    response: { messages: CoreMessage[] };
  }> => {
    const out = await generateText({
      model: opts.openai(opts.cfg.model),
      messages: stepMessages,
      maxSteps: 1,
      maxRetries: 0,
      temperature: modelTemperature(opts.cfg),
      abortSignal: signal,
      ...(tools ? { tools } : {}),
    } as Parameters<typeof generateText>[0]);
    return out as {
      text: string;
      toolCalls?: Array<{ toolName: string; args: unknown }>;
      toolResults?: unknown[];
      usage?: { totalTokens?: number };
      response: { messages: CoreMessage[] };
    };
  };

  for (let step = 0; step < opts.cfg.toolMaxSteps; step++) {
    if (opts.abortSignal?.aborted) throw abortError();
    if (remaining() <= reserve) {
      budgetExhausted = true;
      break;
    }
    const stepMs = Math.min(opts.cfg.modelTimeoutMs, Math.max(1, remaining() - reserve));
    try {
      const out = await runWithStepTimeout(stepMs, opts.abortSignal, (signal) =>
        generate(messages, opts.tools, signal),
      );
      opts.onStep({
        toolCalls: out.toolCalls?.map((c) => ({ toolName: c.toolName, args: c.args })),
      });
      if (stepHasEvidence(out)) hasEvidence = true;
      if (out.text.trim()) text = out.text;
      tokens += out.usage?.totalTokens ?? 0;
      messages = [...messages, ...(out.response.messages as CoreMessage[])];
      if (!out.toolCalls?.length) {
        return { text, tokens: tokens || null, hasEvidence, budgetExhausted };
      }
    } catch (e) {
      if (opts.abortSignal?.aborted) throw abortError();
      if (isAbortError(e) && hasEvidence) {
        budgetExhausted = true;
        break;
      }
      throw e;
    }
  }

  if (!hasEvidence && !text.trim()) {
    return { text: "", tokens: tokens || null, hasEvidence: false, budgetExhausted };
  }
  const composeMessages: CoreMessage[] = [
    ...messages,
    { role: "user", content: COMPOSE_FROM_EVIDENCE },
  ];
  const composeMs = Math.min(opts.cfg.modelTimeoutMs, Math.max(1, remaining()));
  try {
    const out = await runWithStepTimeout(composeMs, opts.abortSignal, (signal) =>
      generate(composeMessages, undefined, signal),
    );
    if (out.text.trim()) text = out.text;
    tokens += out.usage?.totalTokens ?? 0;
  } catch (e) {
    if (opts.abortSignal?.aborted) throw abortError();
    if (!isAbortError(e) && !text.trim()) throw e;
    if (!text.trim()) text = DETERMINISTIC_COMPOSE;
  }
  if (!text.trim()) text = DETERMINISTIC_COMPOSE;
  return { text, tokens: tokens || null, hasEvidence: true, budgetExhausted };
}
