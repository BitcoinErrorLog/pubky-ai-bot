import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INGEST_ALLOWLIST,
  ingestChildEnv,
  REASON_ALLOWLIST,
  reasonChildEnv,
  stripKeyMaterialEnv,
} from "./keys.js";

const fullEnv: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/home/op",
  NODE_OPTIONS: "--max-old-space-size=512",
  DATABASE_URL: "postgres://localhost/db",
  JEB_BOT_PK: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  JEB_NEXUS_URL: "https://nexus.staging.pubky.app",
  JEB_LOG_LEVEL: "debug",
  JEB_MODEL: "kimi-k3",
  JEB_MODEL_API_KEY: "sk-test-model-key",
  JEB_MODEL_BASE_URL: "https://api.moonshot.ai/v1",
  JEB_MODEL_CACHE: "/cache/jeb-models",
  JEB_EMBED_PROVIDER: "local",
  JEB_SCOUT_URL: "https://nexus-scout.pubky.app",
  JEB_SCOUT_DAILY_CEILING: "400",
  JEB_WEB_PROVIDER: "brave",
  JEB_WEB_DAILY_CEILING: "200",
  JEB_BRAVE_API_KEY: "brave-test-key",
  JEB_SWITCH_WEB: "1",
  JEB_CONTRACT_MODE: "1",
  PUBKY_BOT_SECRET_KEY_HEX: "ab".repeat(32),
  PUBKY_BOT_MNEMONIC: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  PUBKY_BOT_SECRET_KEY_FILE: "/run/secrets/bot.hex",
  JEB_SIGNUP_TOKEN: "signup-token-value",
  JEB_HOMESERVER: "homeserverpk",
  JEB_SELF_TAGS: "0",
  ADMIN_TOKEN: "admin-token-value",
  JEB_ADMIN_PORT: "9901",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "ghp_unrelated",
};

const FORBIDDEN = [
  "PUBKY_BOT_SECRET_KEY_HEX",
  "PUBKY_BOT_MNEMONIC",
  "PUBKY_BOT_SECRET_KEY_FILE",
  "JEB_SIGNUP_TOKEN",
  "JEB_HOMESERVER",
  "JEB_SELF_TAGS",
  "ADMIN_TOKEN",
  "JEB_ADMIN_PORT",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
];

describe("reasonChildEnv", () => {
  it("passes only allowlisted vars that are set", () => {
    const out = reasonChildEnv(fullEnv);
    expect(out.DATABASE_URL).toBe("postgres://localhost/db");
    expect(out.JEB_NEXUS_URL).toBe("https://nexus.staging.pubky.app");
    expect(out.JEB_MODEL_API_KEY).toBe("sk-test-model-key");
    expect(out.JEB_MODEL_CACHE).toBe("/cache/jeb-models");
    expect(out.JEB_SCOUT_DAILY_CEILING).toBe("400");
    expect(out.JEB_WEB_DAILY_CEILING).toBe("200");
    expect(out.JEB_BRAVE_API_KEY).toBe("brave-test-key");
    expect(out.JEB_LOG_LEVEL).toBe("debug");
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/op");
    expect(out.NODE_OPTIONS).toBeUndefined();
  });

  it("contains no key material, signup token, or admin token/port", () => {
    const out = reasonChildEnv(fullEnv);
    for (const name of FORBIDDEN) expect(out[name]).toBeUndefined();
    for (const name of Object.keys(out)) expect(name.startsWith("PUBKY_BOT_")).toBe(false);
  });

  it("omits allowlisted vars that are unset", () => {
    const out = reasonChildEnv({ DATABASE_URL: "postgres://localhost/db" });
    expect(out.DATABASE_URL).toBe("postgres://localhost/db");
    expect(out.JEB_MODEL_API_KEY).toBeUndefined();
    expect(out.PATH).toBeUndefined();
  });
});

