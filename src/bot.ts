import type { Config } from "./config.js";
import { asChainPost, assemblePrompt, ancestorsNewestFirst } from "./context.js";
import { Store } from "./db.js";
import { existingReply, openTransport, publishReply, publicBotPk, type Transport } from "./homeserver.js";
import { listenHealth, closeServer } from "./health.js";
import { InjectionDetector } from "./injection-detector.js";
import { withMention } from "./log.js";
import { metrics } from "./metrics.js";
import { completeReply, delay } from "./model.js";
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
import { mentionKey, skipStaleFirstBoot, type DebugLastContext, type Notification } from "./types.js";

const STALE_MS = 10 * 60 * 1000;

export class Bot {
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gen = 0;
  private lastPollAt: number | null = null;
  lastContext: DebugLastContext | undefined;
  private transport: Transport | null = null;
  private health: ReturnType<typeof listenHealth> | null = null;
  private store: Store | null = null;
  private inFlight = new Set<string>();
  private readonly detector = new InjectionDetector();
  readonly nexus: Nexus;
  botPk = "";

  constructor(readonly cfg: Config) {
    this.nexus = new Nexus(cfg.nexusUrl);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.gen += 1;
    this.store = new Store(this.cfg.databaseUrl);
    await this.store.migrate();
    this.transport = await openTransport({
      secretKeyHex: this.cfg.secretKeyHex,
      homeserverPk: this.cfg.homeserverPk,
      signupToken: this.cfg.signupToken,
      testnet: this.cfg.testnet,
    });
    this.botPk = this.transport.botPk;
    if (this.cfg.port && Number.isFinite(this.cfg.port)) {
      this.health = listenHealth(this.cfg.port, () => this.lastPollAt, "0.0.0.0");
    }
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.gen += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const start = Date.now();
    while (this.inFlight.size > 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await closeServer(this.health);
    this.health = null;
    if (this.store) {
      await this.store.close();
      this.store = null;
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.pollOnce(), ms);
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped || !this.store) return;
    const gen = this.gen;
    try {
      if (this.cfg.disabledEnv || envSwitchOn("consumption") || (await this.store.switchOn("consumption"))) {
        this.schedule(this.cfg.pollMs);
        return;
      }
      if (!(await this.store.ping())) {
        this.schedule(this.cfg.pollMs);
        return;
      }
      await this.retryStale();
      const cur = await this.store.getCursor(this.botPk, this.cfg.nexusUrl);
      const items = await this.nexus.notifications(this.botPk, cur.lastTs > 0 ? cur.lastTs : null);
      this.lastPollAt = Date.now();
      const filtered = cur.firstBootDone ? items : skipStaleFirstBoot(items, Date.now(), this.cfg.maxAgeMinutes);
      filtered.sort((a, b) => b.timestamp - a.timestamp);
      for (const n of filtered) {
        if (this.stopped || gen !== this.gen) break;
        void this.consume(n, gen);
      }
      const maxTs = items.length ? Math.max(...items.map((n) => n.timestamp), cur.lastTs) : cur.lastTs;
      await this.store.setCursor(this.botPk, this.cfg.nexusUrl, maxTs, true);
    } catch {
      /* keep polling */
    }
    if (!this.stopped && gen === this.gen) this.schedule(this.cfg.pollMs);
  }

  private async retryStale(): Promise<void> {
    if (!this.transport || !this.store) return;
    const keys = await this.store.staleProcessing(STALE_MS);
    for (const key of keys) {
      const found = await existingReply(this.transport, key);
      if (found) await this.store.mark(key, "published", { replyUri: found });
    }
  }

