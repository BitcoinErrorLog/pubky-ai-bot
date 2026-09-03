/**
 * Jeb contract adapter. Compile with `npm run build`, then:
 *
 *   cd /Volumes/vibedrive/vibes-dev/jeb-contract
 *   CONTRACT_HOMESERVER=staging \
 *   CONTRACT_STAGING_ADMIN_PASSWORD="$(cat /tmp/jeb-staging-admin.pw)" \
 *   DATABASE_URL=postgres://johncarvalho@127.0.0.1:5432/jeb_bot_test \
 *   REDIS_URL=redis://127.0.0.1:6379/3 \
 *   CONTRACT_ADAPTER=/Volumes/vibedrive/vibes-dev/pubky-ai-bot/dist/contract-adapter.js \
 *   npm test
 *
 * Requires DATABASE_URL and REDIS_URL in the process environment.
 * Use Redis DB index 3 so a concurrent jeb-slim run does not share state.
 * Does not read harness runtime files. Publishes only via @synonymdev/pubky.
 */
import * as path from 'path';
import { createClient } from 'redis';
import { Client as PgClient } from 'pg';

export default class PubkyAiBotAdapter {
  private bot: any = null;
  private isolated = false;

  async start(env: {
    nexusUrl: string;
    homeserverPk: string;
    signupToken: string;
    secretKeyHex: string;
    pgUrl?: string;
    cannedReply: string;
    modelDelayMs: number;
    maxRepliesPerThread: number;
    testnet: boolean;
  }): Promise<void> {
    if (!process.env.DATABASE_URL && !env.pgUrl) {
      throw new Error('DATABASE_URL or env.pgUrl is required');
    }
    if (!process.env.REDIS_URL) {
      throw new Error('REDIS_URL is required (e.g. redis://127.0.0.1:6379/3)');
    }

    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = env.pgUrl || process.env.DATABASE_URL;
    process.env.PUBKY_NETWORK = env.testnet ? 'testnet' : 'mainnet';
    process.env.PUBKY_NEXUS_API_URL = env.nexusUrl;
    process.env.PUBKY_HOMESERVER_URL = env.homeserverPk;
    process.env.PUBKY_SIGNUP_TOKEN = env.signupToken;
    process.env.PUBKY_BOT_SECRET_KEY_HEX = env.secretKeyHex;
    process.env.CANNED_REPLY = env.cannedReply;
    process.env.MODEL_DELAY_MS = String(env.modelDelayMs || 0);
    process.env.MAX_REPLIES_PER_THREAD = String(env.maxRepliesPerThread ?? 1);
    process.env.POLL_INTERVAL_SECONDS = '1';
    process.env.RATE_LIMIT_MAX_REQUESTS = '10000';
    process.env.AI_PRIMARY_PROVIDER = process.env.AI_PRIMARY_PROVIDER || 'openai';
    process.env.AI_MODEL_SUMMARY = process.env.AI_MODEL_SUMMARY || 'gpt-4o-mini';
    process.env.AI_MODEL_FACTCHECK = process.env.AI_MODEL_FACTCHECK || 'gpt-4o-mini';
    process.env.AI_MODEL_CLASSIFIER = process.env.AI_MODEL_CLASSIFIER || 'gpt-4o-mini';
    process.env.PORT = String(31000 + Math.floor(Math.random() * 2000));

    if (!this.isolated) {
      await this.resetSharedState();
      this.isolated = true;
    }
    this.clearBotModuleCache();

    const { default: PubkyBot } = await import('./server');
    this.bot = new PubkyBot();
    await this.bot.start();
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
  }

  debugLastContext() {
    return this.bot?.debugLastContext?.();
  }

  private clearBotModuleCache(): void {
    const root = path.resolve(__dirname);
    for (const key of Object.keys(require.cache)) {
      if (!key.startsWith(root)) continue;
      if (key.includes(`${path.sep}node_modules${path.sep}`)) continue;
      if (key.includes('contract-adapter')) continue;
      delete require.cache[key];
    }
  }

  private async resetSharedState(): Promise<void> {
    const pg = new PgClient({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      await pg.query(`
        DO $$ BEGIN
          IF to_regclass('public.mentions') IS NOT NULL THEN
            TRUNCATE TABLE
              replies,
              artifacts,
              action_executions,
              routing_decisions,
              deleted_posts,
              token_usage,
              mentions,
              polling_state
            RESTART IDENTITY CASCADE;
          END IF;
        END $$;
      `);
    } finally {
      await pg.end();
    }

    const redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();
    try {
      await redis.flushDb();
    } finally {
      await redis.disconnect();
    }
  }
}
