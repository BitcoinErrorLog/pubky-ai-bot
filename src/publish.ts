import { parsePostUri } from "./types.js";
import { Store } from "./db.js";
import type { Config } from "./config.js";
import { existingReply, openTransport, publicBotPk, publishReply, type Transport } from "./homeserver.js";
import { closeServer, listenHealth } from "./health.js";
import { log, withMention } from "./log.js";
import { metrics } from "./metrics.js";
import { envSwitchOn } from "./switches.js";
import { classifyAuthFailure, isAuthError, PublisherAuthError } from "./auth-error.js";
import { putReplyTags, TAG_MAX_ATTEMPTS } from "./reply-tags.js";

export function validatePublishShape(row: { mention_key: string; parent_uri: string; content: string }): void {
  if (row.content.length > 50_000) throw new Error("content exceeds 50000");
  parsePostUri(row.parent_uri);
  if (row.mention_key !== row.parent_uri) {
    parsePostUri(row.mention_key);
  }
}

async function repliesBlocked(store: Store, cfg: Config): Promise<boolean> {
  return cfg.disabledEnv || envSwitchOn("replies") || envSwitchOn("global") || (await store.switchOn("replies"));
}

/** Thrown when the replies/global kill switch blocks a tag pass; never counted as a tag attempt. */
export class TagsBlockedError extends Error {}

/**
 * Ticket 12c (§4.4b): writes the category self-tags for one published reply.
 * Best-effort by design — the reply already exists, so a tag failure never
 * fails the publish: it is logged at warn and retried on a later tick (up to
 * TAG_MAX_ATTEMPTS attempts, tracked on the row), then given up. Idempotent:
 * skipped when `tag_uris` is already recorded, and a tag re-PUT overwrites
 * the same object (tag id = hash of uri+label).
 */
export async function tagOne(
  store: Store,
  transport: Transport,
  cfg: Config,
  row: { id: number; mention_key: string; reply_uri: string; categories: string[] },
): Promise<void> {
  if (cfg.selfTags === false) return;
  const lg = withMention(row.mention_key);
  if (row.categories.length === 0) {
    await store.markTagsDone(row.id, []);
    return;
  }
  // Same gate as the reply itself, re-checked immediately before the tag PUTs.
  if (await repliesBlocked(store, cfg)) throw new TagsBlockedError("replies switch on");
  try {
    const uris = await putReplyTags(transport, row.reply_uri, row.categories);
    await store.markTagsDone(row.id, uris);
    lg.info({ tag_uris: uris }, "reply tags published");
  } catch (e) {
    await store.markTagRetry(row.id, String(e));
    lg.warn({ err: String(e) }, "reply tag PUT failed; retrying on a later tick");
  }
}

export async function publishOne(
  store: Store,
  transport: Transport,
  cfg: Config,
  row: {
    id: number;
    mention_key: string;
    parent_uri: string;
    content: string;
    attempts: number;
    fail_first_attempt: boolean;
  },
): Promise<void> {
  const lg = withMention(row.mention_key);
  validatePublishShape(row);
  const claimed = await store.get(row.mention_key);
  if (!claimed) throw new Error("mention_key not claimed");
  if (claimed.status === "published") {
    await store.markPublishDone(row.id);
    return;
  }
  // F-12: skip only when the mention was explicitly skipped/failed after this
  // request was queued. Any other status (processing, or a crash leaving the
  // claim row as-is) must still PUT / reconcile.
  if (claimed.status === "skipped" || claimed.status === "failed") {
    await store.markPublishDone(row.id);
    lg.info({ status: claimed.status }, "publish skipped: mention skipped or failed");
    return;
  }

  const found = await existingReply(transport, row.parent_uri);
  if (found) {
    await store.mark(row.mention_key, "published", { replyUri: found });
    await store.markPublishDone(row.id);
    return;
  }

  if (await repliesBlocked(store, cfg)) {
    throw new Error("replies switch on");
  }

  if (row.fail_first_attempt && row.attempts <= 1) {
    await store.clearFailFirst(row.id);
    throw new Error("fail_first_attempt");
  }

  if (await repliesBlocked(store, cfg)) {
    throw new Error("replies switch on");
  }

  const put = async () => publishReply(transport, row.parent_uri, row.content);
  let published;
  try {
    published = await put();
  } catch (e) {
    if (!isAuthError(e)) throw e;
    try {
      await transport.reauth();
      published = await put();
    } catch (e2) {
      if (isAuthError(e2)) throw new PublisherAuthError(String(e2));
      throw e2;
    }
  }
  await store.mark(row.mention_key, "published", { replyUri: published.uri, rootUri: claimed.root_uri ?? undefined });
  await store.markPublishDone(row.id);
  metrics.incrementReplies("answer");
  metrics.incrementMentions("processed");
  lg.info({ reply_uri: published.uri }, "published");
}

export async function runPublish(cfg: Config): Promise<() => Promise<void>> {
  if (!process.env.PUBKY_BOT_SECRET_KEY_HEX && !process.env.PUBKY_BOT_MNEMONIC && !cfg.secretKeyHex) {
    throw new Error("publish requires key material");
  }
  const store = new Store(cfg.databaseUrl);
  await store.migrate();
  let transport: Transport;
  try {
    transport = await openTransport({
      secretKeyHex: cfg.secretKeyHex,
      homeserverPk: cfg.homeserverPk,
      signupToken: cfg.signupToken,
      testnet: cfg.testnet,
    });
  } catch (e) {
    const botPk = cfg.botPk || publicBotPk(cfg.secretKeyHex);
    log.error({ reason: classifyAuthFailure(e, botPk) }, "publisher auth failed");
    process.exit(1);
  }
  let stopped = false;
  let authFailed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const health =
    cfg.port && Number.isFinite(cfg.port)
      ? listenHealth(cfg.port + 2, () => Date.now(), cfg.bind, () => ({
          publisher_auth: authFailed ? "failed" : "ok",
        }))
      : null;

  const tick = async () => {
    if (stopped) return;
    try {
      if (authFailed) {
        try {
          await transport.reauth();
          authFailed = false;
        } catch {
          /* stay paused */
        }
      } else {
        await store.failExhaustedPublishes(cfg.maxPublishAttempts, cfg.publishStaleMs);
        const row = await store.claimPublish(cfg.maxPublishAttempts, cfg.publishStaleMs);
        if (row) {
          try {
            await publishOne(store, transport, cfg, row);
          } catch (e) {
            if (e instanceof PublisherAuthError) {
              authFailed = true;
              metrics.incrementAuthFailed();
              log.error({ reason: classifyAuthFailure(e, transport.botPk), mention_key: row.mention_key }, "publisher auth failed");
              await store.markPublishFailedAuth(row.id, e.message);
            } else {
              await store.markPublishRetry(row.id, String(e), row.attempts);
            }
          }
        }
        // Ticket 12c: category self-tags on published replies. Independent of
        // the publish path above and never allowed to affect it; skipped
        // entirely while the replies/global switch is on or JEB_SELF_TAGS=0.
        if (cfg.selfTags !== false && !(await repliesBlocked(store, cfg))) {
          try {
            const tagRow = await store.claimPendingTags(TAG_MAX_ATTEMPTS);
            if (tagRow) await tagOne(store, transport, cfg, tagRow);
          } catch (e) {
            if (!(e instanceof TagsBlockedError)) log.warn({ err: String(e) }, "reply tag pass failed");
          }
        }
      }
    } catch {
      /* keep */
    }
    if (!stopped) timer = setTimeout(() => void tick(), 40);
  };
  void tick();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await closeServer(health);
    await store.close();
  };
}
