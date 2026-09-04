import { readFileSync, statSync } from "node:fs";
import { mnemonicToSeedSync, validateMnemonic } from "bip39";

export function secretFromFile(path: string): string {
  const st = statSync(path);
  if ((st.mode & 0o177) !== 0) throw new Error("PUBKY_BOT_SECRET_KEY_FILE must be mode 0600");
  const hex = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PUBKY_BOT_SECRET_KEY_FILE must contain 32-byte hex");
  return hex.toLowerCase();
}

export function secretFromEnv(): string {
  const hex = process.env.PUBKY_BOT_SECRET_KEY_HEX?.trim();
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PUBKY_BOT_SECRET_KEY_HEX must be 32-byte hex");
    return hex.toLowerCase();
  }
  const file = process.env.PUBKY_BOT_SECRET_KEY_FILE?.trim();
  if (file) return secretFromFile(file);
  const mnemonic = process.env.PUBKY_BOT_MNEMONIC?.trim();
  if (mnemonic) {
    if (!validateMnemonic(mnemonic)) throw new Error("PUBKY_BOT_MNEMONIC is not a valid BIP39 phrase");
    const seed = mnemonicToSeedSync(mnemonic);
    return Buffer.from(seed.subarray(0, 32)).toString("hex");
  }
  throw new Error("PUBKY_BOT_SECRET_KEY_HEX, PUBKY_BOT_SECRET_KEY_FILE, or PUBKY_BOT_MNEMONIC is required");
}

export function assertNoKeyMaterial(): void {
  if (
    process.env.PUBKY_BOT_SECRET_KEY_HEX ||
    process.env.PUBKY_BOT_MNEMONIC ||
    process.env.PUBKY_BOT_SECRET_KEY_FILE
  ) {
    throw new Error("key material must not be present in this process");
  }
}

/**
 * Env for ingest/reason child processes spawned by the contract adapter:
 * strips all PUBKY_BOT_* key material and the homeserver signup capability
 * (JEB_SIGNUP_TOKEN), neither of which has any purpose outside the publish
 * process. The `--role all` supervisor uses the stricter explicit allowlists
 * below (reasonChildEnv / ingestChildEnv).
 */
export function stripKeyMaterialEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const k of Object.keys(next)) {
    if (k.startsWith("PUBKY_BOT_")) delete next[k];
  }
  delete next.JEB_SIGNUP_TOKEN;
  delete next.ADMIN_TOKEN;
  return next;
}

/** System vars a child node process may rely on; never secret-bearing here. */
const SYSTEM_PASS = ["PATH", "HOME", "NODE_OPTIONS", "TZ", "LANG"] as const;

/**
 * Vars both ingest and reason children need. Deliberately excludes all
 * PUBKY_BOT_* key material, JEB_SIGNUP_TOKEN, ADMIN_TOKEN and JEB_ADMIN_PORT
 * (the publish process alone serves the admin listener), JEB_HOMESERVER
 * (only the publisher talks to the homeserver), and JEB_SELF_TAGS.
 */
const SHARED_ALLOWLIST = [
  "DATABASE_URL",
  "JEB_BOT_PK",
  "JEB_SKIP_MIGRATIONS",
  "JEB_LOG_LEVEL",
  "JEB_BIND",
  "JEB_PORT",
  "JEB_HEALTH_PORT",
  "JEB_APP_URL",
  "JEB_NEXUS_URL",
  "JEB_NEXUS_TIMEOUT_MS",
  "JEB_BLOCKLIST",
  "JEB_KNOWN_BOTS",
  "JEB_DISABLED",
  "JEB_SWITCH_GLOBAL",
  "JEB_SWITCH_CONSUMPTION",
  "JEB_SWITCH_GENERATION",
  "JEB_SWITCH_REPLIES",
  "JEB_SWITCH_SCOUT",
  "JEB_SWITCH_WEB",
  "JEB_SWITCH_PROACTIVE",
  "JEB_CONTRACT_MODE",
  "JEB_CANNED_REPLY",
  "JEB_POLL_MS",
  "JEB_MAX_AGE_MINUTES",
  "JEB_MAX_REPLIES_PER_THREAD",
  "JEB_MAX_TURNS_PER_USER_PER_THREAD",
  "JEB_MAX_PER_USER_PER_HOUR",
  "JEB_DAILY_TOKEN_BUDGET",
  "JEB_WORK_MAX_ATTEMPTS",
  "JEB_WORK_STALE_MS",
] as const;

/** Reason role: shared vars plus model, embeddings, Scout, and web search. */
const REASON_ALLOWLIST = [
  ...SHARED_ALLOWLIST,
  "JEB_MODEL",
  "JEB_MODEL_BASE_URL",
  "JEB_MODEL_API_KEY",
  "JEB_MODEL_TIMEOUT_MS",
  "JEB_MODEL_TEMPERATURE",
  "JEB_MODEL_DELAY_MS",
  "JEB_MODEL_CACHE",
  "JEB_MODEL_LOCAL_ONLY",
  "JEB_EMBED_PROVIDER",
  "JEB_EMBED_DTYPE",
  "JEB_EMBED_MODEL",
  "JEB_EMBED_API_KEY",
  "JEB_EMBED_BASE_URL",
  "JEB_SCOUT_URL",
  "JEB_SCOUT_ENABLED",
  "JEB_SCOUT_TIMEOUT_MS",
  "JEB_SCOUT_LIMIT_MAX",
  "JEB_SCOUT_RAW_ENABLED",
  "JEB_SCOUT_PER_MENTION_CAP",
  "JEB_SCOUT_DAILY_CEILING",
  "JEB_SCOUT_RAW_PER_USER_DAILY",
  "JEB_SCOUT_RAW_GLOBAL_DAILY",
  "JEB_SCOUT_PROFILE_PROP_MAX",
  "JEB_SCOUT_CLAIMANT_CAP",
  "JEB_WEB_PROVIDER",
  "JEB_WEB_TIMEOUT_MS",
  "JEB_WEB_PER_MENTION_CAP",
  "JEB_WEB_DAILY_CEILING",
  "JEB_BRAVE_API_KEY",
  "JEB_REASON_CONCURRENCY",
  "JEB_TOOL_MAX_STEPS",
] as const;

/** Ingest role: shared vars only — no model key, no admin token, no Scout/web. */
const INGEST_ALLOWLIST = SHARED_ALLOWLIST;

function pickEnv(env: NodeJS.ProcessEnv, allowlist: readonly string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of [...SYSTEM_PASS, ...allowlist]) {
    const v = env[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * Minimal environment for the reason child process: exactly the allowlisted
 * vars that are set, nothing else. No PUBKY_BOT_* key material, no
 * JEB_SIGNUP_TOKEN, no ADMIN_TOKEN / JEB_ADMIN_PORT.
 */
export function reasonChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return pickEnv(env, REASON_ALLOWLIST);
}

/**
 * Minimal environment for the ingest child process: shared allowlist only.
 * No model key, no admin token, no key material, no signup token.
 */
export function ingestChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return pickEnv(env, INGEST_ALLOWLIST);
}
