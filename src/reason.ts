import type { Config } from "./config.js";
import { asChainPost, ancestorsNewestFirst } from "./context.js";
import { Semaphore } from "./concurrency.js";
import { Store } from "./db.js";
import { closeServer, listenAdmin, listenHealth } from "./health.js";
import { InjectionDetector } from "./injection-detector.js";
import { assertNoKeyMaterial } from "./keys.js";
import { log, withMention } from "./log.js";
import { metrics } from "./metrics.js";
import { answerMention } from "./answer.js";
import { delay } from "./model.js";
import { Nexus, walkAncestors } from "./nexus.js";
import {
  authorBlocked,
  blacklistDenied,
  botRepliesInChain,
  budgetExceeded,
  rateLimited,
  replierIsAutomated,
  threadCapped,
  userHourCapped,
} from "./policy.js";
import { envSwitchOn } from "./switches.js";

export async function runReason(cfg: Config): Promise<() => Promise<void>> {
  assertNoKeyMaterial();
  const botPk = cfg.botPk;
  if (!botPk) throw new Error("JEB_BOT_PK required for reason");
  const store = new Store(cfg.databaseUrl);
  await store.migrate();
  const nexus = new Nexus(cfg.nexusUrl, cfg.nexusTimeoutMs);
  const detector = new InjectionDetector();
  const sem = new Semaphore(cfg.reasonConcurrency);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bind = cfg.bind;
  const health =
    cfg.port && Number.isFinite(cfg.port) ? listenHealth(cfg.port + 1, () => Date.now(), bind) : null;
  const admin =
    cfg.adminPort && Number.isFinite(cfg.adminPort)
      ? listenAdmin(cfg.adminPort, cfg.adminToken, store, bind)
      : null;

  const generationBlocked = async () =>
    cfg.disabledEnv || envSwitchOn("generation") || envSwitchOn("global") || (await store.switchOn("generation"));

  const tick = async () => {
    if (stopped) return;
    try {
      if (await generationBlocked()) {
        /* paused */
      } else if (sem.inFlight < sem.max) {
        const job = await store.claimWork();
        if (job) void sem.run(() => reasonOne(cfg, store, nexus, detector, botPk, job, generationBlocked));
      }
    } catch {
      /* keep looping */
    }
    if (!stopped) timer = setTimeout(() => void tick(), 40);
  };
  void tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await closeServer(health);
    await closeServer(admin);
    await store.close();
  };
}

export async function reasonOne(
  cfg: Config,
  store: Store,
  nexus: Nexus,
  detector: InjectionDetector,
  botPk: string,
  job: { id: number; mention_key: string; author: string },
  generationBlocked?: () => Promise<boolean>,
): Promise<void> {
  const lg = withMention(job.mention_key);
  const stopTimer = metrics.startActionTimer("answer");
  try {
    const blocked = authorBlocked(job.author, botPk, cfg.blocklist);
    if (blocked) {
      await store.mark(job.mention_key, "skipped");
      await store.finishWork(job.id, "done");
      lg.info({ policy: blocked }, "skip");
      return;
    }
    if (await blacklistDenied(store, job.author, cfg.blocklist)) {
      await store.mark(job.mention_key, "skipped");
      await store.finishWork(job.id, "done");
      metrics.incrementActions("answer", "blacklisted");
      return;
    }

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
    // Never continue a conversation with another automated account: the
    // replier's profile declares bot/automation, or it is in JEB_KNOWN_BOTS.
    const replierDetails = await nexus.userDetails(job.author);
    if (replierIsAutomated(job.author, replierDetails, cfg.knownBots)) {
      await store.mark(job.mention_key, "skipped");
      await store.finishWork(job.id, "done");
      lg.info({ policy: "automated_replier" }, "skip");
      metrics.incrementActions("answer", "bot_replier");
      return;
    }

    const walked = await walkAncestors(nexus, view, 25);
    const chainViews = walked.chain;
    const chainPosts = [];
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

    if (threadCapped(botRepliesInChain(chainPosts, botPk), cfg.maxRepliesPerThread)) {
      await store.mark(job.mention_key, "skipped", { rootUri: root });
      await store.finishWork(job.id, "done");
      lg.info({ policy: "thread_cap_chain" }, "skip");
      return;
    }
    const inThread = await store.publishedInThread(botPk, root, job.mention_key);
    if (threadCapped(inThread, cfg.maxRepliesPerThread)) {
      await store.mark(job.mention_key, "skipped", { rootUri: root });
      await store.finishWork(job.id, "done");
      lg.info({ policy: "thread_cap" }, "skip");
      return;
    }
    if (await rateLimited(store, job.author, cfg.maxPerUserPerHour)) {
      await store.mark(job.mention_key, "skipped", { rootUri: root });
      await store.finishWork(job.id, "done");
      metrics.incrementActions("answer", "rate_limited");
      return;
    }
    const userN = await store.publishedByAuthorLastHour(job.author);
    if (userHourCapped(userN, cfg.maxPerUserPerHour)) {
      await store.mark(job.mention_key, "skipped", { rootUri: root });
      await store.finishWork(job.id, "done");
      return;
    }
    if (await budgetExceeded(store, cfg.dailyTokenBudget, job.author)) {
      await store.mark(job.mention_key, "skipped", { rootUri: root });
      await store.finishWork(job.id, "done");
      return;
    }

    await delay(cfg.modelDelayMs);
    if (generationBlocked && (await generationBlocked())) {
      await store.mark(job.mention_key, "failed", { rootUri: root });
      await store.finishWork(job.id, "failed");
      return;
    }
    const mentionPost = asChainPost(view);
    const started = Date.now();
    try {
      const out = await answerMention(
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
        },
        // F-13: re-checked before every tool-loop model step, not just once.
        () => budgetExceeded(store, cfg.dailyTokenBudget, job.author),
      );
      if (out.intent === "ignore" || out.content === null) {
        await store.mark(job.mention_key, "skipped", { rootUri: root });
        await store.finishWork(job.id, "done");
        return;
      }
      await store.recordUsage({
        mentionKey: job.mention_key,
        publicKey: job.author,
        phase: out.intent,
        model: cfg.model,
        totalTokens: out.tokens,
      });
      await store.auditRoute(job.mention_key, out.intent);
      const evidenceId = await store.insertEvidence({
        mentionKey: job.mention_key,
        intent: out.intent,
        toolTrace: out.toolTrace,
        sources: out.sources,
        model: cfg.cannedReply ? "canned" : cfg.model,
        tokens: out.tokens,
        latencyMs: Date.now() - started,
        voiceViolations: out.violations,
      });
      await store.insertPublishRequest({
        mentionKey: job.mention_key,
        parentUri: job.mention_key,
        content: out.content,
        evidenceId,
      });
      await store.finishWork(job.id, "done");
    } catch (e) {
      await store.mark(job.mention_key, "failed", { rootUri: root });
      await store.finishWork(job.id, "failed");
      lg.info({ err: String(e) }, "model failed");
      metrics.incrementMentions("failed");
    }
  } finally {
    stopTimer();
  }
}