describe("ingestChildEnv", () => {
  it("passes shared vars but no model, scout, or web keys", () => {
    const out = ingestChildEnv(fullEnv);
    expect(out.DATABASE_URL).toBe("postgres://localhost/db");
    expect(out.JEB_NEXUS_URL).toBe("https://nexus.staging.pubky.app");
    expect(out.JEB_LOG_LEVEL).toBe("debug");
    expect(out.JEB_MODEL_API_KEY).toBeUndefined();
    expect(out.JEB_MODEL).toBeUndefined();
    expect(out.JEB_BRAVE_API_KEY).toBeUndefined();
    expect(out.JEB_EMBED_PROVIDER).toBeUndefined();
    expect(out.JEB_SCOUT_URL).toBeUndefined();
    expect(out.JEB_WEB_PROVIDER).toBeUndefined();
    expect(out.NODE_OPTIONS).toBeUndefined();
  });

  it("contains no key material, signup token, or admin token/port", () => {
    const out = ingestChildEnv(fullEnv);
    for (const name of FORBIDDEN) expect(out[name]).toBeUndefined();
    for (const name of Object.keys(out)) expect(name.startsWith("PUBKY_BOT_")).toBe(false);
  });
});

describe("stripKeyMaterialEnv", () => {
  it("also removes ADMIN_TOKEN", () => {
    const out = stripKeyMaterialEnv(fullEnv);
    expect(out.PUBKY_BOT_SECRET_KEY_HEX).toBeUndefined();
    expect(out.JEB_SIGNUP_TOKEN).toBeUndefined();
    expect(out.ADMIN_TOKEN).toBeUndefined();
    expect(out.JEB_MODEL_API_KEY).toBe("sk-test-model-key");
  });
});

describe("per-role database URLs in child env", () => {
  it("reasonChildEnv prefers JEB_DB_URL_REASON over DATABASE_URL", () => {
    const out = reasonChildEnv({
      ...fullEnv,
      JEB_DB_URL_REASON: "postgres://jeb_reason@127.0.0.1:5432/jeb",
    });
    expect(out.DATABASE_URL).toBe("postgres://jeb_reason@127.0.0.1:5432/jeb");
    expect(out.JEB_DB_URL_REASON).toBeUndefined();
  });

  it("ingestChildEnv prefers JEB_DB_URL_INGEST over DATABASE_URL", () => {
    const out = ingestChildEnv({
      ...fullEnv,
      JEB_DB_URL_INGEST: "postgres://jeb_ingest@127.0.0.1:5432/jeb",
    });
    expect(out.DATABASE_URL).toBe("postgres://jeb_ingest@127.0.0.1:5432/jeb");
    expect(out.JEB_DB_URL_INGEST).toBeUndefined();
  });

  it("falls back to DATABASE_URL when the per-role var is unset", () => {
    expect(reasonChildEnv(fullEnv).DATABASE_URL).toBe("postgres://localhost/db");
    expect(ingestChildEnv(fullEnv).DATABASE_URL).toBe("postgres://localhost/db");
  });

  it("reasonChildEnv does not leak JEB_DB_URL_INGEST and vice versa", () => {
    const both = {
      ...fullEnv,
      JEB_DB_URL_REASON: "postgres://jeb_reason@127.0.0.1:5432/jeb",
      JEB_DB_URL_INGEST: "postgres://jeb_ingest@127.0.0.1:5432/jeb",
    };
    expect(reasonChildEnv(both).JEB_DB_URL_INGEST).toBeUndefined();
    expect(ingestChildEnv(both).JEB_DB_URL_REASON).toBeUndefined();
  });
});

