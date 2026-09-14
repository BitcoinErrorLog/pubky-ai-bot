import { describe, expect, it } from "vitest";
import { delegationPath } from "./delegation.js";
import { ALLOWLISTED_PATH_PATTERNS, PATHS, feedDefinitionPath, isAllowlistedPath, ownerBindingPath } from "./paths.js";

describe("Pubchi v1 namespace", () => {
  it("keeps the allowlist patterns in lockstep with the contract builders", () => {
    expect(ALLOWLISTED_PATH_PATTERNS).toEqual([
      "/pub/app.pubchi/v1/manifest.json",
      "/pub/app.pubchi/v1/bot.json",
      "/pub/app.pubchi/v1/config.json",
      "/pub/app.pubchi/v1/interests.json",
      "/pub/app.pubchi/v1/formats.json",
      "/pub/app.pubchi/v1/feeds/<feed-id>.json",
      "/pub/app.pubchi/v1/follower-snapshots/<unix-seconds>.json",
      "/pub/app.pubchi/v1/cursors/what-i-missed.json",
      "/pub/app.pubchi/v1/requests/<request-id>.json",
      "/pub/app.pubchi/v1/suggestions/<suggestion-id>.json",
      "/pub/app.pubchi/v1/runs/<run-id>.json",
      "/pub/app.pubchi/v1/bots/<bot>.json",
      "/pub/app.pubchi/v1/devices/<device>.json",
    ]);
  });

  it("allowlists only the app.pubchi v1 paths", () => {
    expect(isAllowlistedPath(PATHS.config)).toBe(true);
    expect(isAllowlistedPath(feedDefinitionPath("feed-1"))).toBe(true);
    expect(isAllowlistedPath(ownerBindingPath("bot-1"))).toBe(true);
    expect(isAllowlistedPath("/pub/app.pubchi/v1/devices/device-1.json")).toBe(true);
    expect(isAllowlistedPath(delegationPath("a"))).toBe(true);
    expect(isAllowlistedPath("/pub/app.pubchi/v1/bots/bad.id.json")).toBe(false);
    expect(isAllowlistedPath("/pub/app.pubchi/v1/devices/bad.id.json")).toBe(false);
    const oldNamespace = ["pubchi", "app"].join(".");
    expect(isAllowlistedPath(`/pub/${oldNamespace}/config.json`)).toBe(false);
    expect(isAllowlistedPath(`/pub/${oldNamespace}/v1/config.json`)).toBe(false);
  });
});
