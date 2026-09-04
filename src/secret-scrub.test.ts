import { describe, expect, it } from "vitest";
import {
  assertNoSecrets,
  ENV_SECRET_PARTIAL_MIN_LEN,
  redactSecrets,
  scanForSecrets,
  SECRET_DECLINE_REPLY,
} from "./secret-scrub.js";

const HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const KEY_ENV: NodeJS.ProcessEnv = { PUBKY_BOT_SECRET_KEY_HEX: HEX };
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const MNEMONIC_24 = `${"abandon ".repeat(23)}art`;

function rules(text: string, env?: NodeJS.ProcessEnv): string[] {
  return scanForSecrets(text, { env: env ?? {} }).hits.map((h) => h.rule);
}

describe("key_material rule (value-matched, outbound gate)", () => {
  it("flags the configured key as bare 64-hex", () => {
    expect(rules(`the value is ${HEX} ok`, KEY_ENV)).toContain("key_material");
  });
  it("flags the key with a 0x prefix", () => {
    expect(rules(`see 0x${HEX}`, KEY_ENV)).toContain("key_material");
  });
  it("flags the key split by dashes, commas, or spaces", () => {
    expect(rules(HEX.match(/.{16}/g)!.join("-"), KEY_ENV)).toContain("key_material");
    expect(rules(HEX.match(/.{16}/g)!.join(", "), KEY_ENV)).toContain("key_material");
    expect(rules(HEX.match(/.{16}/g)!.join(" "), KEY_ENV)).toContain("key_material");
  });
  it("flags the key split by zero-width characters", () => {
    const zwsp = `${HEX.slice(0, 32)}​${HEX.slice(32)}`;
    expect(rules(zwsp, KEY_ENV)).toContain("key_material");
  });
  it("flags the key spelled with fullwidth hex homoglyphs", () => {
    const fullwidth = [...HEX]
      .map((c) => {
        const code = c >= "0" && c <= "9" ? 0xff10 + (c.charCodeAt(0) - 48) : 0xff41 + (c.charCodeAt(0) - 97);
        return String.fromCodePoint(code);
      })
      .join("");
    expect(rules(fullwidth, KEY_ENV)).toContain("key_material");
  });
  it("flags the key embedded in a longer hex run (key||pubkey)", () => {
    expect(rules(`${HEX}${"ab".repeat(32)}`, KEY_ENV)).toContain("key_material");
    expect(rules(`${HEX}g`, KEY_ENV)).toContain("key_material");
  });
  it("flags base64 and base64url encodings of the key, padded or not", () => {
    expect(rules("n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=", KEY_ENV)).toContain("key_material");
    expect(rules("n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg", KEY_ENV)).toContain("key_material");
    expect(rules("n4bQgYhMfWWaL-qgxVrQFaO_TxsrC4Is0V1sFbDwCgg", KEY_ENV)).toContain("key_material");
  });
  it("flags base32 (RFC4648) and z-base-32 encodings of the key", () => {
    expect(rules("T6DNBAMIJR6WLGRP5KQMKWWQCWR36TY3FMFYELGRLVWBLMHQBIEA====", KEY_ENV)).toContain("key_material");
    expect(rules("T6DNBAMIJR6WLGRP5KQMKWWQCWR36TY3FMFYELGRLVWBLMHQBIEA", KEY_ENV)).toContain("key_material");
    expect(rules("t6dnbamijr6wlgrp5kqmkwwqcwr36ty3fmfyelgrlvwblmhqbiea", KEY_ENV)).toContain("key_material");
    expect(rules("u6dpbycejt6smgtx7kockssonst56ua5fcfarmgtmisbmc8obery", KEY_ENV)).toContain("key_material");
  });
  it("does not flag a different 64-hex value", () => {
    expect(scanForSecrets("txid: 4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b", { env: KEY_ENV }).clean).toBe(true);
  });
  it("does not flag when no key material is configured", () => {
    expect(scanForSecrets(HEX, { env: {} }).clean).toBe(true);
  });
});

describe("outbound gate passes legitimate hashes and ids (FP corpus)", () => {
  const cases: Array<[string, string]> = [
    ["bitcoin txid", "txid: 4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b"],
    ["bitcoin block hash", "block 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"],
    ["sha256 digest", "sha256(hello world) = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"],
    ["nostr x-only pubkey", "pubkey 82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2"],
    ["40-char git SHA", "commit e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 on main"],
    ["RFC 6750 example bearer token", 'the spec shows "Authorization: Bearer mF_9.B5f-4.1JqM" as an example'],
    ["bare admin header name", "the admin API expects an X-Admin-Password header on write routes"],
    ["pubky z32 id", "see pubky://o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csaewso/post/x"],
  ];
  it.each(cases)("%s passes", (_label, text) => {
    expect(scanForSecrets(text, { env: KEY_ENV }).clean).toBe(true);
  });
});

