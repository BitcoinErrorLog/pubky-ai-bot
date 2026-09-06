import { describe, expect, it } from "vitest";
import { clientAddress, parseTrustProxy } from "./env.js";
import { memoryPreauthLimiter } from "./preauth.js";

describe("preauth limiter", () => {
  it("global and per-address buckets reject after burst", () => {
    const limiter = memoryPreauthLimiter({ globalRps: 1, globalBurst: 2, ipRps: 1, ipBurst: 10 });
    expect(limiter.take("1.1.1.1")).toBe(true);
    expect(limiter.take("1.1.1.1")).toBe(true);
    expect(limiter.take("1.1.1.1")).toBe(false);
  });

  it("per-address burst is independent until the global burst is gone", () => {
    const limiter = memoryPreauthLimiter({ globalRps: 100, globalBurst: 100, ipRps: 1, ipBurst: 1 });
    expect(limiter.take("10.0.0.1")).toBe(true);
    expect(limiter.take("10.0.0.1")).toBe(false);
    expect(limiter.take("10.0.0.2")).toBe(true);
  });
});

describe("X-Forwarded-For trust", () => {
  it("ignores X-Forwarded-For unless PUBCHI_TRUST_PROXY=1", () => {
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("1")).toBe(true);
    expect(
      clientAddress({ remoteAddress: "127.0.0.1", forwardedFor: "8.8.8.8", trustProxy: false }),
    ).toBe("127.0.0.1");
    expect(
      clientAddress({ remoteAddress: "127.0.0.1", forwardedFor: "8.8.8.8, 1.1.1.1", trustProxy: true }),
    ).toBe("8.8.8.8");
  });
});
