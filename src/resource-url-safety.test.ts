import { domainToASCII } from "node:url";
import { describe, expect, it } from "vitest";
import { httpUrlRejectReason } from "./resource-url-safety.js";

describe("httpUrlRejectReason production host (incl. IDN)", () => {
  it("rejects ASCII pubky.app hosts", () => {
    expect(httpUrlRejectReason("https://pubky.app/x")).toBe("production target is not allowed");
    expect(httpUrlRejectReason("https://nexus.pubky.app/x")).toBe("production target is not allowed");
  });

  it("rejects a punycode hostname whose unicode form ends in pubky.app", () => {
    const ascii = domainToASCII("рubky.app");
    expect(ascii.startsWith("xn--")).toBe(true);
    expect(ascii).toBe("xn--ubky-f6d.app");
    expect(httpUrlRejectReason(`https://${ascii}/x`)).toBe("production target is not allowed");
  });

  it("does not treat an unrelated IDN as pubky.app", () => {
    expect(httpUrlRejectReason("https://xn--80ak6aa92e.com/")).toBeNull();
  });
});
