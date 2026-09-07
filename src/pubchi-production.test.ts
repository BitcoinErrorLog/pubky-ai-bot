import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "./config.js";
import { assertPubchiProductionConfig } from "./pubchi-production.js";
import { envSwitchOn } from "./switches.js";
import { assertExactAllowedOrigins, parsePubchiPort } from "./pubchi/env.js";

const baseEnv: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://pubchi@db/pubchi",
  JEB_NEXUS_URL: "https://nexus.example",
  JEB_SCOUT_URL: "https://scout.example",
  JEB_BRAIN: "moonshot",
  JEB_MODEL_API_KEY: "test-key",
  PUBCHI_BIND: "0.0.0.0",
  PUBCHI_BIND_DANGEROUS: "1",
  PUBCHI_ALLOWED_ORIGINS: "https://app.example",
  JEB_TESTNET: "0",
};

const baseConfig = {
  databaseUrl: baseEnv.DATABASE_URL,
  nexusUrl: baseEnv.JEB_NEXUS_URL,
  scoutUrl: baseEnv.JEB_SCOUT_URL,
  role: "pubchi",
} as Config;

afterEach(() => {
  delete process.env.JEB_SWITCH_FEED;
  delete process.env.JEB_SWITCH_GLOBAL;
});

describe("Pubchi production boot gate", () => {
  it("accepts an explicit public bind and exact origin", () => {
    expect(() => assertPubchiProductionConfig(baseConfig, { ...baseEnv })).not.toThrow();
  });

  it("rejects the migration role in the runtime boot gate", () => {
    expect(() =>
      assertPubchiProductionConfig({ ...baseConfig, role: "pubchi-migrate" } as Config, { ...baseEnv }),
    ).toThrow("--role pubchi");
  });

  it.each([
    "JEB_SKIP_MIGRATIONS",
    "PUBKY_BOT_SECRET_KEY_HEX",
    "PUBKY_BOT_SECRET_KEY_FILE",
    "PUBKY_BOT_MNEMONIC",
    "JEB_SIGNUP_TOKEN",
    "ADMIN_TOKEN",
    "JEB_HOMESERVER",
    "JEB_GITHUB_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
  ])(
    "rejects disallowed %s",
    (name) => {
      expect(() => assertPubchiProductionConfig(baseConfig, { ...baseEnv, [name]: "present" })).toThrow(name);
    },
  );

  it("rejects a public bind without an exact origin", () => {
    expect(() =>
      assertPubchiProductionConfig(baseConfig, { ...baseEnv, PUBCHI_ALLOWED_ORIGINS: "" }),
    ).toThrow("PUBCHI_ALLOWED_ORIGINS");
  });

  it("rejects a public bind without explicit opt-in", () => {
    const env = { ...baseEnv, PUBCHI_BIND_DANGEROUS: undefined };
    expect(() => assertPubchiProductionConfig(baseConfig, env)).toThrow("PUBCHI_BIND_DANGEROUS");
  });

  it("rejects an external HTTP origin but keeps localhost development origins scoped", () => {
    expect(() =>
      assertPubchiProductionConfig(baseConfig, { ...baseEnv, PUBCHI_ALLOWED_ORIGINS: "http://app.example" }),
    ).toThrow("origins must use https");
    expect(() =>
      assertPubchiProductionConfig(baseConfig, { ...baseEnv, PUBCHI_ALLOWED_ORIGINS: "http://localhost:3000" }),
    ).not.toThrow();
  });

  it("rejects a missing model credential", () => {
    const env = { ...baseEnv };
    delete env.JEB_MODEL_API_KEY;
    expect(() => assertPubchiProductionConfig(baseConfig, env)).toThrow("JEB_MODEL_API_KEY");
  });

  it("rejects a reason-role database override", () => {
    expect(() =>
      assertPubchiProductionConfig(baseConfig, { ...baseEnv, JEB_DB_URL_REASON: "postgres://reason@db/pubchi" }),
    ).toThrow("JEB_DB_URL_REASON");
    expect(() =>
      assertPubchiProductionConfig(baseConfig, { ...baseEnv, JEB_DB_URL_INGEST: "postgres://ingest@db/jeb" }),
    ).toThrow("JEB_DB_URL_INGEST");
  });

  it.each([
    ["JEB_NEXUS_URL", "http://nexus.example"],
    ["JEB_NEXUS_URL", "ftp://nexus.example"],
    ["JEB_SCOUT_URL", "http://scout.example"],
  ])("rejects unsafe external URL %s", (name, url) => {
    expect(() => assertPubchiProductionConfig(baseConfig, { ...baseEnv, [name]: url })).toThrow(name);
  });

  it("requires an HTTPS model endpoint for the openai-compatible brain", () => {
    expect(() =>
      assertPubchiProductionConfig(baseConfig, {
        ...baseEnv,
        JEB_BRAIN: "openai-compatible",
        JEB_MODEL_BASE_URL: "http://model.example",
      }),
    ).toThrow("JEB_MODEL_BASE_URL");
    expect(() =>
      assertPubchiProductionConfig(baseConfig, {
        ...baseEnv,
        JEB_BRAIN: "openai-compatible",
        JEB_MODEL_BASE_URL: "https://model.example",
      }),
    ).not.toThrow();
  });

  it("treats JEB_TESTNET as optional but validates it when supplied", () => {
    const env = { ...baseEnv };
    delete env.JEB_TESTNET;
    expect(() => assertPubchiProductionConfig(baseConfig, env)).not.toThrow();
    expect(() =>
      assertPubchiProductionConfig(baseConfig, { ...baseEnv, JEB_TESTNET: "staging" }),
    ).toThrow("JEB_TESTNET");
  });
});
describe("Pubchi feed switch", () => {
  it("reads the independent feed switch", () => {
    process.env.JEB_SWITCH_FEED = "1";
    expect(envSwitchOn("feed")).toBe(true);
    process.env.JEB_SWITCH_FEED = "0";
    expect(envSwitchOn("feed")).toBe(false);
  });
});

describe("Pubchi production parsing", () => {
  it.each(["https://app.example/", "https://app.example/path", "*", "ftp://app.example"])(
    "rejects unsafe exact origin %s",
    (origin) => {
      expect(() => assertExactAllowedOrigins(origin)).toThrow("exact origins");
    },
  );

  it("uses Railway PORT when PUBCHI_PORT is empty", () => {
    const previous = process.env.PORT;
    process.env.PORT = "4321";
    try {
      expect(parsePubchiPort("")).toBe(4321);
      expect(parsePubchiPort(undefined)).toBe(4321);
      expect(parsePubchiPort("3015")).toBe(3015);
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });
});

