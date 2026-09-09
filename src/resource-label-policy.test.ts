import { describe, expect, it } from "vitest";
import { isAllowedResourceLabel } from "./resource-label-policy.js";

describe("resource label policy", () => {
  it("rejects source-name filler while keeping bitcoin-accepted", () => {
    expect(isAllowedResourceLabel("openstreetmap")).toBe(false);
    expect(isAllowedResourceLabel("btcmap")).toBe(false);
    expect(isAllowedResourceLabel("btc-map")).toBe(false);
    expect(isAllowedResourceLabel("osm")).toBe(false);
    expect(isAllowedResourceLabel("bitcoin-accepted")).toBe(true);
  });
});