describe("hex64 shape rule (tool results only)", () => {
  it("scanForSecrets does NOT block on the 64-hex shape", () => {
    expect(scanForSecrets(`txid ${HEX}`, { env: {} }).clean).toBe(true);
  });
  it("redactSecrets still redacts 64-hex spans in tool results", () => {
    const { text, hits } = redactSecrets(`before ${HEX} after`, { env: {} });
    expect(text).toBe("before [redacted] after");
    expect(hits.map((h) => h.rule)).toEqual(["hex64"]);
  });
  it("redactSecrets redacts dash-split 64-hex in tool results", () => {
    const { hits } = redactSecrets(HEX.match(/.{16}/g)!.join("-"), { env: {} });
    expect(hits.map((h) => h.rule)).toContain("hex64");
  });
});

describe("bip39 rule (checksum-validated)", () => {
  it("flags a valid 12-word mnemonic", () => {
    expect(rules(`my phrase: ${MNEMONIC}`)).toContain("bip39");
  });
  it("flags a valid 24-word mnemonic", () => {
    expect(rules(`words: ${MNEMONIC_24}`)).toContain("bip39");
  });
  it("flags a mnemonic interleaved with filler words", () => {
    const words = MNEMONIC.split(" ");
    const interleaved = words.map((w, i) => (i % 3 === 2 ? `${w} frobnicate` : w)).join(" ");
    expect(rules(interleaved)).toContain("bip39");
  });
  it("flags comma-separated mnemonic words", () => {
    expect(rules(MNEMONIC.split(" ").join(", "))).toContain("bip39");
  });
  it("flags a mnemonic given in reversed word order", () => {
    const reversed = MNEMONIC.split(" ").reverse().join(" ");
    expect(rules(reversed)).toContain("bip39");
  });
  it("passes random wordlist prose that fails the checksum", () => {
    expect(scanForSecrets("ability able about above absent absorb abstract absurd abuse access accident achieve", { env: {} }).clean).toBe(true);
    expect(scanForSecrets("abandon ".repeat(12).trim(), { env: {} }).clean).toBe(true);
  });
  it("passes ordinary English sentences", () => {
    const text = "Pubky homeservers store public data under user keys and relays help index that content for apps.";
    expect(scanForSecrets(text, { env: {} }).clean).toBe(true);
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

describe("bearer_token rule (tool results only)", () => {
  it("passes the outbound gate (RFC example tokens are legitimate prose)", () => {
    expect(scanForSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9", { env: {} }).clean).toBe(true);
  });
  it("redacts bearer headers in tool results", () => {
    const { hits, text } = redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9", { env: {} });
    expect(hits.map((h) => h.rule)).toContain("bearer_token");
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});

describe("credentialed_url rule", () => {
  it.each([
    "postgres://user:pass@db.internal:5432/jeb",
    "postgresql://user:pass@db.internal/jeb",
    "redis://:onlypass@cache.internal:6379/0",
    "mysql://root:pw@db.internal/jeb",
    "mongodb://admin:pw@db.internal/jeb",
    "mongodb+srv://admin:pw@cluster.example/jeb",
    "amqp://guest:pw@mq.internal:5672/vhost",
    "mssql://sa:pw@db.internal/jeb",
  ])("flags %s", (url) => {
    expect(rules(`connect via ${url}`)).toContain("credentialed_url");
  });
  it("ignores urls without passwords", () => {
    expect(scanForSecrets("postgres://johncarvalho@127.0.0.1:5432/jeb", { env: {} }).clean).toBe(true);
    expect(scanForSecrets("mysql://root@127.0.0.1:3306/jeb", { env: {} }).clean).toBe(true);
  });
});

describe("admin_header rule", () => {
  it("flags the header only when a value is attached", () => {
    expect(rules("X-Admin-Password: hunter2")).toContain("admin_header");
  });
  it("ignores the bare header name in prose", () => {
    expect(scanForSecrets("set the X-Admin-Password header first", { env: {} }).clean).toBe(true);
    expect(scanForSecrets("the admin password lives in the operator vault", { env: {} }).clean).toBe(true);
  });
});

describe("env_secret and signup_token rules", () => {
  const env = {
    JEB_MODEL_API_KEY: "model-key-value-123456",
    JEB_SIGNUP_TOKEN: "signup-token-value-987",
    ADMIN_TOKEN: "admin-token-value-555",
    DATABASE_URL: "postgres://johncarvalho:pw@127.0.0.1:5432/jeb_secret_db",
  };
  it("flags the literal value of a configured secret env var", () => {
    expect(rules("the key is model-key-value-123456 ok", env)).toContain("env_secret");
    expect(rules("token admin-token-value-555", env)).toContain("env_secret");
  });
  it("flags the value as a substring of a larger token (prefix/suffix attached)", () => {
    expect(rules("key:model-key-value-123456.", env)).toContain("env_secret");
    expect(rules("JEB_MODEL_API_KEY=model-key-value-123456", env)).toContain("env_secret");
  });
  it("flags the value split by zero-width characters", () => {
    expect(rules("model-key-value-​123456", env)).toContain("env_secret");
  });
  it("flags a contiguous >=16-char fragment of the value (partial output)", () => {
    const frag = env.JEB_MODEL_API_KEY.slice(0, ENV_SECRET_PARTIAL_MIN_LEN);
    expect(rules(`starts with ${frag}`, env)).toContain("env_secret");
    expect(rules(`starts with ${frag}`, env).length).toBeGreaterThan(0);
  });
  it("does not flag fragments shorter than the partial threshold", () => {
    const frag = env.JEB_MODEL_API_KEY.slice(0, ENV_SECRET_PARTIAL_MIN_LEN - 1);
    expect(scanForSecrets(`starts with ${frag}`, { env }).clean).toBe(true);
  });
  it("flags the signup token under its own rule", () => {
    expect(rules("signup-token-value-987", env)).toContain("signup_token");
  });
  it("ignores values that are not configured", () => {
    expect(scanForSecrets("unrelated-token-654321", { env }).clean).toBe(true);
  });
  it("flags a different value sharing a >=16-char prefix (that prefix IS leaked key material)", () => {
    expect(rules("model-key-value-654321", env)).toContain("env_secret");
  });
  it("ignores env values shorter than the minimum", () => {
    expect(scanForSecrets("short", { env: { ADMIN_TOKEN: "short" } }).clean).toBe(true);
  });
});

describe("env_assignment rule", () => {
  it("flags ENV_NAME=value and ENV_NAME: value forms", () => {
    expect(rules("JEB_MODEL_API_KEY=whatever-value")).toContain("env_assignment");
    expect(rules("DATABASE_URL: postgres://x")).toContain("env_assignment");
    expect(rules("PUBKY_BOT_SECRET_KEY_HEX=abcd")).toContain("env_assignment");
  });
  it("ignores bare env names without a value", () => {
    expect(scanForSecrets("set JEB_MODEL_API_KEY before starting the bot", { env: {} }).clean).toBe(true);
  });
});

describe("redactSecrets", () => {
  it("replaces mnemonic spans including interleaved fillers", () => {
    const words = MNEMONIC.split(" ");
    const interleaved = words.map((w, i) => (i % 3 === 2 ? `${w} frobnicate` : w)).join(" ");
    const { text, hits } = redactSecrets(`x ${interleaved} y`, { env: {} });
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
  it("replaces the configured key in base64 form", () => {
    const { text, hits } = redactSecrets("k n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg= x", { env: KEY_ENV });
    expect(text).not.toContain("n4bQgYhMfWWaL");
    expect(hits.map((h) => h.rule)).toContain("key_material");
  });
  it("normalizes zero-width characters out of the returned text", () => {
    const { text, hits } = redactSecrets("plain ​text", { env: {} });
    expect(text).toBe("plain text");
    expect(hits).toEqual([]);
  });
  it("returns the input untouched when clean", () => {
    const { text, hits } = redactSecrets("nothing sensitive here", { env: {} });
    expect(text).toBe("nothing sensitive here");
    expect(hits).toEqual([]);
  });
});

describe("assertNoSecrets", () => {
  it("throws with rule ids only", () => {
    expect(() => assertNoSecrets(`k ${HEX}`, { env: KEY_ENV })).toThrowError(/key_material|env_secret/);
    expect(() => assertNoSecrets(`k ${HEX}`, { env: KEY_ENV })).toThrowError(/^((?!9f86d081).)*$/s);
  });
  it("passes clean text and the deterministic decline itself", () => {
    expect(() => assertNoSecrets("a normal reply about pubky", { env: {} })).not.toThrow();
    expect(() => assertNoSecrets(SECRET_DECLINE_REPLY, { env: {} })).not.toThrow();
  });
});
