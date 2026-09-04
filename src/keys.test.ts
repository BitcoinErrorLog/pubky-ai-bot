import { describe, expect, it } from "vitest";
import { ingestChildEnv, reasonChildEnv, stripKeyMaterialEnv } from "./keys.js";

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
