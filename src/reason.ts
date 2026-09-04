import type { Config } from "./config.js";
import { asChainPost, ancestorsNewestFirst, type ChainPost } from "./context.js";
import { Semaphore } from "./concurrency.js";
import { Store } from "./db.js";
import { closeServer, listenAdmin, listenHealth } from "./health.js";
import { InjectionDetector } from "./injection-detector.js";
import { assertNoKeyMaterial } from "./keys.js";
import { log, withMention } from "./log.js";
import { metrics } from "./metrics.js";
import { answerMention } from "./answer.js";
import {
  classifyAnswerFailure,
  inferFallbackContext,
  isAbortError,
  queueFallbackReply,
} from "./fallback.js";
import { delay } from "./model.js";
import { Nexus, walkAncestors } from "./nexus.js";
import { deriveCategories } from "./reply-tags.js";
import {
  authorBlocked,
  blacklistDenied,
  botLoopInChain,
  botRepliesInChain,
  budgetExceeded,
  conversationDecision,
  isAddressedTurn,
  isNotifiedSkip,
  jebTurnsWithAsker,
  rateLimited,
  replierIsAutomated,
  type SkipReason,
} from "./policy.js";
import { classifyOptoutRequest, queueOptoutConfirm } from "./optout.js";
import { queueSkipNotice } from "./skip-notice.js";
import { envSwitchOn } from "./switches.js";
import { skipEmbeddingWarmup, warmLocalEmbeddings } from "./knowledge/embed.js";
import { awaitWithGrace } from "./shutdown.js";
import { policyLimitsFromEnv, policySummary } from "./policy-summary.js";
import { decideQuotaNotice, quotaNoticeSentence } from "./quota-notice.js";

/** Carry-through only: never used by answering / compose. */
export function replacePostIdFromWorkPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as { replace_post_id?: unknown }).replace_post_id;
  if (typeof raw !== "string") return null;
  const id = raw.trim().toUpperCase();
  return /^[A-Z0-9]{13}$/.test(id) ? id : null;
}

export async function runReason(cfg: Config): Promise<() => Promise<void>> {
  assertNoKeyMaterial();
  const botPk = cfg.botPk;
  if (!botPk) throw new Error("JEB_BOT_PK required for reason");
  log.info(policySummary({ ...policyLimitsFromEnv(), ...cfg }), "effective policy limits");
  const store = new Store(cfg.databaseUrl);
  await store.migrate();
  const nexus = new Nexus(cfg.nexusUrl, cfg.nexusTimeoutMs);
  const detector = new InjectionDetector();
  const sem = new Semaphore(cfg.reasonConcurrency);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tickInFlight: Promise<void> | null = null;
  const jobs = new Set<Promise<void>>();
  const answerAborts = new Map<string, AbortController>();
  const bind = cfg.bind;
  const health =
    cfg.port && Number.isFinite(cfg.port) ? listenHealth(cfg.port + 1, () => Date.now(), bind) : null;
  const admin =
    cfg.adminPort && Number.isFinite(cfg.adminPort)
      ? listenAdmin(cfg.adminPort, cfg.adminToken, store, bind)
      : null;

  const generationBlocked = async () =>
    cfg.disabledEnv || envSwitchOn("generation") || envSwitchOn("global") || (await store.switchOn("generation"));

  if (
    !skipEmbeddingWarmup() &&
    (process.env.JEB_EMBED_PROVIDER ?? "local").trim() !== "openai-compatible"
  ) {
    try {
      const embedMs = await warmLocalEmbeddings();
      log.info({ embed_ms: embedMs }, `embeddings ready in ${embedMs} ms`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log.warn({ err: reason }, `embeddings warm-up failed: ${reason}`);
    }
  }

  const tick = (): void => {
    if (stopped) return;
    tickInFlight = (async () => {
      try {
        // R-01: reap before claiming — a crash between claimWork and finishWork
        // must not wedge the mention. Requeue stale claims (attempts-capped,
        // terminal failures also fail the mention), then fail `processing`
        // mentions that have no active work or publish request left.
        const deadlineN = await reapDeadlineFallbacks(store, cfg.replyDeadlineMs, answerAborts);
        if (deadlineN > 0) {
          log.warn({ n: deadlineN }, "reply deadline watchdog queued fallback");
        }
        const reaped = await store.reapStaleWork(cfg.workStaleMs, cfg.workMaxAttempts);
        if (reaped.requeued > 0 || reaped.failed > 0) {
          log.info({ requeued: reaped.requeued, failed: reaped.failed }, "reaped stale claimed work");
        }
        for (const key of reaped.exhaustedKeys) {
          answerAborts.get(key)?.abort();
          await queueFallbackReply({ store, mentionKey: key, parentUri: key, reason: "timeout" });
        }
        const staleMentions = await store.listStaleProcessingMentions(cfg.workStaleMs);
        for (const key of staleMentions) {
          await queueFallbackReply({ store, mentionKey: key, parentUri: key, reason: "timeout" });
        }
        if (stopped) return;
        if (await generationBlocked()) {
          /* paused */
        } else if (sem.inFlight < sem.max) {
          const job = await store.claimWork();
          if (job && !stopped) {
            const p = sem.run(() =>
              reasonOne(cfg, store, nexus, detector, botPk, job, generationBlocked, answerAborts),
            ).finally(() => {
              jobs.delete(p);
            });
            jobs.add(p);
            void p;
          }
        }
      } catch {
        /* keep looping */
      }
    })();
    void tickInFlight.then(() => {
      if (!stopped) timer = setTimeout(tick, 40);
    });
  };
  tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await awaitWithGrace(Promise.all([tickInFlight ?? Promise.resolve(), ...jobs]));
    await closeServer(health);
    await closeServer(admin);
    await store.close();
  };
}

