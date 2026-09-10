import { domainToASCII } from "node:url";
import { describe, expect, it } from "vitest";
import { preflightResourceUrl } from "./resource-fetch.js";
import { httpUrlRejectReason } from "./resource-url-safety.js";

const blockedAddresses = [
  "0.0.0.1",
  "192.0.0.1",
  "192.0.2.1",
  "198.18.0.1",
  "198.19.255.254",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "239.255.255.255",
  "240.0.0.1",
  "255.255.255.255",
  "ff02::1",
  "2001:db8::1",
  "::1",
  "::",
  "fe80::1",
  "fec0::1",
  "fc00::1",
  "::ffff:127.0.0.1",
  "::127.0.0.1",
  "64:ff9b::127.0.0.1",
] as const;

const publicAddresses = ["93.184.216.34", "2606:4700::1111", "1.1.1.1"] as const;
const pubkyToken = "y".repeat(52);

function addressUrl(address: string): string {
  return `https://${address.includes(":") ? `[${address}]` : address}/`;
}

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

  it.each(blockedAddresses)("rejects blocked literal address %s", (address) => {
    expect(httpUrlRejectReason(addressUrl(address))).toBe("private or loopback host is not allowed");
  });

  it.each(blockedAddresses)("rejects blocked DNS answer %s", async (address) => {
    const family = address.includes(":") ? 6 as const : 4 as const;
    await expect(preflightResourceUrl("https://example.test/", async () => [{ address, family }])).resolves.toBe("private_host");
  });

  it.each(publicAddresses)("allows public literal address %s", (address) => {
    expect(httpUrlRejectReason(addressUrl(address))).toBe(address.includes(".") || address.includes(":") ? "ip-literal-host" : null);
  });

  it.each(publicAddresses)("allows public DNS answer %s", async (address) => {
    const family = address.includes(":") ? 6 as const : 4 as const;
    await expect(preflightResourceUrl("https://example.test/", async () => [{ address, family }])).resolves.toBeNull();
  });

  it("rejects public IP literals and non-default ports", () => {
    expect(httpUrlRejectReason("https://1.1.1.1/")).toBe("ip-literal-host");
    expect(httpUrlRejectReason("https://[2606:4700::1111]/")).toBe("ip-literal-host");
    expect(httpUrlRejectReason("https://example.com:8443/")).toBe("non-default-port");
  });

  it("rejects onion hosts and allows a normal HTTPS host", () => {
    expect(httpUrlRejectReason("https://example.onion/")).toBe("onion-host");
    expect(httpUrlRejectReason("https://example.com/")).toBeNull();
    expect(httpUrlRejectReason("https://example.com:443/")).toBeNull();
  });

  it("rejects HTTPS homeserver gateway URLs containing Pubky identities", () => {
    expect(httpUrlRejectReason(`https://${pubkyToken}.homeserver.example/pub/pubky.app/posts/x`)).toBe("pubky-url");
    expect(httpUrlRejectReason(`https://gateway.example/${pubkyToken}/pub/pubky.app/posts/x`)).toBe("pubky-url");
    expect(httpUrlRejectReason("https://example.com/pub/docs/readme")).toBeNull();
    expect(httpUrlRejectReason(`https://${"l".repeat(52)}.homeserver.example/pub/pubky.app/posts/x`)).toBeNull();
  });
});
