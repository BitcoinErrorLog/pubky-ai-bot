import { describe, expect, it } from "vitest";
import { contractChildEnv } from "./contract-adapter.js";

/** Mirrors the base env JebAdapter.start builds (process.env + JEB_* config). */
const base: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  DATABASE_URL: "postgres://contract@127.0.0.1:5432/jeb_contract",
  JEB_BOT_PK: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  JEB_NEXUS_URL: "https://nexus.staging.pubky.app",
  JEB_HOMESERVER: "homeserverpk",
  JEB_SIGNUP_TOKEN: "signup-token-value",
  JEB_CANNED_REPLY: "canned reply",
  JEB_MODEL_DELAY_MS: "0",
  JEB_MODEL_API_KEY: "sk-contract-model-key",
  JEB_POLL_MS: "40",
  JEB_ADMIN_PORT: "9901",
  ADMIN_TOKEN: "admin-token-value",
  PUBKY_BOT_SECRET_KEY_HEX: "ab".repeat(32),
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "ghp_unrelated",
  NPM_TOKEN: "npm_unrelated",
};

const FORBIDDEN = [
  "PUBKY_BOT_SECRET_KEY_HEX",
  "JEB_SIGNUP_TOKEN",
  "JEB_HOMESERVER",
  "JEB_ADMIN_PORT",
  "ADMIN_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
];

describe("contractChildEnv (contract-adapter child env uses the allowlists)", () => {
  it("reason child gets config and model key but no unrelated secrets", () => {
    const out = contractChildEnv(base, "reason");
    expect(out.DATABASE_URL).toBe("postgres://contract@127.0.0.1:5432/jeb_contract");
    expect(out.JEB_MODEL_API_KEY).toBe("sk-contract-model-key");
    expect(out.JEB_CANNED_REPLY).toBe("canned reply");
    expect(out.JEB_NEXUS_URL).toBe("https://nexus.staging.pubky.app");
    for (const name of FORBIDDEN) expect(out[name]).toBeUndefined();
    for (const name of Object.keys(out)) expect(name.startsWith("PUBKY_BOT_")).toBe(false);
  });

  it("ingest child gets shared config only — no model key, no unrelated secrets", () => {
    const out = contractChildEnv(base, "ingest");
    expect(out.DATABASE_URL).toBe("postgres://contract@127.0.0.1:5432/jeb_contract");
    expect(out.JEB_MODEL_API_KEY).toBeUndefined();
    for (const name of FORBIDDEN) expect(out[name]).toBeUndefined();
    for (const name of Object.keys(out)) expect(name.startsWith("PUBKY_BOT_")).toBe(false);
  });

  it("JEB_ADMIN_PORT never reaches children on this path, so they cannot bind the admin listener", () => {
    expect(contractChildEnv(base, "reason").JEB_ADMIN_PORT).toBeUndefined();
    expect(contractChildEnv(base, "ingest").JEB_ADMIN_PORT).toBeUndefined();
  });
});
