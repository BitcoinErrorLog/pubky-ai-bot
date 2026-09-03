import { describe, expect, it } from "vitest";
import {
  authorBlocked,
  botRepliesInChain,
  declaredAutomation,
  replierIsAutomated,
  threadCapped,
  userHourCapped,
} from "./policy.js";

describe("policy", () => {
  it("skips self and blocklist", () => {
    expect(authorBlocked("bot", "bot", new Set())).toBe("self");
    expect(authorBlocked("evil", "bot", new Set(["evil"]))).toBe("blocklist");
    expect(authorBlocked("ok", "bot", new Set())).toBeNull();
  });

  it("enforces thread cap and hourly user cap", () => {
    expect(threadCapped(1, 1)).toBe(true);
    expect(threadCapped(0, 1)).toBe(false);
    expect(userHourCapped(5, 5)).toBe(true);
    expect(userHourCapped(4, 5)).toBe(false);
  });

  it("counts bot-authored posts in the ancestor chain (F4 / F-03)", () => {
    const bot = "b".repeat(52);
    expect(botRepliesInChain([{ author: bot }, { author: "u" }, { author: bot }], bot)).toBe(2);
    expect(threadCapped(botRepliesInChain([{ author: bot }], bot), 1)).toBe(true);
  });

  it("detects profiles that declare automation", () => {
    expect(declaredAutomation({ name: "Feed Bot", bio: null })).toBe(true);
    expect(declaredAutomation({ name: "n", bio: "I am an automated account run by Example" })).toBe(true);
    expect(declaredAutomation({ name: "n", bio: "auto-poster of links" })).toBe(true);
    expect(declaredAutomation({ name: "Alice", bio: "human, mostly" })).toBe(false);
    expect(declaredAutomation(null)).toBe(false);
    // A display name containing "Bot" without a word boundary is not a declaration.
    expect(declaredAutomation({ name: "OtherBot", bio: "" })).toBe(false);
  });

  it("flags repliers via JEB_KNOWN_BOTS or declared automation", () => {
    const known = new Set(["k".repeat(52)]);
    expect(replierIsAutomated("k".repeat(52), null, known)).toBe(true);
    expect(replierIsAutomated("u".repeat(52), { name: "Relay bot", bio: null }, new Set())).toBe(true);
    expect(replierIsAutomated("u".repeat(52), { name: "Uma", bio: null }, known)).toBe(false);
    expect(replierIsAutomated("u".repeat(52), null, undefined)).toBe(false);
  });
});