/**
 * Drift guard: every JEB_* var referenced in src/config.ts must be either
 * allowlisted for a child role or explicitly excluded here. Adding a config
 * var without updating src/keys.ts fails this test.
 *
 * Exclusion classes:
 * - Secret-class, publish/parent only: JEB_SIGNUP_TOKEN.
 * - Publish role only (publisher keeps the full parent env): JEB_HOMESERVER,
 *   JEB_SELF_TAGS, JEB_ADMIN_PORT, JEB_TESTNET, JEB_MAX_PUBLISH_ATTEMPTS,
 *   JEB_PUBLISH_STALE_MS.
 * - Parent-side credential-bearing inputs: JEB_DB_URL_REASON /
 *   JEB_DB_URL_INGEST replace DATABASE_URL in the child env and are never
 *   forwarded verbatim.
 */
const CONFIG_ENV_EXCLUSIONS: readonly string[] = [
  "JEB_SIGNUP_TOKEN",
  "JEB_HOMESERVER",
  "JEB_SELF_TAGS",
  "JEB_ADMIN_PORT",
  "JEB_TESTNET",
  "JEB_MAX_PUBLISH_ATTEMPTS",
  "JEB_PUBLISH_STALE_MS",
  "JEB_DB_URL_REASON",
  "JEB_DB_URL_INGEST",
];

/** Secret-class names the ingest role must never receive. */
const INGEST_FORBIDDEN = [
  "JEB_SIGNUP_TOKEN",
  "ADMIN_TOKEN",
  "JEB_MODEL_API_KEY",
  "JEB_EMBED_API_KEY",
  "JEB_BRAVE_API_KEY",
];

function configEnvRefs(): string[] {
  const src = readFileSync(new URL("./config.ts", import.meta.url), "utf8");
  return [...new Set(src.match(/\bJEB_[A-Z0-9_]+\b/g) ?? [])].sort();
}

describe("allowlist coverage drift guard", () => {
  it("covers every JEB_* var referenced in src/config.ts or documents its exclusion", () => {
    const covered = new Set([...REASON_ALLOWLIST, ...INGEST_ALLOWLIST, ...CONFIG_ENV_EXCLUSIONS]);
    const refs = configEnvRefs();
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter((name) => !covered.has(name));
    expect(missing).toEqual([]);
  });

  it("keeps excluded vars out of both child allowlists", () => {
    for (const name of CONFIG_ENV_EXCLUSIONS) {
      expect(REASON_ALLOWLIST).not.toContain(name);
      expect(INGEST_ALLOWLIST).not.toContain(name);
    }
  });

  it("never gives the ingest role key material, signup token, admin token, or model API keys", () => {
    for (const name of INGEST_FORBIDDEN) expect(INGEST_ALLOWLIST).not.toContain(name);
    for (const name of INGEST_ALLOWLIST) expect(name.startsWith("PUBKY_BOT_")).toBe(false);
    for (const name of REASON_ALLOWLIST) expect(name.startsWith("PUBKY_BOT_")).toBe(false);
  });

  it("passes reason-only limit and scrub-valve vars to the reason child but not ingest", () => {
    const env: NodeJS.ProcessEnv = {
      ...fullEnv,
      JEB_USER_DAILY_TOKEN_BUDGET: "600000",
      JEB_ANSWER_BUDGET_MS: "180000",
      JEB_REPLY_DEADLINE_MS: "240000",
      JEB_SCRUB_DISABLED_RULES: "bip39",
    };
    const reason = reasonChildEnv(env);
    expect(reason.JEB_USER_DAILY_TOKEN_BUDGET).toBe("600000");
    expect(reason.JEB_ANSWER_BUDGET_MS).toBe("180000");
    expect(reason.JEB_REPLY_DEADLINE_MS).toBe("240000");
    expect(reason.JEB_SCRUB_DISABLED_RULES).toBe("bip39");
    const ingest = ingestChildEnv(env);
    expect(ingest.JEB_USER_DAILY_TOKEN_BUDGET).toBeUndefined();
    expect(ingest.JEB_ANSWER_BUDGET_MS).toBeUndefined();
    expect(ingest.JEB_REPLY_DEADLINE_MS).toBeUndefined();
    expect(ingest.JEB_SCRUB_DISABLED_RULES).toBeUndefined();
  });
});
