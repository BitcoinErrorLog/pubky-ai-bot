import type pg from "pg";
import {
  createToolLoop,
  type ToolLoopSpec,
} from "./bot-kit/answer/tool-loop.js";
import type { Config } from "./config.js";
import { composeReply, PUBKY_ONLY_ADDENDUM, systemPrompt } from "./compose.js";
import type { ChainPost } from "./context.js";
import { ancestorsNewestFirst, asChainPost, assemblePrompt, JEB_THREAD_IDENTITY } from "./context.js";
import { isAbortError } from "./fallback.js";
import { classifyIntent, DECLINE_REPLY, intentGuidance, toolsForIntent, type Intent } from "./intent.js";
import { log } from "./log.js";
import { parseModes } from "./modes.js";
import type { Nexus } from "./nexus.js";
import type { VoiceViolation } from "./voice.js";
import { KNOWLEDGE_SYSTEM_ADDENDUM } from "./knowledge/prompt.js";
import { contextualKnowledgeQuery, GRAPH_TAG_TOOLS, routeKnowledgeQuestion } from "./knowledge/route.js";
import { createSearchKnowledgeExecute } from "./knowledge/tool.js";
import { SCOUT_SYSTEM_ADDENDUM } from "./scout/evidence.js";
import { InjectionDetector } from "./injection-detector.js";
import { extractionGuardChainAware, SECRET_DECLINE_REPLY, SECURITY_PROMPT_ADDENDUM } from "./extraction-guard.js";
import { metrics } from "./metrics.js";
import { createJebBrain } from "./model.js";
import { ImageContext, type ImageContextDeps } from "./image-understanding.js";
import { emitImageEvent } from "./image-observability.js";
import {
  estimateModelCallHardUpperBound,
  messagesContainImages,
  withoutImages,
} from "./model-call-budget.js";
import {
  releaseTextTokens,
  reserveTextTokens,
  reserveVisualTokens,
  settleVisualTokens,
  type TextTokenReservation,
  type TokenLedgerPersona,
  type VisualTokenReservation,
} from "./visual-token-reservation.js";
import { screenToolResult } from "./tool-screen.js";
import { explicitInteractionUrisFromAnswer } from "./tags-propose.js";
import {
  createScoutTools,
  createSearchWebTool,
  shouldRegisterSearchWeb,
  nexusTools,
  searchKnowledgeParameters,
  type WebEvidenceRecord,
} from "./tools.js";
import type { RuntimePersona } from "./personas/runtime.js";
import { assertPersonaToolExecution, selectPersonaToolNames } from "./personas/capabilities.js";
import type { PersonaStageSwitch } from "./personas/switches.js";
import type { PersonaLedgerIdentity } from "./bot-kit/policy/persona-ledger.js";

export const EVIDENCE_LABEL_EVERYONE = "everyone:";
export const EVIDENCE_LABEL_WITHIN_TWO = "within 2 follows of you:";

function personaNamespace(persona: RuntimePersona): string {
  return persona.snapshot.pack.corpus_namespace;
}

export function personaKnowledgePathFilter(namespace: string): {
  includePathPrefix?: string;
  excludePathPrefix?: string;
} {
  if (namespace === "global") return { excludePathPrefix: "personas/" };
  const match = /^persona\/([a-z0-9]+(?:-[a-z0-9]+)*)\/[^/\s]+$/.exec(namespace);
  if (!match) throw new Error(`invalid persona corpus namespace: ${namespace}`);
  return { includePathPrefix: `personas/${match[1]}/` };
}

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
  visualUsageTokens?: number | null;
  violations: VoiceViolation[];
  phaseMs: PhaseMs;
  visualReservation?: VisualTokenReservation;
  interactionPostUris: string[];
  textReservation?: TextTokenReservation;
}

const ZERO_PHASE: PhaseMs = { knowledge: 0, tools: 0, model: 0, compose: 0 };

const COMPOSE_FROM_EVIDENCE =
  "Compose from the evidence gathered so far; say what you could not check.";
