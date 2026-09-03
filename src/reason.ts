import type { Config } from "./config.js";
import { asChainPost, ancestorsNewestFirst } from "./context.js";
import { Store } from "./db.js";
import { closeServer, listenAdmin, listenHealth } from "./health.js";
import { InjectionDetector } from "./injection-detector.js";
import { assertNoKeyMaterial } from "./keys.js";
import { withMention } from "./log.js";
import { metrics } from "./metrics.js";
import { answerMention } from "./answer.js";
import { delay } from "./model.js";
import { Nexus, walkAncestors } from "./nexus.js";
import {
  authorBlocked,
  blacklistDenied,
  budgetExceeded,
  rateLimited,
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
  const nexus = new Nexus(cfg.nexusUrl);
  const detector = new InjectionDetector();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const health =
    cfg.port && Number.isFinite(cfg.port) ? listenHealth(cfg.port + 1, () => Date.now(), "127.0.0.1") : null;
  const admin =
    cfg.adminPort && Number.isFinite(cfg.adminPort)
      ? listenAdmin(cfg.adminPort, cfg.adminToken, store, "127.0.0.1")
      : null;

  const tick = async () => {
    if (stopped) return;
    try {
      if (cfg.disabledEnv || envSwitchOn("generation") || (await store.switchOn("generation"))) {
        /* paused */
      } else {
        const job = await store.claimWork();
        if (job) await reasonOne(cfg, store, nexus, detector, botPk, job);
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

    const chainViews = await walkAncestors(nexus, view, 25);
    const chainPosts = [];
    for (const p of chainViews) {
      const u = await nexus.userDetails(p.details.author);
      const raw = asChainPost(p, u);
      const inj = detector.detect(raw.content, { postUri: raw.uri, authorId: raw.author });
      chainPosts.push({ ...raw, content: inj.sanitized });
    }
    const ordered = ancestorsNewestFirst(chainPosts);
    await store.setDebugAncestors(ordered.map((p) => ({ uri: p.uri, createdAt: p.createdAt })));
    const root = chainViews[chainViews.length - 1]?.details.uri ?? job.mention_key;
    await store.mark(job.mention_key, "processing", { rootUri: root });

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
    const mentionPost = asChainPost(view);
    const started = Date.now();
    try {
      const out = await answerMention(cfg, nexus, botPk, mentionPost, chainPosts);
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