export async function reapDeadlineFallbacks(
  store: Store,
  deadlineMs: number,
  aborts: Map<string, AbortController>,
): Promise<number> {
  const rows = await store.listOverdueUnpublished(deadlineMs);
  let n = 0;
  for (const row of rows) {
    aborts.get(row.mention_key)?.abort();
    const inserted = await queueFallbackReply({
      store,
      mentionKey: row.mention_key,
      parentUri: row.mention_key,
      reason: "timeout",
    });
    if (row.work_id !== null) await store.finishWork(row.work_id, "done");
    if (inserted) n += 1;
  }
  return n;
}

export async function reasonOne(
  cfg: Config,
  store: Store,
  nexus: Nexus,
  detector: InjectionDetector,
  botPk: string,
  job: { id: number; mention_key: string; author: string; payload?: unknown },
  generationBlocked?: () => Promise<boolean>,
  answerAborts?: Map<string, AbortController>,
): Promise<void> {
  const lg = withMention(job.mention_key);
  const replacePostId = replacePostIdFromWorkPayload(job.payload);
  const stopTimer = metrics.startActionTimer("answer");
  try {
    const skip = async (reason: SkipReason, extra?: { rootUri?: string }) => {
      const rootUri = extra?.rootUri ?? job.mention_key;
      if (isNotifiedSkip(reason)) {
        await queueSkipNotice({
          store,
          mentionKey: job.mention_key,
          author: job.author,
          parentUri: job.mention_key,
          reason,
          rootUri,
          replacePostId,
        });
      } else {
        await store.mark(job.mention_key, "skipped", { rootUri: extra?.rootUri, skipReason: reason });
      }
      await store.finishWork(job.id, "done");
      lg.info({ policy: reason }, "skip");
    };

    const blocked = authorBlocked(job.author, botPk, cfg.blocklist);
    if (blocked === "blocklist") {
      await skip("blocklist");
      return;
    }
    if (blocked === "self") {
      await store.mark(job.mention_key, "skipped");
      await store.finishWork(job.id, "done");
      lg.info({ policy: "self" }, "skip");
      return;
    }
    if (await blacklistDenied(store, job.author, cfg.blocklist)) {
      await skip("blocklist");
      metrics.incrementActions("answer", "blacklisted");
      return;
    }

    const contextStarted = Date.now();
    const view = await nexus.post(job.mention_key);
    if (!view) {
      await store.mark(job.mention_key, "skipped");
      await store.finishWork(job.id, "done");
      lg.info("missing post");
      return;
    }
    if (view.details.author === botPk) {
      await store.mark(job.mention_key, "skipped");
      await store.finishWork(job.id, "done");
      return;
    }

    // Opt-out / opt-in: before any model call and before policy caps.
    const optReq = classifyOptoutRequest(view.details.content);
    const alreadyOut = await store.isUserOptedOut(job.author);
    if (optReq === "opt_out") {
      await store.setUserOptOut(job.author, view.details.content.slice(0, 500));
      if (alreadyOut) {
        await skip("optout", { rootUri: job.mention_key });
      } else {
        await queueOptoutConfirm({
          store,
          mentionKey: job.mention_key,
          parentUri: job.mention_key,
          kind: "opt_out",
          rootUri: job.mention_key,
          replacePostId,
        });
        await store.finishWork(job.id, "done");
        lg.info({ policy: "optout", confirm: true }, "opt-out confirm");
      }
      return;
    }
    if (optReq === "opt_in") {
      if (alreadyOut) {
        await store.setUserOptIn(job.author);
        await queueOptoutConfirm({
          store,
          mentionKey: job.mention_key,
          parentUri: job.mention_key,
          kind: "opt_in",
          rootUri: job.mention_key,
          replacePostId,
        });
        await store.finishWork(job.id, "done");
        lg.info({ policy: "optout", confirm: true }, "opt-in confirm");
      } else {
        await store.mark(job.mention_key, "skipped", { rootUri: job.mention_key });
        await store.finishWork(job.id, "done");
      }
      return;
    }
    if (alreadyOut) {
      await skip("optout", { rootUri: job.mention_key });
      return;
    }

    // Never continue a conversation with another automated account: the
    // replier's profile declares bot/automation, or it is in JEB_KNOWN_BOTS.
    const replierDetails = await nexus.userDetails(job.author);
    if (replierIsAutomated(job.author, replierDetails, cfg.knownBots)) {
      await skip("bot_author");
      metrics.incrementActions("answer", "bot_replier");
      return;
    }

    const walked = await walkAncestors(nexus, view, 25);
    const chainViews = walked.chain;
    const chainPosts: ChainPost[] = [];
    for (const p of chainViews) {
      const u = p.details.author === job.author ? replierDetails : await nexus.userDetails(p.details.author);
      const raw = asChainPost(p, u);
      const inj = detector.detect(raw.content, { postUri: raw.uri, authorId: raw.author });
      chainPosts.push({ ...raw, content: inj.sanitized });
    }
    const ordered = ancestorsNewestFirst(chainPosts);
    await store.setDebugAncestors(ordered.map((p) => ({ uri: p.uri, createdAt: p.createdAt })));
    let root = chainViews[chainViews.length - 1]?.details.uri ?? job.mention_key;
    if (walked.unresolvedParent) {
      root = job.mention_key;
      lg.info({ event: "thread_root_unresolved" }, "thread_root_unresolved");
      log.info({ event: "thread_root_unresolved", mention_key: job.mention_key }, "thread_root_unresolved");
    }
    await store.mark(job.mention_key, "processing", { rootUri: root });
    const contextMs = Date.now() - contextStarted;

    const policyStarted = Date.now();
    const userTurnCap = cfg.maxTurnsPerUserPerThread ?? 6;
    const addressed = isAddressedTurn({
      botPk,
      content: view.details.content,
      mentioned: view.relationships?.mentioned,
      parentUri: view.relationships?.replied,
    });
    const knownBots = cfg.knownBots ?? new Set<string>();
    const isBotAuthor = (pk: string) => pk === botPk || knownBots.has(pk);
    const occupy = replacePostId ? 1 : 0;
    const inThread = Math.max(0, (await store.publishedInThread(botPk, root, job.mention_key)) - occupy);
    const chainJeb = Math.max(0, botRepliesInChain(chainPosts, botPk) - occupy);
    const dbTurns = Math.max(0, (await store.publishedByAuthorInThread(job.author, root, job.mention_key)) - occupy);
    const chainTurns = Math.max(0, jebTurnsWithAsker(chainPosts, botPk, job.author) - occupy);
    const hourly = await store.publishedByAuthorLastHour(job.author);
    const overBudget = await budgetExceeded(
      store,
      { global: cfg.dailyTokenBudget, user: cfg.userDailyTokenBudget },
      job.author,
    );
    const decision = conversationDecision({
      addressed,
      automatedReplier: false,
      botLoop: botLoopInChain(chainPosts, botPk, isBotAuthor),
      jebRepliesInThread: Math.max(inThread, chainJeb),
      maxRepliesPerThread: cfg.maxRepliesPerThread,
      jebTurnsWithAsker: Math.max(dbTurns, chainTurns),
      maxTurnsPerUserPerThread: userTurnCap,
      userHourCount: hourly,
      maxPerUserPerHour: cfg.maxPerUserPerHour,
      budgetExceeded: overBudget,
      blocklisted: false,
      optedOut: false,
    });
    if (decision) {
      await skip(decision, { rootUri: root });
      if (decision === "user_hourly_cap") metrics.incrementActions("answer", "rate_limited");
      return;
    }
    if (await rateLimited(store, job.author, cfg.maxPerUserPerHour)) {
      await skip("user_hourly_cap", { rootUri: root });
      metrics.incrementActions("answer", "rate_limited");
      return;
    }
    const typicalCost = await store.typicalAnswerTokensP50();
    const globalTokens = await store.globalDailyTokens();
    const userTokens = await store.userDailyTokens(job.author);
    const oldestHourly = await store.oldestPublishedByAuthorLastHour(job.author);
    const quotaNow = new Date();
    const quotaRule = decideQuotaNotice({
      userTokens,
      globalTokens,
      typicalCost,
      userDailyCeiling: cfg.userDailyTokenBudget,
      globalDailyCeiling: cfg.dailyTokenBudget,
      userHourCount: hourly,
      maxPerUserPerHour: cfg.maxPerUserPerHour,
      jebTurnsWithAsker: Math.max(dbTurns, chainTurns),
      maxTurnsPerUserPerThread: userTurnCap,
      jebRepliesInThread: Math.max(inThread, chainJeb),
      maxRepliesPerThread: cfg.maxRepliesPerThread,
    });
    const quotaPrefix = quotaRule
      ? quotaNoticeSentence(quotaRule, { now: quotaNow, oldestHourly })
      : undefined;
    if (quotaRule) {
      await store.mark(job.mention_key, "processing", { rootUri: root, quotaNotice: quotaRule });
    }
    const policyMs = Date.now() - policyStarted;

    await delay(cfg.modelDelayMs);
    const fallbackCtx = inferFallbackContext(view.details.content);
    if (generationBlocked && (await generationBlocked())) {
      await queueFallbackReply({
        store,
        mentionKey: job.mention_key,
        parentUri: job.mention_key,
        reason: "model_error",
        context: fallbackCtx,
        quotaPrefix,
        quotaNotice: quotaRule ?? undefined,
      });
      await store.mark(job.mention_key, "processing", { rootUri: root });
      await store.finishWork(job.id, "done");
      return;
    }
    const mentionPost = asChainPost(view);
    const started = Date.now();
    const ac = new AbortController();
    answerAborts?.set(job.mention_key, ac);
    const callAnswer = () =>
      answerMention(
        cfg,
        nexus,
        botPk,
        mentionPost,
        chainPosts,
        { blocked: generationBlocked ?? (async () => false) },
        {
          pool: store.pool,
          mentionKey: job.mention_key,
          author: job.author,
          storeSwitchOn: () => store.switchOn("scout"),
          storeWebSwitchOn: () => store.switchOn("web"),
        },
        // F-13: re-checked before every tool-loop model step, not just once.
        () =>
          budgetExceeded(store, { global: cfg.dailyTokenBudget, user: cfg.userDailyTokenBudget }, job.author),
        ac.signal,
        quotaPrefix,
      );
    try {
      let out;
      try {
        out = await callAnswer();
      } catch (first) {
        if (ac.signal.aborted || (await store.hasActivePublish(job.mention_key))) {
          await store.finishWork(job.id, "done");
          return;
        }
        try {
          out = await callAnswer();
        } catch (second) {
          if (ac.signal.aborted || (await store.hasActivePublish(job.mention_key))) {
            await store.finishWork(job.id, "done");
            return;
          }
          const reason = classifyAnswerFailure(second);
          await queueFallbackReply({
            store,
            mentionKey: job.mention_key,
            parentUri: job.mention_key,
            reason,
            context: fallbackCtx,
            quotaPrefix,
            quotaNotice: quotaRule ?? undefined,
            replacePostId,
          });
          await store.mark(job.mention_key, "processing", { rootUri: root });
          await store.finishWork(job.id, "done");
          lg.warn(
            { err: String(second), fallback_reason: reason, kind: "fallback", retried: !isAbortError(first) },
            "answer failed; queued fallback reply",
          );
          return;
        }
      }
      if (out.intent === "ignore" || out.content === null) {
        await store.mark(job.mention_key, "skipped", { rootUri: root });
        await store.finishWork(job.id, "done");
        return;
      }
      const phaseMs = {
        context: contextMs,
        policy: policyMs,
        knowledge: out.phaseMs.knowledge,
        tools: out.phaseMs.tools,
        model: out.phaseMs.model,
        compose: out.phaseMs.compose,
      };
      lg.info(phaseMs, "phase timings");
      await store.recordUsage({
        mentionKey: job.mention_key,
        publicKey: job.author,
        phase: out.intent,
        model: cfg.model,
        totalTokens: out.tokens,
      });
      await store.auditRoute(job.mention_key, out.intent);
      // Ticket 12c (§4.4b): fixed-vocabulary category self-tags, derived from
      // the intent, the knowledge products touched, and the tools used. The
      // publisher writes them as Pubky tags on Jeb's own reply after publish.
      const categories = deriveCategories({
        intent: out.intent,
        toolTrace: out.toolTrace,
        products: await store.knowledgeProducts(job.mention_key),
      });
      const evidenceId = await store.insertEvidence({
        mentionKey: job.mention_key,
        intent: out.intent,
        toolTrace: quotaRule
          ? [...(Array.isArray(out.toolTrace) ? out.toolTrace : []), { quota_notice: quotaRule }]
          : out.toolTrace,
        sources: out.sources,
        model: cfg.cannedReply ? "canned" : cfg.model,
        tokens: out.tokens,
        latencyMs: Date.now() - started,
        voiceViolations: out.violations,
        phaseMs,
        categories,
        quotaNotice: quotaRule ?? undefined,
      });
      const publishQueued = await store.insertPublishRequest({
        mentionKey: job.mention_key,
        parentUri: job.mention_key,
        content: out.content,
        evidenceId,
        categories,
        replacePostId,
      });
      if (!publishQueued) {
        // R-06: re-processing found an active/published request — the earlier
        // content wins; make the no-op visible.
        lg.info("publish request already exists; keeping earlier queued content");
      }
      await store.finishWork(job.id, "done");
    } finally {
      answerAborts?.delete(job.mention_key);
    }
  } finally {
    stopTimer();
  }
}
