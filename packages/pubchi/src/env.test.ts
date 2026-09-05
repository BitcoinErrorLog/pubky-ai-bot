import { afterEach, describe, expect, it } from "vitest";
import { assertPubchiBindAllowed, isLoopbackBind, parsePubchiPort, pubchiBind } from "./env.js";

afterEach(() => {
  delete process.env.PUBCHI_BIND_DANGEROUS;
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
