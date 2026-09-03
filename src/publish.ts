import { parsePostUri } from "./types.js";
import { Store } from "./db.js";
import type { Config } from "./config.js";
import { existingReply, openTransport, publishReply, type Transport } from "./homeserver.js";
import { closeServer, listenHealth } from "./health.js";
import { withMention } from "./log.js";
import { metrics } from "./metrics.js";
import { envSwitchOn } from "./switches.js";

export function validatePublishShape(row: { mention_key: string; parent_uri: string; content: string }): void {
  if (row.content.length > 50_000) throw new Error("content exceeds 50000");
  parsePostUri(row.parent_uri);
  if (row.mention_key !== row.parent_uri) {
    parsePostUri(row.mention_key);
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

  const found = await existingReply(transport, row.parent_uri);
  if (found) {
    await store.mark(row.mention_key, "published", { replyUri: found });
    await store.markPublishDone(row.id);
    return;
  }

  if (cfg.disabledEnv || envSwitchOn("replies") || (await store.switchOn("replies"))) {
    throw new Error("replies switch on");
  }

  if (row.fail_first_attempt && row.attempts <= 1) {
    await store.clearFailFirst(row.id);
    throw new Error("fail_first_attempt");
  }

  const published = await publishReply(transport, row.parent_uri, row.content);
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
  const transport = await openTransport({
    secretKeyHex: cfg.secretKeyHex,
    homeserverPk: cfg.homeserverPk,
    signupToken: cfg.signupToken,
    testnet: cfg.testnet,
  });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const health =
    cfg.port && Number.isFinite(cfg.port) ? listenHealth(cfg.port + 2, () => Date.now(), "127.0.0.1") : null;

  const tick = async () => {
    if (stopped) return;
    try {
      const row = await store.claimPublish(cfg.maxPublishAttempts);
      if (row) {
        try {
          await publishOne(store, transport, cfg, row);
        } catch (e) {
          await store.markPublishRetry(row.id, String(e), row.attempts);
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
