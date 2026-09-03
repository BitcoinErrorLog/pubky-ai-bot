import { parsePostUri } from "./types.js";
import { Store } from "./db.js";
import type { Config } from "./config.js";
import { existingReply, openTransport, publicBotPk, publishReply, type Transport } from "./homeserver.js";
import { closeServer, listenHealth } from "./health.js";
import { log, withMention } from "./log.js";
import { metrics } from "./metrics.js";
import { envSwitchOn } from "./switches.js";
import { classifyAuthFailure, isAuthError, PublisherAuthError } from "./auth-error.js";

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
