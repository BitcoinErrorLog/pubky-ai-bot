import { Bot } from "./bot.js";
import type { Config } from "./config.js";
import type { ContractEnv, DebugLastContext } from "./types.js";

export type { ContractEnv, DebugLastContext };

export default class JebAdapter {
  private bot: Bot | null = null;

  debugLastContext(): DebugLastContext | undefined {
    return this.bot?.lastContext;
  }

  async start(env: ContractEnv): Promise<void> {
    const databaseUrl = env.pgUrl?.trim() || process.env.DATABASE_URL?.trim();
    if (!databaseUrl) throw new Error("DATABASE_URL missing (and env.pgUrl unset)");
    const cfg: Config = {
      nexusUrl: env.nexusUrl,
      homeserverPk: env.homeserverPk,
      signupToken: env.signupToken,
      secretKeyHex: env.secretKeyHex,
      databaseUrl,
      cannedReply: env.cannedReply,
      modelDelayMs: env.modelDelayMs,
      maxRepliesPerThread: env.maxRepliesPerThread,
      maxPerUserPerHour: 10_000,
      maxAgeMinutes: 0,
      pollMs: 40,
      model: "gpt-4o-mini",
      modelTimeoutMs: 30_000,
      dailyTokenBudget: 10_000_000,
      blocklist: new Set(),
      disabledEnv: false,
      testnet: env.testnet,
      maxPublishAttempts: 5,
      toolMaxSteps: 6,
      role: "all",
    };
    this.bot = new Bot(cfg);
    await this.bot.start();
  }

  async stop(): Promise<void> {
    if (this.bot) await this.bot.stop();
    this.bot = null;
  }
}