  private async consume(n: Notification, gen: number): Promise<void> {
    const parsed = mentionKey(n);
    if (!parsed || !this.store) return;
    const lg = withMention(parsed.key);
    if (this.inFlight.has(parsed.key)) return;
    this.inFlight.add(parsed.key);
    const stopTimer = metrics.startActionTimer("answer");
    metrics.incrementMentions("received");
    try {
      if (!(await this.store.ping())) return;
      if (this.cfg.disabledEnv || envSwitchOn("generation") || (await this.store.switchOn("generation"))) return;

      const blocked = authorBlocked(parsed.author, this.botPk || publicBotPk(this.cfg.secretKeyHex), this.cfg.blocklist);
      if (blocked) {
        lg.info({ policy: blocked }, "skip");
        return;
      }
      if (await blacklistDenied(this.store, parsed.author, this.cfg.blocklist)) {
        await this.store.mark(parsed.key, "skipped");
        metrics.incrementActions("answer", "blacklisted");
        return;
      }

      const existing = await this.store.get(parsed.key);
      if (existing?.status === "published" || existing?.status === "skipped") return;
      if (!existing || existing.status === "failed") {
        const claimed = await this.store.claim(parsed.key, parsed.author, this.botPk);
        if (claimed === "exists") return;
      } else if (existing.status === "processing") {
        if (this.transport) {
          const found = await existingReply(this.transport, parsed.key);
          if (found) {
            await this.store.mark(parsed.key, "published", { replyUri: found });
            return;
          }
        }
      }

      const view = await this.nexus.post(parsed.key);
      if (!view) {
        await this.store.mark(parsed.key, "skipped");
        lg.info("missing post");
        return;
      }
      if (view.details.author === this.botPk) {
        await this.store.mark(parsed.key, "skipped");
        return;
      }

      const chainViews = await walkAncestors(this.nexus, view, 25);
      const chainPosts = [];
      for (const p of chainViews) {
        const u = await this.nexus.userDetails(p.details.author);
        const raw = asChainPost(p, u);
        const inj = this.detector.detect(raw.content, { postUri: raw.uri, authorId: raw.author });
        chainPosts.push({ ...raw, content: inj.sanitized });
      }
      const ordered = ancestorsNewestFirst(chainPosts);
      this.lastContext = { ancestors: ordered.map((p) => ({ uri: p.uri, createdAt: p.createdAt })) };
      const root = chainViews[chainViews.length - 1]?.details.uri ?? parsed.key;

      const inThread = await this.store.publishedInThread(this.botPk, root);
      if (threadCapped(inThread, this.cfg.maxRepliesPerThread)) {
        await this.store.mark(parsed.key, "skipped", { rootUri: root });
        lg.info({ policy: "thread_cap" }, "skip");
        return;
      }
      if (await rateLimited(this.store, parsed.author, this.cfg.maxPerUserPerHour)) {
        await this.store.mark(parsed.key, "skipped", { rootUri: root });
        metrics.incrementActions("answer", "rate_limited");
        return;
      }
      const userN = await this.store.publishedByAuthorLastHour(parsed.author);
      if (userHourCapped(userN, this.cfg.maxPerUserPerHour)) {
        await this.store.mark(parsed.key, "skipped", { rootUri: root });
        lg.info({ policy: "user_hour" }, "skip");
        return;
      }
      if (await budgetExceeded(this.store, this.cfg.dailyTokenBudget, parsed.author)) {
        await this.store.mark(parsed.key, "skipped", { rootUri: root });
        lg.info({ policy: "budget" }, "skip");
        return;
      }

      await delay(this.cfg.modelDelayMs);
      if (this.stopped || gen !== this.gen) return;

      const mentionPost = asChainPost(view);
      let text: string;
      try {
        const out = await completeReply(this.cfg, assemblePrompt(this.botPk, mentionPost, chainPosts));
        text = out.text;
        await this.store.recordUsage({
          mentionKey: parsed.key,
          publicKey: parsed.author,
          phase: "answer",
          model: this.cfg.model,
          totalTokens: out.tokens,
        });
        await this.store.auditRoute(parsed.key, "answer");
      } catch (e) {
        await this.store.mark(parsed.key, "failed", { rootUri: root });
        lg.info({ err: String(e) }, "model failed");
        metrics.incrementMentions("failed");
        return;
      }
      if (this.cfg.disabledEnv || envSwitchOn("replies") || (await this.store.switchOn("replies"))) {
        await this.store.mark(parsed.key, "failed", { rootUri: root });
        return;
      }
      if (!this.transport) throw new Error("no transport");
      const published = await publishReply(this.transport, parsed.key, text);
      await this.store.mark(parsed.key, "published", { replyUri: published.uri, rootUri: root });
      metrics.incrementReplies("answer");
      metrics.incrementMentions("processed");
      lg.info({ reply_uri: published.uri }, "published");
    } catch (e) {
      lg.info({ err: String(e) }, "consume error");
      metrics.incrementMentions("failed");
    } finally {
      stopTimer();
      this.inFlight.delete(parsed.key);
    }
  }
}
