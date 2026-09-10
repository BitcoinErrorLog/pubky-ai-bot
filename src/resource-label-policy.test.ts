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
      "0123456789abcdef0123456789abcdef",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0x0123456789abcdef",
    ]) {
      expect(isAllowedResourceLabel(label)).toBe(false);
    }
    for (const label of ["sha256", "bip340", "x86-64", "ed25519"]) {
      expect(isAllowedResourceLabel(label)).toBe(true);
    }
  });
});
