import { describe, expect, it } from "vitest";
import {
  assertNoSecrets,
  redactSecrets,
  scanForSecrets,
  SECRET_DECLINE_REPLY,
} from "./secret-scrub.js";

const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function rules(text: string, env?: NodeJS.ProcessEnv): string[] {
  return scanForSecrets(text, { env: env ?? {} }).hits.map((h) => h.rule);
}

describe("hex64 rule", () => {
  it("flags a contiguous 64-hex string", () => {
    expect(rules(`the value is ${HEX} ok`)).toContain("hex64");
  });
  it("flags hex split with spaces", () => {
    const split = HEX.match(/.{16}/g)!.join(" ");
    expect(rules(split)).toContain("hex64");
  });
  it("flags hex split with newlines", () => {
    const split = HEX.match(/.{16}/g)!.join("\n");
    expect(rules(split)).toContain("hex64");
  });
  it("ignores 63-char and 65-char hex runs", () => {
    expect(scanForSecrets(HEX.slice(0, 63), { env: {} }).clean).toBe(true);
    expect(scanForSecrets(`${HEX}a`, { env: {} }).clean).toBe(true);
  });
  it("ignores ordinary prose and pubky public keys", () => {
    expect(
      scanForSecrets("see pubky://o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csaewso/post/x", { env: {} }).clean,
    ).toBe(true);
  });
});

describe("bip39 rule", () => {
  it("flags a 12-word mnemonic", () => {
    expect(rules(`my phrase: ${MNEMONIC}`)).toContain("bip39");
  });
  it("flags a 24-word mnemonic", () => {
    expect(rules(`${MNEMONIC} ${MNEMONIC}`)).toContain("bip39");
  });
  it("flags mnemonic words separated by commas", () => {
    expect(rules(MNEMONIC.split(" ").join(", "))).toContain("bip39");
  });
  it("ignores ordinary English sentences", () => {
    const text =
      "Pubky homeservers store public data under user keys and relays help index that content for apps.";
    expect(scanForSecrets(text, { env: {} }).clean).toBe(true);
  });
  it("ignores short runs of wordlist words below the threshold", () => {
    expect(scanForSecrets("about above absent absorb abstract absurd abuse access accident", { env: {} }).clean).toBe(true);
  });
});

describe("api_token rule", () => {
  it.each([
    "sk-abc123def456ghi",
    "sk_live_abc123def456",
    "ghp_abcdefghijklmnop",
    "gho_abcdefghijklmnop",
    "github_pat_11ABCDEFG0abcdefghijkl",
    "xoxb-123456789012-abcdefghijkl",
    "AKIAIOSFODNN7EXAMPLE",
  ])("flags %s", (token) => {
    expect(rules(`token: ${token}`)).toContain("api_token");
  });
  it("ignores prose that merely mentions token names", () => {
    expect(scanForSecrets("ask me about ski trips and bearer bonds", { env: {} }).clean).toBe(true);
  });
});

describe("bearer_token rule", () => {
  it("flags a bearer header", () => {
    expect(rules("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9")).toContain("bearer_token");
  });
  it("ignores the word bearer without a token", () => {
    expect(scanForSecrets("bearer of good news", { env: {} }).clean).toBe(true);
  });
});

describe("credentialed_url rule", () => {
  it.each([
    "postgres://user:pass@db.internal:5432/jeb",
    "postgresql://user:pass@db.internal/jeb",
    "redis://:onlypass@cache.internal:6379/0",
  ])("flags %s", (url) => {
    expect(rules(`connect via ${url}`)).toContain("credentialed_url");
  });
  it("ignores urls without passwords", () => {
    expect(scanForSecrets("postgres://johncarvalho@127.0.0.1:5432/jeb", { env: {} }).clean).toBe(true);
  });
});

describe("admin_header rule", () => {
  it("flags the literal header name", () => {
    expect(rules("X-Admin-Password: hunter2")).toContain("admin_header");
    expect(rules("set X-Admin-Password first")).toContain("admin_header");
  });
  it("ignores prose about admin passwords", () => {
    expect(scanForSecrets("the admin password lives in the operator vault", { env: {} }).clean).toBe(true);
  });
});

describe("env_secret and signup_token rules", () => {
  const env = {
    JEB_MODEL_API_KEY: "model-key-value-123456",
    JEB_SIGNUP_TOKEN: "signup-token-value-987",
    ADMIN_TOKEN: "admin-token-value-555",
    DATABASE_URL: "postgres://johncarvalho@127.0.0.1:5432/jeb_secret_db",
  };
  it("flags the literal value of a configured secret env var", () => {
    expect(rules("the key is model-key-value-123456 ok", env)).toContain("env_secret");
    expect(rules("token admin-token-value-555", env)).toContain("env_secret");
    expect(rules("db: postgres://johncarvalho@127.0.0.1:5432/jeb_secret_db", env)).toContain("env_secret");
  });
  it("flags the signup token under its own rule", () => {
    expect(rules("signup-token-value-987", env)).toContain("signup_token");
  });
  it("ignores values that are not configured", () => {
    expect(scanForSecrets("model-key-value-654321", { env }).clean).toBe(true);
  });
  it("ignores env values shorter than the minimum", () => {
    expect(scanForSecrets("short", { env: { ADMIN_TOKEN: "short" } }).clean).toBe(true);
  });
});

describe("redactSecrets", () => {
  it("replaces hex64 spans in place and reports rule ids", () => {
    const { text, hits } = redactSecrets(`before ${HEX} after`, { env: {} });
    expect(text).toBe("before [redacted] after");
    expect(hits.map((h) => h.rule)).toEqual(["hex64"]);
  });
  it("replaces mnemonic spans including comma-separated forms", () => {
    const { text, hits } = redactSecrets(`x ${MNEMONIC.split(" ").join(", ")} y`, { env: {} });
    expect(text).not.toContain("abandon");
    expect(text).toContain("[redacted]");
    expect(hits.map((h) => h.rule)).toContain("bip39");
  });
  it("replaces configured env values without echoing them", () => {
    const { text, hits } = redactSecrets("key model-key-value-123456 end", {
      env: { JEB_MODEL_API_KEY: "model-key-value-123456" },
    });
    expect(text).toBe("key [redacted] end");
    expect(hits.map((h) => h.rule)).toContain("env_secret");
  });
  it("returns the input untouched when clean", () => {
    const { text, hits } = redactSecrets("nothing sensitive here", { env: {} });
    expect(text).toBe("nothing sensitive here");
    expect(hits).toEqual([]);
  });
});

describe("assertNoSecrets", () => {
  it("throws with rule ids only", () => {
    expect(() => assertNoSecrets(`k ${HEX}`, { env: {} })).toThrowError(/hex64/);
    expect(() => assertNoSecrets(`k ${HEX}`, { env: {} })).toThrowError(/^((?!9f86d081).)*$/s);
  });
  it("passes clean text and the deterministic decline itself", () => {
    expect(() => assertNoSecrets("a normal reply about pubky", { env: {} })).not.toThrow();
    expect(() => assertNoSecrets(SECRET_DECLINE_REPLY, { env: {} })).not.toThrow();
  });
});
