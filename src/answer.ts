import type pg from "pg";
import {
  createToolLoop,
  type ToolLoopSpec,
} from "./bot-kit/answer/tool-loop.js";
import type { Config } from "./config.js";
import { composeReply, PUBKY_ONLY_ADDENDUM, systemPrompt } from "./compose.js";
import type { ChainPost } from "./context.js";
import { ancestorsNewestFirst, assemblePrompt, JEB_THREAD_IDENTITY } from "./context.js";
import { isAbortError } from "./fallback.js";
import { classifyIntent, DECLINE_REPLY, intentGuidance, toolsForIntent, type Intent } from "./intent.js";
import { log } from "./log.js";
import { parseModes } from "./modes.js";
import type { Nexus } from "./nexus.js";
import type { VoiceViolation } from "./voice.js";
import { KNOWLEDGE_SYSTEM_ADDENDUM } from "./knowledge/prompt.js";
import { createSearchKnowledgeExecute } from "./knowledge/tool.js";
import { SCOUT_SYSTEM_ADDENDUM } from "./scout/evidence.js";
import { InjectionDetector } from "./injection-detector.js";
import { extractionGuardChainAware, SECRET_DECLINE_REPLY, SECURITY_PROMPT_ADDENDUM } from "./extraction-guard.js";
import { metrics } from "./metrics.js";
import { createJebBrain } from "./model.js";
import { screenToolResult } from "./tool-screen.js";
import { createScoutTools, createSearchWebTool, shouldRegisterSearchWeb, nexusTools, searchKnowledgeParameters } from "./tools.js";

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

const COMPOSE_FROM_EVIDENCE =
  "Compose from the evidence gathered so far; say what you could not check.";
const DETERMINISTIC_COMPOSE =
  "I gathered some graph evidence but could not finish composing from it. Ask a narrower cut and I'll try that slice.";

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function asSpec(t: { description: string; parameters: unknown; execute: (args: never) => Promise<unknown> }): ToolLoopSpec {
  return { description: t.description, parameters: t.parameters, execute: t.execute };
}

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
  if (cfg.brain !== "ollama" && !cfg.modelApiKey) throw new Error("no model key");
  const brain = createJebBrain(cfg);
  const allowed = new Set(toolsForIntent(intent));
  const catalog = nexusTools(nexus);
  const detector = new InjectionDetector();
  const scoutCatalog = scout
    ? createScoutTools({
        cfg,
        pool: scout.pool,
        mentionKey: scout.mentionKey,
        author: scout.author,
        storeSwitchOn: scout.storeSwitchOn,
      })
    : null;
  const webPool = scout?.pool;
  const webTool = shouldRegisterSearchWeb(cfg, webPool)
    ? createSearchWebTool({
        cfg,
        pool: webPool,
        mentionKey: scout?.mentionKey,
        storeSwitchOn: scout?.storeWebSwitchOn ?? (async () => false),
      })
    : null;
  const tools: Record<string, ToolLoopSpec> = {
    get_post: asSpec(catalog.get_post),
    get_thread: asSpec(catalog.get_thread),
    get_user: asSpec(catalog.get_user),
    get_user_tags: asSpec(catalog.get_user_tags),
    search_posts_by_tag: asSpec(catalog.search_posts_by_tag),
    get_post_replies: asSpec(catalog.get_post_replies),
    search_knowledge: {
      description: "Search the versioned public Pubky/Synonym knowledge index and return citable URLs",
      parameters: searchKnowledgeParameters,
      execute: createSearchKnowledgeExecute({
        pool: scout?.pool,
        databaseUrl: cfg.databaseUrl,
        mentionKey: mention.uri,
      }).execute as ToolLoopSpec["execute"],
    },
    ...(webTool
      ? {
          search_web: asSpec(webTool),
        }
      : {}),
    ...(scoutCatalog
      ? Object.fromEntries(Object.entries(scoutCatalog).map(([n, t]) => [n, asSpec(t)]))
      : {}),
  };
  const selected = Object.fromEntries(
    Object.entries(tools).filter(([n]) => allowed.has(n as never) || n === "search_knowledge"),
  );
  if (gate && (await gate.blocked())) throw new Error("generation switch on");
  if (budgetExceeded && (await budgetExceeded())) throw new Error("token budget exceeded");
  if (abortSignal?.aborted) throw abortError();
  const guidance = intentGuidance(intent);
  const evidenceMap = intent === "evidence_map" ? ` ${evidenceMapAddendum(mention.author)}` : "";
  const extra = `${evidenceMap}${intent === "translate" ? ` ${TRANSLATE_ADDENDUM}` : ""}`;
  const prompt = assemblePrompt(botPk, mention, chain);
  const genStarted = Date.now();
  const loop = createToolLoop({
    model: brain,
    tools: selected,
    screen: (value, { tool: name }) => screenToolResult(detector, value, { tool: name }),
    compose: {
      fromEvidencePrompt: COMPOSE_FROM_EVIDENCE,
      deterministicText: DETERMINISTIC_COMPOSE,
    },
    timeouts: { modelTimeoutMs: cfg.modelTimeoutMs },
    budgets: { answerBudgetMs: cfg.answerBudgetMs ?? 180_000, toolMaxSteps: cfg.toolMaxSteps },
    identity: {
      systemPrompt: systemPrompt(),
      assistantRoleLabel: JEB_THREAD_IDENTITY.assistantRoleLabel,
      introLine: JEB_THREAD_IDENTITY.introLine,
    },
    addenda: {
      security: SECURITY_PROMPT_ADDENDUM,
      knowledge: KNOWLEDGE_SYSTEM_ADDENDUM,
      scout: SCOUT_SYSTEM_ADDENDUM,
      capability: CAPABILITY_ADDENDUM,
      webSearch: WEB_SEARCH_ADDENDUM,
      pubkyOnly: modes.has("pubky_only") ? PUBKY_ONLY_ADDENDUM : undefined,
      guidance,
      extra,
    },
    beforeTool: async () => {
      if (gate && (await gate.blocked())) throw new Error("generation switch on");
      if (budgetExceeded && (await budgetExceeded())) throw new Error("token budget exceeded");
    },
    knowledgeTool: (name) => name === "search_knowledge",
    isAbortError,
  });
  const result = await loop.run({ prompt, abortSignal });
  const genMs = Date.now() - genStarted;
  if (result.outcome === "deadline" && !result.hasEvidence && !result.text.trim()) {
    throw abortError();
  }
  if (result.budgetExhausted) {
    log.warn({ budget_exhausted: true }, "answer budget exhausted; composing from evidence");
  }
  if (!result.text && !result.hasEvidence) throw new Error("no evidence and no text");
  const composeStarted = Date.now();
  const composed = composeReply(result.text, modes, sources, { quotaPrefix });
  const composeMs = Date.now() - composeStarted;
  const modelMs = Math.max(0, genMs - result.knowledgeMs - result.toolsMs);
  return {
    intent,
    content: composed.content,
    sources,
    toolTrace: result.toolTrace,
    tokens: result.tokens,
    violations: composed.violations,
    phaseMs: { knowledge: result.knowledgeMs, tools: result.toolsMs, model: modelMs, compose: composeMs },
  };
}
