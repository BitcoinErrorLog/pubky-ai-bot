import type { Config } from "./config.js";
import { assertExactAllowedOrigins, isLoopbackBind, pubchiBind } from "./pubchi/env.js";

export const PUBCHI_DISALLOWED_ENV_NAMES = [
  "PUBKY_BOT_SECRET_KEY_HEX",
  "PUBKY_BOT_SECRET_KEY_FILE",
  "PUBKY_BOT_MNEMONIC",
  "JEB_SIGNUP_TOKEN",
  "ADMIN_TOKEN",
  "JEB_HOMESERVER",
  "JEB_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
] as const;

function present(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] !== undefined && env[name] !== "";
}

function requirePresent(env: NodeJS.ProcessEnv, name: string): void {
  if (!present(env, name)) throw new Error(`Pubchi production requires ${name}`);
}

function requireHttpsUrl(env: NodeJS.ProcessEnv, name: string): void {
  requirePresent(env, name);
  try {
    if (new URL(env[name] as string).protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new Error(`${name} must be an https URL`);
  }
}

export function assertPubchiProductionConfig(cfg: Config, env: NodeJS.ProcessEnv = process.env): void {
  if (env.JEB_SKIP_MIGRATIONS === "1") throw new Error("Pubchi production forbids JEB_SKIP_MIGRATIONS=1");
  for (const name of PUBCHI_DISALLOWED_ENV_NAMES) {
    if (env[name] !== undefined) throw new Error(`Pubchi production forbids ${name}`);
  }
  if (env.JEB_DB_URL_REASON !== undefined) {
    throw new Error("Pubchi production forbids JEB_DB_URL_REASON; use DATABASE_URL for its dedicated least-privilege role");
  }

  requirePresent(env, "DATABASE_URL");
  requireHttpsUrl(env, "JEB_NEXUS_URL");
  requireHttpsUrl(env, "JEB_SCOUT_URL");
  requirePresent(env, "JEB_BRAIN");
  if (env.JEB_BRAIN !== "ollama") requirePresent(env, "JEB_MODEL_API_KEY");
  if (env.JEB_MODEL_BASE_URL !== undefined && env.JEB_MODEL_BASE_URL !== "") {
    requireHttpsUrl(env, "JEB_MODEL_BASE_URL");
  }
  if (env.JEB_BRAIN === "openai-compatible") requireHttpsUrl(env, "JEB_MODEL_BASE_URL");

  const bind = pubchiBind(env.PUBCHI_BIND);
  const publicBind = !isLoopbackBind(bind);
  if (publicBind && env.PUBCHI_BIND_DANGEROUS !== "1") {
    throw new Error("public Pubchi bind requires PUBCHI_BIND_DANGEROUS=1");
  }
  const origins = assertExactAllowedOrigins(env.PUBCHI_ALLOWED_ORIGINS);
  if (publicBind && origins.length === 0) {
    throw new Error("public Pubchi bind requires PUBCHI_ALLOWED_ORIGINS");
  }
  if (origins.includes("*")) throw new Error("PUBCHI_ALLOWED_ORIGINS must not contain *");
  if (
    publicBind &&
    origins.some((origin) => {
      const parsed = new URL(origin);
      const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
      return parsed.protocol !== "https:" && !loopback;
    })
  ) {
    throw new Error("public Pubchi origins must use https, except tightly scoped localhost development origins");
  }

  if (env.JEB_TESTNET !== undefined && env.JEB_TESTNET !== "0" && env.JEB_TESTNET !== "1") {
    throw new Error("invalid JEB_TESTNET");
  }
  if (!cfg.databaseUrl || !cfg.scoutUrl || !cfg.nexusUrl) {
    throw new Error("Pubchi production requires database, Nexus, and Scout configuration");
  }
}
