import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Store } from "./db.js";
import { publicBotPk } from "./homeserver.js";
import { ingestChildEnv, reasonChildEnv } from "./keys.js";
import { assertContractGuard } from "./contract-guard.js";
import type { ContractEnv, DebugLastContext } from "pubky-bot-contract";

export type { ContractEnv, DebugLastContext };
export { assertContractGuard };

/**
 * Child env for the contract harness: the same explicit allowlists the
 * `--role all` supervisor uses (src/keys.ts). Only allowlisted JEB_* /
 * DATABASE_URL vars reach ingest/reason — no PUBKY_BOT_* key material, no
 * JEB_SIGNUP_TOKEN / ADMIN_TOKEN / JEB_ADMIN_PORT, and no unrelated parent
 * secrets (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, NPM_TOKEN, ...).
 */
export function contractChildEnv(base: NodeJS.ProcessEnv, role: "ingest" | "reason"): NodeJS.ProcessEnv {
  return role === "reason" ? reasonChildEnv(base) : ingestChildEnv(base);
}

export default class JebAdapter {
  private children: ChildProcess[] = [];
  private store: Store | null = null;
  private last: DebugLastContext | undefined;

  debugLastContext(): DebugLastContext | undefined {
    return this.last;
  }

  async start(env: ContractEnv): Promise<void> {
    assertContractGuard(env.nexusUrl);
    const databaseUrl = env.pgUrl?.trim() || process.env.DATABASE_URL?.trim();
    if (!databaseUrl) throw new Error("DATABASE_URL missing (and env.pgUrl unset)");
    this.store = new Store(databaseUrl);
    await this.store.migrate();
    const botPk = publicBotPk(env.secretKeyHex);
    const here = path.dirname(fileURLToPath(import.meta.url));
    const mainJs = path.resolve(here, "../dist/main.js");
    const base: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      JEB_NEXUS_URL: env.nexusUrl,
      JEB_HOMESERVER: env.homeserverPk,
      JEB_SIGNUP_TOKEN: env.signupToken,
      JEB_CANNED_REPLY: env.cannedReply,
      JEB_MODEL_DELAY_MS: String(env.modelDelayMs),
      JEB_MAX_REPLIES_PER_THREAD: String(env.maxRepliesPerThread),
      JEB_MAX_PER_USER_PER_HOUR: "10000",
      JEB_MAX_AGE_MINUTES: "0",
      JEB_POLL_MS: "40",
      JEB_TESTNET: env.testnet ? "1" : "0",
      JEB_BOT_PK: botPk,
      JEB_DAILY_TOKEN_BUDGET: "10000000",
    };
    const spawnRole = (role: "ingest" | "reason" | "publish", envExtra: NodeJS.ProcessEnv) => {
      const child = spawn(process.execPath, [mainJs, "--role", role], {
        env: { ...envExtra, JEB_SKIP_MIGRATIONS: "1" },
        stdio: ["ignore", "inherit", "inherit"],
      });
      this.children.push(child);
    };
    spawnRole("ingest", contractChildEnv(base, "ingest"));
    spawnRole("reason", contractChildEnv(base, "reason"));
    spawnRole("publish", {
      ...base,
      PUBKY_BOT_SECRET_KEY_HEX: env.secretKeyHex,
    });
  }

  async stop(): Promise<void> {
    if (this.store) {
      this.last = { ancestors: await this.store.getDebugAncestors() };
      await this.store.close();
      this.store = null;
    }
    for (const c of this.children) c.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    for (const c of this.children) {
      if (c.exitCode === null) c.kill("SIGKILL");
    }
    this.children = [];
  }
}
