import { afterEach, describe, expect, it } from "vitest";
import {
  assertPubchiBindAllowed,
  corsHeadersForOrigin,
  isLoopbackBind,
  ownerBudgetKey,
  parseAllowedOrigins,
  parsePubchiPort,
  pubchiBind,
  scoutMentionKey,
} from "./env.js";

afterEach(() => {
  delete process.env.PUBCHI_BIND_DANGEROUS;
  delete process.env.PUBCHI_ALLOWED_ORIGINS;
});

describe("bind validation", () => {
  it("defaults to loopback and accepts only IP literals", () => {
    expect(pubchiBind(undefined)).toBe("127.0.0.1");
    expect(pubchiBind("")).toBe("127.0.0.1");
    expect(pubchiBind("::1")).toBe("::1");
    expect(isLoopbackBind("127.0.0.1")).toBe(true);
    expect(isLoopbackBind("8.8.8.8")).toBe(false);
    expect(() => pubchiBind("localhost")).toThrow(/invalid PUBCHI_BIND/);
  });

  it("refuses a non-loopback bind without PUBCHI_BIND_DANGEROUS", () => {
    expect(() => assertPubchiBindAllowed("8.8.8.8")).toThrow(/PUBCHI_BIND_DANGEROUS/);
  });

  it("allows a non-loopback bind when PUBCHI_BIND_DANGEROUS=1", () => {
    process.env.PUBCHI_BIND_DANGEROUS = "1";
    expect(() => assertPubchiBindAllowed("8.8.8.8")).not.toThrow();
  });

  it("parses PUBCHI_PORT", () => {
    expect(parsePubchiPort(undefined)).toBe(3015);
    expect(parsePubchiPort("4010")).toBe(4010);
    expect(() => parsePubchiPort("nope")).toThrow(/invalid PUBCHI_PORT/);
  });
});

describe("owner budget key", () => {
  it("keys by owner only, ignoring bot", () => {
    expect(ownerBudgetKey("owner1")).toBe("pubchi:owner1");
    expect(scoutMentionKey("bot-a", "owner1")).toBe("pubchi:owner1");
    expect(scoutMentionKey("bot-b", "owner1")).toBe(scoutMentionKey("bot-a", "owner1"));
  });
});

describe("PUBCHI_ALLOWED_ORIGINS", () => {
  it("empty env → no origins", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins("  ")).toEqual([]);
    expect(corsHeadersForOrigin("http://localhost:3001", [])).toBeNull();
  });

  it("allowed origin gets ACAO + Vary; unknown origin gets none", () => {
    const allowed = parseAllowedOrigins("http://localhost:3001, http://127.0.0.1:3001");
    expect(corsHeadersForOrigin("http://localhost:3001", allowed)).toEqual({
      "Access-Control-Allow-Origin": "http://localhost:3001",
      Vary: "Origin",
    });
    expect(corsHeadersForOrigin("https://evil.example", allowed)).toBeNull();
    expect(corsHeadersForOrigin("*", allowed)).toBeNull();
    expect(corsHeadersForOrigin("http://localhost:3001", ["http://localhost:3001"])).not.toHaveProperty(
      "Access-Control-Allow-Credentials",
    );
  });
});
