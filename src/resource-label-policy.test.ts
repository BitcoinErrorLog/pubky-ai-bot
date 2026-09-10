import { describe, expect, it } from "vitest";
import { isAllowedResourceLabel } from "./resource-label-policy.js";

describe("resource label policy", () => {
  it("rejects post form and sharing fillers", () => {
    for (const label of ["shared-link", "x-post", "video-link", "link", "post", "repost", "shared"]) {
      expect(isAllowedResourceLabel(label)).toBe(false);
    }
    expect(isAllowedResourceLabel("bitcoin")).toBe(true);
  });

  it("rejects source-name filler while keeping bitcoin-accepted", () => {
    expect(isAllowedResourceLabel("openstreetmap")).toBe(false);
    expect(isAllowedResourceLabel("btcmap")).toBe(false);
    expect(isAllowedResourceLabel("btc-map")).toBe(false);
    expect(isAllowedResourceLabel("osm")).toBe(false);
    expect(isAllowedResourceLabel("bitcoin-accepted")).toBe(true);
  });

  it("rejects prototype-key labels", () => {
    for (const label of ["constructor", "prototype", "__proto__", "hasownproperty", "tostring", "valueof"]) {
      expect(isAllowedResourceLabel(label)).toBe(false);
    }
  });

  it("rejects credential and hash-shaped labels", () => {
    for (const label of [
      "akiaiosfodnn7example",
      "akia-iosf-odnn-7exa-mple",
      "eyJhbGciOiJIUzI1NiJ9.payload.signature",
      "sk_live_1234567890",
      "sk_test_1234567890",
      "ghp_1234567890",
      "gho_1234567890",
      "xoxb-1234567890",
      "0123456789abcdef0123456789abcdef",
      "0123456789abcdef012345678",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0x0123456789abcde",
    ]) {
      expect(isAllowedResourceLabel(label)).toBe(false);
    }
    for (const label of [
      "sha256", "bip340", "x86-64", "ed25519", "secp256k1", "ripemd160",
      "bech32m", "ln-url", "nip-05", "bolt12", "utxo", "bip-0340", "rfc-6979", "ecdsa-p256",
    ]) {
      expect(isAllowedResourceLabel(label)).toBe(true);
    }
    expect(isAllowedResourceLabel("AKIA-IOSF-ODNN-7EXA-MPLE")).toBe(false);
  });
});