const DETERMINISTIC_COMPOSE =
  "I gathered evidence, but answer composition failed or timed out. Please retry.";

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
    /** Persona `global` OR stage switch for the answering persona. */
    personaSwitchOn?: (stage: PersonaStageSwitch) => Promise<boolean>;
    /** Test transport only; production leaves this absent and uses pinned HTTPS. */
    imageDeps?: Pick<ImageContextDeps, "fetchImpl" | "allowPrivateForTests" | "allowHttpForTests">;
  },
  budgetExceeded?: () => Promise<boolean>,
  abortSignal?: AbortSignal,
  quotaPrefix?: string,
  answeredMentionUris: ReadonlySet<string> = new Set(),
  persona?: RuntimePersona,
): Promise<AnswerResult> {
  // Extraction guard: deterministic pre-checks BEFORE any model call.
  // Secret/prompt/infra extraction attempts get a fixed decline (no token
  // spend, no leakage path); two safe meta questions get fixed answers.
  // When the mention is a bare follow-up ("yes", "answer it"), the newest
  // ancestor post is guarded too — the attack then lives one post up.
  const newestAncestor = ancestorsNewestFirst(chain).find((p) => p.uri !== mention.uri);
  const guard = extractionGuardChainAware(mention.content, newestAncestor?.content ?? null, {
    model: cfg.model,
    sourceUrl: persona?.snapshot.binding.identity.policy_url,
    identityDisclosure: persona?.identityDisclosure,
    displayName: persona?.snapshot.binding.identity.display_name,
    operator: persona?.snapshot.binding.identity.operator,
  });
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
      interactionPostUris: [],
    };
  }
  if (guard.action === "fixed") {
    return { intent: "answer", content: guard.reply, sources: [], toolTrace: [], tokens: 0, violations: [], phaseMs: ZERO_PHASE, interactionPostUris: [] };
  }
  const intent = classifyIntent({
    text: mention.content,
    authorIsBot: false,
    isSelf: mention.author === botPk,
  });
  if (intent === "ignore") {
    return { intent, content: null, sources: [], toolTrace: [], tokens: 0, violations: [], phaseMs: ZERO_PHASE, interactionPostUris: [] };
  }
  if (intent === "decline") {
    return { intent, content: DECLINE_REPLY, sources: [], toolTrace: [], tokens: 0, violations: [], phaseMs: ZERO_PHASE, interactionPostUris: [] };
  }
  const workflowCapability =
    intent === "translate"
      ? "translate"
      : intent === "evidence_map"
        ? "evidence_map"
        : null;
  if (persona && workflowCapability && !persona.capabilities.enabled.has(workflowCapability)) {
    return {
      intent: "decline",
      content: DECLINE_REPLY,
      sources: [],
      toolTrace: [],
      tokens: 0,
      violations: [],
      phaseMs: ZERO_PHASE,
      interactionPostUris: [],
    };
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
      interactionPostUris: explicitInteractionUrisFromAnswer(cfg.cannedReply),
    };
  }
  if (cfg.brain !== "ollama" && !cfg.modelApiKey) throw new Error("no model key");
  const brain = createJebBrain(cfg);
  const intentAllowed = new Set<string>(toolsForIntent(intent));
  const catalog = nexusTools(nexus);
  const detector = new InjectionDetector();
  const webEvidence: WebEvidenceRecord[] = [];
  const personaBudgets = persona?.snapshot.binding.budgets;
  const personaIdentity: PersonaLedgerIdentity | undefined = persona
    ? {
        id: persona.snapshot.pack.id,
        version: persona.snapshot.pack.version,
        manifestHash: persona.snapshot.snapshotHash,
        botPk,
      }
    : undefined;
  const tokenPersona: TokenLedgerPersona | undefined = personaIdentity && personaBudgets
    ? {
        identity: personaIdentity,
        dailyTokens: personaBudgets.daily_tokens,
        userDailyTokens: personaBudgets.per_user_daily_tokens,
        imageDailyTokens: personaBudgets.image_tokens_daily,
      }
    : undefined;
  // Persona ceilings exist only in the Postgres ledgers; without them the call is unbounded.
  if (tokenPersona && !scout?.pool) throw new Error("token budget bound unavailable");
  const scoutCatalog = scout
    ? createScoutTools({
        cfg,
        pool: scout.pool,
        mentionKey: scout.mentionKey,
        author: scout.author,
        storeSwitchOn: scout.storeSwitchOn,
        persona: personaIdentity && personaBudgets
          ? {
              identity: personaIdentity,
              dailyCeiling: personaBudgets.scout_calls_daily,
              perMentionCeiling: personaBudgets.scout_calls_per_mention,
            }
          : undefined,
      })
    : null;
  const webPool = scout?.pool;
  const webTool = shouldRegisterSearchWeb(cfg, webPool)
    ? createSearchWebTool({
        cfg: personaBudgets
          ? { ...cfg, webPerMentionCap: Math.min(cfg.webPerMentionCap, personaBudgets.web_calls_per_mention) }
          : cfg,
        pool: webPool,
        mentionKey: scout?.mentionKey,
        storeSwitchOn: scout?.storeWebSwitchOn ?? (async () => false),
        persona: personaIdentity && personaBudgets
          ? { identity: personaIdentity, dailyCeiling: personaBudgets.web_calls_daily }
          : undefined,
        onEvidence: (record) => {
          webEvidence.push(record);
          if ("sources" in record) {
            for (const source of record.sources ?? []) {
              if (!sources.includes(source.url)) sources.push(source.url);
            }
          } else if (record.url && !sources.includes(record.url)) {
            sources.push(record.url);
          }
        },
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
        ...personaKnowledgePathFilter(persona ? personaNamespace(persona) : "global"),
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
  const selectedNames = persona
    ? new Set(selectPersonaToolNames(intentAllowed, Object.keys(tools), persona.capabilities))
    : new Set([...intentAllowed, "search_knowledge"]);
  const selected = Object.fromEntries(
    Object.entries(tools)
      .filter(([name]) => selectedNames.has(name))
      .map(([name, spec]) => [
        name,
        {
          ...spec,
          execute: async (args: never) => {
            if (persona) assertPersonaToolExecution(name, persona.capabilities);
            return spec.execute(args);
          },
        },
      ]),
  );
  const knowledgeRoute = routeKnowledgeQuestion(mention.content, undefined, intent);
  const knowledgeQuery = contextualKnowledgeQuery(mention, chain, botPk);
  const knowledgeFirst = knowledgeRoute.requireKnowledge && knowledgeQuery && "search_knowledge" in selected
    ? {
        tool: "search_knowledge",
        args: { query: knowledgeQuery },
        graphTools: GRAPH_TAG_TOOLS,
        allowGraphTools: knowledgeRoute.allowGraphTools,
      }
    : undefined;
  if (gate && (await gate.blocked())) throw new Error("generation switch on");
  if (budgetExceeded && (await budgetExceeded())) throw new Error("token budget exceeded");
  if (abortSignal?.aborted) throw abortError();
  const answerDeadline = Date.now() + (cfg.answerBudgetMs ?? 180_000);
  const imageBudgetSignal = AbortSignal.timeout(cfg.answerBudgetMs ?? 180_000);
  const imageAbortSignal = abortSignal ? AbortSignal.any([abortSignal, imageBudgetSignal]) : imageBudgetSignal;
  // Images are never sent to a provider without the authoritative Postgres
  // reservation path. Production reason calls always provide scout.pool.
  const imagesSwitchedOff = async () =>
    scout?.personaSwitchOn ? scout.personaSwitchOn("images") : false;
  const imagesEnabled =
    cfg.imageEnabled &&
    brain.capabilities.supportsImages &&
    Boolean(scout?.pool) &&
    (!persona || persona.capabilities.enabled.has("image_read")) &&
    !(await imagesSwitchedOff());
  let visualReservation: VisualTokenReservation | undefined;
  let modelStartedAt: number | null = null;
  let imageModelCalls = 0;
  let textReservation: TextTokenReservation | undefined;
  const answerBudgetMs = cfg.answerBudgetMs ?? 180_000;
  const reservationTtlMs = Math.max(answerBudgetMs, cfg.replyDeadlineMs ?? answerBudgetMs) + 30_000;
  const imageContext = new ImageContext({ ...cfg, imageEnabled: imagesEnabled }, {
    ...scout?.imageDeps,
    abortSignal: imageAbortSignal,
    fetchPost: async (uri) => {
      const post = await nexus.post(uri);
      return post ? asChainPost(post) : null;
    },
  });
  const admitImageCall = async (
    messages: Parameters<typeof withoutImages>[0],
    toolSchemas: Parameters<typeof estimateModelCallHardUpperBound>[0]["toolSchemas"],
    maxOutputTokens: number | undefined,
  ): Promise<boolean> => {
    if (!scout?.pool || !maxOutputTokens) return false;
    if (await imagesSwitchedOff()) return false;
    let callBound: number;
    try {
      callBound = estimateModelCallHardUpperBound({
        messages,
        toolSchemas,
        visualTokens: imageContext.visualTokensIn(messages),
        maxOutputTokens,
      });
    } catch {
      log.warn({ event: "image_call_bound_failed", mention_key: scout.mentionKey }, "dropping images from unbounded model call");
      return false;
    }
    const previousEstimatedTokens = visualReservation?.estimatedTokens ?? 0;
    const targetTokens = previousEstimatedTokens + callBound;
    const reservationStarted = Date.now();
    try {
      const next = await reserveVisualTokens(scout.pool, {
        mentionKey: scout.mentionKey,
        publicKey: scout.author,
        targetTokens,
        globalCeiling: cfg.dailyTokenBudget,
        userCeiling: cfg.userDailyTokenBudget,
        staleAfterMs: reservationTtlMs,
        reservation: visualReservation,
        persona: tokenPersona,
      });
      emitImageEvent(
        "info",
        "reservation",
        "image_reservation",
        next ? "reserved" : "denied",
        {
          previous_estimated_tokens: previousEstimatedTokens,
          target_estimated_tokens: targetTokens,
          duration_ms: Date.now() - reservationStarted,
        },
        "image reservation completed",
      );
      if (!next) return false;
      visualReservation = next;
      imageModelCalls += 1;
      return true;
    } catch (error) {
      emitImageEvent(
        "warn",
        "reservation",
        "image_reservation",
        "error",
        {
          previous_estimated_tokens: previousEstimatedTokens,
          target_estimated_tokens: targetTokens,
          duration_ms: Date.now() - reservationStarted,
        },
        "image reservation failed",
      );
      throw error;
    }
  };
  try {
    await imageContext.addPosts([mention], "mention");
    await imageContext.addPosts(chain.filter((post) => post.uri !== mention.uri), "thread");
    if (abortSignal?.aborted) throw abortError();
    const guidance = intentGuidance(intent);
    const evidenceMap = intent === "evidence_map" ? ` ${evidenceMapAddendum(mention.author)}` : "";
    const knowledgeRouteSentence = !knowledgeFirst
      ? ""
      : knowledgeRoute.allowGraphTools
        ? " search_knowledge has already run for this question. Use that evidence before any graph or tag tool."
        : " search_knowledge has already run for this question. Graph and tag tools are withheld; answer from the knowledge evidence.";
    const extra = `${evidenceMap}${intent === "translate" ? ` ${TRANSLATE_ADDENDUM}` : ""}${knowledgeRouteSentence}`;
    const prompt = assemblePrompt(
      botPk,
      mention,
      chain,
      undefined,
      answeredMentionUris,
      persona?.threadIdentity,
    );
    const genStarted = Date.now();
    modelStartedAt = genStarted;
    const loop = createToolLoop({
      model: brain,
      tools: selected,
      screen: (value, { tool: name }) => screenToolResult(detector, value, { tool: name }),
      compose: {
        fromEvidencePrompt: COMPOSE_FROM_EVIDENCE,
        deterministicText: DETERMINISTIC_COMPOSE,
      },
      timeouts: { modelTimeoutMs: cfg.modelTimeoutMs },
      budgets: { answerBudgetMs: Math.max(1, answerDeadline - Date.now()), toolMaxSteps: cfg.toolMaxSteps },
      knowledgeFirst,
      maxOutputTokens: cfg.modelMaxOutputTokens,
      identity: {
        systemPrompt: persona?.systemPrompt ?? systemPrompt(),
        assistantRoleLabel: persona?.threadIdentity.assistantRoleLabel ?? JEB_THREAD_IDENTITY.assistantRoleLabel,
        introLine: persona?.threadIdentity.introLine ?? JEB_THREAD_IDENTITY.introLine,
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
      beforeModel: async ({ messages, toolSchemas, maxOutputTokens }) => {
        if (gate && (await gate.blocked())) throw new Error("generation switch on");
        if (budgetExceeded && (await budgetExceeded())) throw new Error("token budget exceeded");
        const imageBearing = messagesContainImages(messages);
        if (imageBearing && (await admitImageCall(messages, toolSchemas, maxOutputTokens))) return;
        const callMessages = imageBearing ? withoutImages(messages) : messages;
        if (!scout?.pool) return imageBearing ? callMessages : undefined;
        let callBound: number;
        try {
          callBound = estimateModelCallHardUpperBound({
            messages: callMessages,
            toolSchemas,
            visualTokens: imageContext.visualTokensIn(callMessages),
            maxOutputTokens: maxOutputTokens ?? cfg.modelMaxOutputTokens,
          });
        } catch {
          throw new Error("token budget bound unavailable");
        }
        const next = await reserveTextTokens(scout.pool, {
          mentionKey: scout.mentionKey,
          publicKey: scout.author,
          targetTokens: (textReservation?.estimatedTokens ?? 0) + callBound,
          globalCeiling: cfg.dailyTokenBudget,
          userCeiling: cfg.userDailyTokenBudget,
          staleAfterMs: reservationTtlMs,
          reservation: textReservation,
          persona: tokenPersona,
        });
        if (!next) throw new Error("token budget exceeded");
        textReservation = next;
        return imageBearing ? callMessages : undefined;
      },
      afterTool: async (name, value) => {
        if (name === "search_knowledge" || name === "search_web") return;
        if (budgetExceeded && (await budgetExceeded())) return;
        await imageContext.addEvidence(value);
      },
      takeAdditionalMessages: () => {
        const message = imageContext.takeMessage();
        return message ? [message] : [];
      },
      knowledgeTool: (name) => name === "search_knowledge",
      isAbortError,
    });
    const result = await loop.run({ prompt, abortSignal });
    const genMs = Date.now() - genStarted;
    const imageSummary = imageContext.observabilitySummary();
    if (imageModelCalls > 0) {
      emitImageEvent(
        "info",
        "model",
        "image_model_completion",
        "completed",
        {
          image_count: imageSummary.loadedCount,
          call_count: imageModelCalls,
          byte_size: imageSummary.byteSize,
          estimated_visual_tokens: imageSummary.estimatedTokens,
          provider_reported_tokens: result.imageCallTokens ?? 0,
          duration_ms: genMs,
          loop_outcome: result.outcome,
        },
        "image model call completed",
      );
    }
    if (result.outcome === "deadline" && !result.hasEvidence && !result.text.trim()) {
      throw abortError();
    }
    if (result.budgetExhausted) {
      log.warn({ budget_exhausted: true }, "answer budget exhausted; composing from evidence");
    }
    if (!result.text && !result.hasEvidence) throw new Error("no evidence and no text");
    const composeStarted = Date.now();
    const composed = composeReply(result.text, modes, sources, {
      quotaPrefix,
      longFormFooter: persona?.longFormFooter,
    });
    const composeMs = Date.now() - composeStarted;
    const modelMs = Math.max(0, genMs - result.knowledgeMs - result.toolsMs);
    return {
      intent,
      content: composed.content,
      sources,
      toolTrace: [
        ...(persona
          ? [{
              persona_snapshot: {
                id: persona.snapshot.pack.id,
                version: persona.snapshot.pack.version,
                hash: persona.snapshot.snapshotHash,
                namespace: personaNamespace(persona),
              },
            }]
          : []),
        ...result.toolTrace,
        ...(webEvidence.length > 0 ? [{ web_evidence: webEvidence }] : []),
      ],
      tokens: result.tokens,
      visualUsageTokens: result.imageCallTokens,
      violations: composed.violations,
      phaseMs: { knowledge: result.knowledgeMs, tools: result.toolsMs, model: modelMs, compose: composeMs },
      visualReservation,
      interactionPostUris: explicitInteractionUrisFromAnswer(result.text),
      textReservation,
    };
  } catch (error) {
    const imageSummary = imageContext.observabilitySummary();
    if (imageModelCalls > 0) {
      const outcome = isAbortError(error) ? "aborted" : "provider_error";
      emitImageEvent(
        "warn",
        "model",
        "image_model_failure",
        outcome,
        {
          image_count: imageSummary.loadedCount,
          call_count: imageModelCalls,
          byte_size: imageSummary.byteSize,
          estimated_visual_tokens: imageSummary.estimatedTokens,
          duration_ms: modelStartedAt === null ? 0 : Date.now() - modelStartedAt,
        },
        "image model call failed",
      );
    }
    if (visualReservation && scout?.pool) {
      const settlementStarted = Date.now();
      try {
        const chargedTokens = await settleVisualTokens(scout.pool, visualReservation, {
          phase: "image_model_error",
          model: cfg.model,
          totalTokens: null,
        });
        const outcome = chargedTokens === null ? "already_settled" : "settled_conservative";
        emitImageEvent(
          "info",
          "settlement",
          "image_settlement",
          outcome,
          {
            reserved_tokens: visualReservation.estimatedTokens,
            provider_reported_tokens: 0,
            charged_tokens: chargedTokens ?? 0,
            duration_ms: Date.now() - settlementStarted,
          },
          "image reservation settled after model failure",
        );
      } catch {
        emitImageEvent(
          "error",
          "settlement",
          "image_settlement",
          "error",
          {
            reserved_tokens: visualReservation.estimatedTokens,
            provider_reported_tokens: 0,
            duration_ms: Date.now() - settlementStarted,
          },
          "image reservation settlement failed after model error",
        );
      }
    }
    if (textReservation && scout?.pool) {
      try {
        await releaseTextTokens(scout.pool, textReservation);
      } catch {
        log.error(
          { event: "token_reservation_release_failed", mention_key: scout.mentionKey },
          "text token reservation release failed after answer error; it expires as conservative usage",
        );
      }
    }
    throw error;
  }
}
